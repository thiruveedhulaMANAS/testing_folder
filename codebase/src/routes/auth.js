const express = require('express');
const bcrypt = require('bcrypt');
const { query, withTransaction } = require('../config/db');
const { signToken, requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../middleware/error');
const { writeAudit } = require('../services/audit');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Accepts optional leading +, digits, spaces, dashes, dots, and parentheses;
// requires at least 7 digits so short/garbage input is rejected.
const PHONE_RE = /^\+?[0-9()\-.\s]{7,20}$/;

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const fullName = String(req.body?.fullName || '').trim();
    const phoneNumber = String(req.body?.phoneNumber || '').trim();
    const phoneDigits = phoneNumber.replace(/\D/g, '');

    if (!EMAIL_RE.test(email) || password.length < 8 || fullName.length < 2) {
      throw new HttpError(400, 'Valid email, full name, and password (8+ chars) are required');
    }
    if (!PHONE_RE.test(phoneNumber) || phoneDigits.length < 7) {
      throw new HttpError(400, 'A valid phone number is required');
    }

    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rowCount) {
      throw new HttpError(409, 'Email is already registered');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO users (email, password_hash, full_name, phone_number)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, full_name, phone_number, created_at`,
        [email, passwordHash, fullName, phoneNumber]
      );
      const row = inserted.rows[0];
      await client.query('INSERT INTO carts (user_id) VALUES ($1)', [row.id]);
      await writeAudit(client, {
        userId: row.id,
        eventName: 'USER_REGISTER',
        payload: { email: row.email, phoneNumber: row.phone_number }
      });
      return row;
    });

    const token = signToken(user);
    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, fullName: user.full_name, phoneNumber: user.phone_number }
    });
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const result = await query(
      'SELECT id, email, full_name, phone_number, password_hash, role FROM users WHERE email = $1',
      [email]
    );
    const user = result.rows[0];
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      throw new HttpError(401, 'Invalid email or password');
    }

    await writeAudit(null, {
      userId: user.id,
      eventName: 'LOGIN',
      payload: { email: user.email, role: user.role }
    });

    res.json({
      token: signToken(user),
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        phoneNumber: user.phone_number,
        role: user.role
      }
    });
  })
);

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await query(
      'SELECT id, email, full_name, phone_number, created_at, role FROM users WHERE id = $1',
      [req.user.id]
    );
    const user = result.rows[0];
    if (!user) throw new HttpError(401, 'User not found');
    res.json({
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      phoneNumber: user.phone_number,
      createdAt: user.created_at,
      role: user.role
    });
  })
);

/**
 * Lets any authenticated user rotate their own password.
 */
router.post(
  '/change-password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');

    if (newPassword.length < 8) {
      throw new HttpError(400, 'New password must be at least 8 characters');
    }

    const result = await query('SELECT id, password_hash FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) throw new HttpError(401, 'User not found');

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) {
      throw new HttpError(401, 'Current password is incorrect');
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);

    await writeAudit(null, {
      userId: user.id,
      eventName: 'PASSWORD_CHANGED',
      payload: {}
    });

    res.json({ ok: true });
  })
);

module.exports = router;
