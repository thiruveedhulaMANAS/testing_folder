const env = require('../config/env');
const { withTransaction } = require('../config/db');
const { HttpError } = require('../middleware/error');
const { writeAudit } = require('./audit');
const { getOrCreateCart } = require('./cart');
const { money } = require('./products');

async function checkout(userId) {
  return withTransaction(async (client) => {
    const cartId = await getOrCreateCart(userId, client);
    const { rows: items } = await client.query(
      `SELECT ci.product_id, ci.quantity, p.name, p.price, p.sale_price, p.stock
       FROM cart_items ci
       JOIN products p ON p.id = ci.product_id
       WHERE ci.cart_id = $1
       FOR UPDATE OF p, ci`,
      [cartId]
    );

    if (items.length === 0) {
      throw new HttpError(400, 'Cart is empty');
    }

    const lines = [];
    let subtotal = 0;

    for (const item of items) {
      if (item.stock < item.quantity) {
        throw new HttpError(
          409,
          `Insufficient stock for ${item.name}`,
          { productId: item.product_id, available: item.stock, requested: item.quantity }
        );
      }
      const unit = Number(item.sale_price != null ? item.sale_price : item.price);
      const lineTotal = unit * item.quantity;
      subtotal += lineTotal;
      lines.push({
        productId: item.product_id,
        name: item.name,
        unitPrice: unit,
        quantity: item.quantity,
        lineTotal
      });
    }

    const tax = Number((subtotal * env.taxRate).toFixed(2));
    const total = Number((subtotal + tax).toFixed(2));

    const orderRes = await client.query(
      `INSERT INTO orders (user_id, status, subtotal, tax, total)
       VALUES ($1, 'completed', $2, $3, $4)
       RETURNING id, status, subtotal, tax, total, created_at`,
      [userId, money(subtotal), money(tax), money(total)]
    );
    const order = orderRes.rows[0];

    for (const line of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [order.id, line.productId, line.name, money(line.unitPrice), line.quantity, money(line.lineTotal)]
      );
      await client.query(
        `UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1`,
        [line.quantity, line.productId]
      );
    }

    await client.query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);
    await client.query(
      `UPDATE carts SET updated_at = (NOW() AT TIME ZONE 'utc') WHERE id = $1`,
      [cartId]
    );

    await writeAudit(client, {
      userId,
      eventName: 'PURCHASE_COMPLETED',
      payload: {
        orderId: order.id,
        itemCount: lines.length,
        subtotal: money(subtotal),
        tax: money(tax),
        total: money(total),
        items: lines.map((line) => ({
          productId: line.productId,
          quantity: line.quantity,
          unitPrice: money(line.unitPrice)
        }))
      }
    });

    return {
      id: order.id,
      status: order.status,
      subtotal: money(order.subtotal),
      tax: money(order.tax),
      total: money(order.total),
      createdAt: order.created_at,
      items: lines.map((line) => ({
        productId: line.productId,
        name: line.name,
        quantity: line.quantity,
        unitPrice: money(line.unitPrice),
        lineTotal: money(line.lineTotal)
      }))
    };
  });
}

module.exports = { checkout };
