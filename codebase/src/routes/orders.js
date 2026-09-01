const express = require('express');
const { query } = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../middleware/error');
const { money } = require('../services/products');

const router = express.Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT id, status, subtotal, tax, total, created_at
       FROM orders
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(
      rows.map((row) => ({
        id: row.id,
        status: row.status,
        subtotal: money(row.subtotal),
        tax: money(row.tax),
        total: money(row.total),
        createdAt: row.created_at
      }))
    );
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const orderRes = await query(
      `SELECT id, status, subtotal, tax, total, created_at
       FROM orders WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.id]
    );
    const order = orderRes.rows[0];
    if (!order) throw new HttpError(404, 'Order not found');

    const items = await query(
      `SELECT product_id, product_name, unit_price, quantity, line_total
       FROM order_items WHERE order_id = $1 ORDER BY id`,
      [order.id]
    );

    res.json({
      id: order.id,
      status: order.status,
      subtotal: money(order.subtotal),
      tax: money(order.tax),
      total: money(order.total),
      createdAt: order.created_at,
      items: items.rows.map((item) => ({
        productId: item.product_id,
        name: item.product_name,
        unitPrice: money(item.unit_price),
        quantity: item.quantity,
        lineTotal: money(item.line_total)
      }))
    });
  })
);

module.exports = router;
