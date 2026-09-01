const express = require('express');
const { query } = require('../../config/db');
const { asyncHandler, HttpError } = require('../../middleware/error');

const router = express.Router();

const MAX_PAGE_SIZE = 100;

/**
 * GET /api/admin/users
 * Query params:
 *   q        - matched against email and full_name (case-insensitive, substring)
 *   role     - 'user' | 'admin'
 *   page     - 1-based, default 1
 *   pageSize - default 20, capped at MAX_PAGE_SIZE
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
    const offset = (page - 1) * pageSize;

    const q = String(req.query.q || '').trim();
    const role = String(req.query.role || '').trim();
    if (role && !['user', 'admin'].includes(role)) {
      throw new HttpError(400, "role filter must be 'user' or 'admin'");
    }

    const conditions = [];
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(u.email ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`);
    }
    if (role) {
      params.push(role);
      conditions.push(`u.role = $${params.length}::user_role`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(`SELECT COUNT(*)::int AS total FROM users u ${whereClause}`, params);
    const total = countResult.rows[0].total;

    params.push(pageSize, offset);
    const rows = await query(
      `SELECT
         u.id, u.email, u.full_name, u.phone_number, u.role, u.created_at,
         COUNT(o.id)::int AS total_orders
       FROM users u
       LEFT JOIN orders o ON o.user_id = u.id
       ${whereClause}
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: rows.rows.map((row) => ({
        id: row.id,
        fullName: row.full_name,
        email: row.email,
        phone: row.phone_number,
        role: row.role,
        createdAt: row.created_at,
        totalOrders: row.total_orders
      })),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize) || 1
    });
  })
);

/**
 * PATCH /api/admin/users/:id/role
 * Promote/demote a user. Deliberately the only admin-editable field on a
 * user record here -- password, email, etc. stay off-limits to this panel.
 */
router.patch(
  '/:id/role',
  asyncHandler(async (req, res) => {
    const role = String(req.body?.role || '');
    if (!['user', 'admin'].includes(role)) {
      throw new HttpError(400, "role must be 'user' or 'admin'");
    }
    if (req.params.id === req.user.id && role !== 'admin') {
      throw new HttpError(400, 'You cannot remove your own admin role');
    }

    const result = await query(
      `UPDATE users SET role = $1::user_role WHERE id = $2
       RETURNING id, email, full_name, phone_number, role, created_at`,
      [role, req.params.id]
    );
    const user = result.rows[0];
    if (!user) throw new HttpError(404, 'User not found');

    res.json({
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      phone: user.phone_number,
      role: user.role,
      createdAt: user.created_at
    });
  })
);

module.exports = router;
