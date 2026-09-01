const { query } = require('../config/db');

async function getOrCreateCart(userId, db) {
  const executor = db || { query };
  const existing = await executor.query(
    'SELECT id FROM carts WHERE user_id = $1',
    [userId]
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await executor.query(
    'INSERT INTO carts (user_id) VALUES ($1) RETURNING id',
    [userId]
  );
  return created.rows[0].id;
}

async function loadCart(userId) {
  const cartId = await getOrCreateCart(userId);
  const { rows } = await query(
    `SELECT
       ci.product_id,
       ci.quantity,
       p.name,
       p.sku,
       p.price,
       p.sale_price,
       p.stock,
       p.image_url
     FROM cart_items ci
     JOIN products p ON p.id = ci.product_id
     WHERE ci.cart_id = $1
     ORDER BY ci.id`,
    [cartId]
  );

  const items = rows.map((row) => {
    const unit = row.sale_price != null ? row.sale_price : row.price;
    const unitPrice = Number.parseFloat(unit).toFixed(2);
    const lineTotal = (Number(unit) * row.quantity).toFixed(2);
    return {
      productId: row.product_id,
      sku: row.sku,
      name: row.name,
      quantity: row.quantity,
      unitPrice,
      lineTotal,
      stock: row.stock,
      imageUrl: row.image_url
    };
  });

  const subtotal = items
    .reduce((sum, item) => sum + Number(item.lineTotal), 0)
    .toFixed(2);

  return { cartId, items, subtotal };
}

module.exports = { getOrCreateCart, loadCart };
