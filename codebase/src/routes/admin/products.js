const express = require('express');
const { query } = require('../../config/db');
const { asyncHandler, HttpError } = require('../../middleware/error');
const { money } = require('../../services/products');
const { invalidatePrefix } = require('../../services/cache');

const router = express.Router();

const MAX_PAGE_SIZE = 100;
const LOW_STOCK_THRESHOLD = 10;

function toAdminProduct(row) {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: { id: row.category_id, name: row.category_name },
    price: money(row.price),
    salePrice: row.sale_price == null ? null : money(row.sale_price),
    stock: row.stock,
    lowStock: row.stock < LOW_STOCK_THRESHOLD,
    imageUrl: row.image_url,
    isActive: row.is_active,
    updatedAt: row.updated_at
  };
}

router.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    const result = await query('SELECT id, slug, name FROM categories ORDER BY name');
    res.json(result.rows);
  })
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(req.query.pageSize, 10) || 20));
    const offset = (page - 1) * pageSize;
    const q = String(req.query.q || '').trim();

    const conditions = [];
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(p.name ILIKE $${params.length} OR p.sku ILIKE $${params.length})`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(`SELECT COUNT(*)::int AS total FROM products p ${whereClause}`, params);
    const total = countResult.rows[0].total;

    params.push(pageSize, offset);
    const rows = await query(
      `SELECT p.id, p.sku, p.name, p.price, p.sale_price, p.stock, p.image_url,
              p.is_active, p.category_id, c.name AS category_name, p.updated_at
       FROM products p
       JOIN categories c ON c.id = p.category_id
       ${whereClause}
       ORDER BY p.name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: rows.rows.map(toAdminProduct),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize) || 1
    });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { sku, name, description, categoryId, price, salePrice, stock, imageUrl } = req.body || {};

    if (!sku || !name || !description || !categoryId || price == null) {
      throw new HttpError(400, 'sku, name, description, categoryId, and price are required');
    }
    const priceNum = Number(price);
    const stockNum = Number.isFinite(Number(stock)) ? Number(stock) : 0;
    if (!Number.isFinite(priceNum) || priceNum < 0) throw new HttpError(400, 'price must be a non-negative number');
    if (stockNum < 0) throw new HttpError(400, 'stock must be a non-negative number');

    const category = await query('SELECT id FROM categories WHERE id = $1', [categoryNum(categoryId)]);
    if (!category.rowCount) throw new HttpError(400, 'categoryId does not exist');

    const catId = categoryNum(categoryId);
    const result = await query(
      `INSERT INTO products (category_id, sku, name, description, price, sale_price, stock, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, sku, name, price, sale_price, stock, image_url, is_active, category_id, updated_at,
                 (SELECT name FROM categories c WHERE c.id = $1) AS category_name`,
      [catId, String(sku).trim(), String(name).trim(), String(description), priceNum, salePrice ?? null, stockNum, imageUrl ?? null]
    );
    await invalidatePrefix('categories');
    await invalidatePrefix('products');

    res.status(201).json(toAdminProduct(result.rows[0]));
  })
);

/**
 * PATCH /api/admin/products/:id
 * Partial update -- price, salePrice, stock, name, imageUrl, isActive.
 * This is the endpoint behind the "update stock/price" modal.
 */
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Invalid product id');

    const fields = [];
    const params = [];
    const { name, price, salePrice, stock, imageUrl, isActive } = req.body || {};

    if (name !== undefined) {
      params.push(String(name).trim());
      fields.push(`name = $${params.length}`);
    }
    if (price !== undefined) {
      const priceNum = Number(price);
      if (!Number.isFinite(priceNum) || priceNum < 0) throw new HttpError(400, 'price must be a non-negative number');
      params.push(priceNum);
      fields.push(`price = $${params.length}`);
    }
    if (salePrice !== undefined) {
      params.push(salePrice === null ? null : Number(salePrice));
      fields.push(`sale_price = $${params.length}`);
    }
    if (stock !== undefined) {
      const stockNum = Number(stock);
      if (!Number.isInteger(stockNum) || stockNum < 0) throw new HttpError(400, 'stock must be a non-negative integer');
      params.push(stockNum);
      fields.push(`stock = $${params.length}`);
    }
    if (imageUrl !== undefined) {
      params.push(imageUrl);
      fields.push(`image_url = $${params.length}`);
    }
    if (isActive !== undefined) {
      params.push(Boolean(isActive));
      fields.push(`is_active = $${params.length}`);
    }

    if (!fields.length) throw new HttpError(400, 'No updatable fields provided');

    params.push(id);
    const result = await query(
      `UPDATE products SET ${fields.join(', ')} WHERE id = $${params.length}
       RETURNING id, sku, name, price, sale_price, stock, image_url, is_active, category_id, updated_at,
                 (SELECT name FROM categories c WHERE c.id = products.category_id) AS category_name`,
      params
    );
    const row = result.rows[0];
    if (!row) throw new HttpError(404, 'Product not found');

    await invalidatePrefix('products');
    res.json(toAdminProduct(row));
  })
);

/**
 * DELETE /api/admin/products/:id
 * Soft delete (is_active = false) rather than a hard DELETE: order_items
 * references product_id ON DELETE RESTRICT, so a hard delete would fail
 * for any product that's ever been ordered, and a hard delete would also
 * destroy the historical record on past orders either way.
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Invalid product id');

    const result = await query('UPDATE products SET is_active = FALSE WHERE id = $1 RETURNING id', [id]);
    if (!result.rowCount) throw new HttpError(404, 'Product not found');

    await invalidatePrefix('products');
    res.json({ ok: true });
  })
);

function categoryNum(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n)) throw new HttpError(400, 'categoryId must be an integer');
  return n;
}

module.exports = router;
