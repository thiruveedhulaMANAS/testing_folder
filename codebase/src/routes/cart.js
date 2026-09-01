const express = require('express');
const { query } = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../middleware/error');
const { writeAudit } = require('../services/audit');
const { getOrCreateCart, loadCart } = require('../services/cart');

const router = express.Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const cart = await loadCart(req.user.id);
    res.json(cart);
  })
);

router.post(
  '/items',
  asyncHandler(async (req, res) => {
    const productId = Number(req.body?.productId);
    const quantity = Number(req.body?.quantity ?? 1);
    if (!Number.isInteger(productId) || productId < 1 || !Number.isInteger(quantity) || quantity < 1) {
      throw new HttpError(400, 'productId and a positive integer quantity are required');
    }

    const product = await query(
      'SELECT id, name, stock, is_active FROM products WHERE id = $1',
      [productId]
    );
    const row = product.rows[0];
    if (!row || !row.is_active) throw new HttpError(404, 'Product not found');

    const cartId = await getOrCreateCart(req.user.id);
    const existing = await query(
      'SELECT quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2',
      [cartId, productId]
    );
    const nextQty = (existing.rows[0]?.quantity || 0) + quantity;
    if (nextQty > row.stock) {
      throw new HttpError(409, 'Not enough stock for the requested quantity', {
        available: row.stock,
        requested: nextQty
      });
    }

    await query(
      `INSERT INTO cart_items (cart_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, product_id)
       DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity`,
      [cartId, productId, quantity]
    );
    await query(
      `UPDATE carts SET updated_at = (NOW() AT TIME ZONE 'utc') WHERE id = $1`,
      [cartId]
    );
    await writeAudit(null, {
      userId: req.user.id,
      eventName: 'ADD_TO_CART',
      payload: { productId, quantity, productName: row.name }
    });

    res.status(201).json(await loadCart(req.user.id));
  })
);

router.patch(
  '/items/:productId',
  asyncHandler(async (req, res) => {
    const productId = Number(req.params.productId);
    const quantity = Number(req.body?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new HttpError(400, 'quantity must be a positive integer');
    }

    const cartId = await getOrCreateCart(req.user.id);
    const stockRes = await query('SELECT stock, name FROM products WHERE id = $1', [productId]);
    if (!stockRes.rows[0]) throw new HttpError(404, 'Product not found');
    if (quantity > stockRes.rows[0].stock) {
      throw new HttpError(409, 'Not enough stock for the requested quantity');
    }

    const updated = await query(
      `UPDATE cart_items SET quantity = $3
       WHERE cart_id = $1 AND product_id = $2
       RETURNING id`,
      [cartId, productId, quantity]
    );
    if (!updated.rowCount) throw new HttpError(404, 'Item is not in the cart');

    await writeAudit(null, {
      userId: req.user.id,
      eventName: 'UPDATE_CART',
      payload: { productId, quantity }
    });
    res.json(await loadCart(req.user.id));
  })
);

router.delete(
  '/items/:productId',
  asyncHandler(async (req, res) => {
    const productId = Number(req.params.productId);
    const cartId = await getOrCreateCart(req.user.id);
    const removed = await query(
      'DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2 RETURNING id',
      [cartId, productId]
    );
    if (!removed.rowCount) throw new HttpError(404, 'Item is not in the cart');
    await writeAudit(null, {
      userId: req.user.id,
      eventName: 'REMOVE_FROM_CART',
      payload: { productId }
    });
    res.json(await loadCart(req.user.id));
  })
);

module.exports = router;
