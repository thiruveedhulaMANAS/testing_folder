const express = require('express');
const { query } = require('../../config/db');
const { asyncHandler, HttpError } = require('../../middleware/error');
const { money } = require('../../services/products');

const router = express.Router();

const MAX_PAGE_SIZE = 100;
// DB stores lowercase ('pending' | 'completed' | 'cancelled'); the admin UI
// spec asks for uppercase status labels (COMPLETED / PENDING / CANCELLED).
const STATUS_DISPLAY = { pending: 'PENDING', completed: 'COMPLETED', cancelled: 'CANCELLED' };

router.get(
  '/kpis',
  asyncHandler(async (_req, res) => {
    const result = await query(
      `SELECT
         COALESCE(SUM(total) FILTER (WHERE status = 'completed'), 0) AS total_revenue,
         COUNT(*) FILTER (WHERE status IN ('pending', 'completed')) AS active_orders,
         COALESCE(AVG(total) FILTER (WHERE status = 'completed'), 0) AS avg_order_value,
         COUNT(*) AS total_orders
       FROM orders`
    );
    const row = result.rows[0];
    res.json({
      totalRevenue: money(row.total_revenue),
      activeOrders: Number(row.active_orders),
      averageOrderValue: money(row.avg_order_value),
      totalOrders: Number(row.total_orders)
    });
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
    const offset = (page - 1) * pageSize;

    const status = String(req.query.status || '').toLowerCase();
    const conditions = [];
    const params = [];
    if (status) {
      if (!['pending', 'completed', 'cancelled'].includes(status)) {
        throw new HttpError(400, 'status must be one of pending, completed, cancelled');
      }
      params.push(status);
      conditions.push(`o.status = $${params.length}`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(`SELECT COUNT(*)::int AS total FROM orders o ${whereClause}`, params);
    const total = countResult.rows[0].total;

    params.push(pageSize, offset);
    const rows = await query(
      `SELECT o.id, o.status, o.total, o.created_at, u.email AS customer_email
       FROM orders o
       JOIN users u ON u.id = o.user_id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: rows.rows.map((row) => ({
        id: row.id,
        customerEmail: row.customer_email,
        totalAmount: money(row.total),
        status: STATUS_DISPLAY[row.status] || row.status.toUpperCase(),
        createdAt: row.created_at
      })),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize) || 1
    });
  })
);

module.exports = router;
