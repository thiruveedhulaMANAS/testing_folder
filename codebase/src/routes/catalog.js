const express = require('express');
const { query } = require('../config/db');
const { asyncHandler, HttpError } = require('../middleware/error');
const { optionalAuth } = require('../middleware/auth');
const { toDisplayProduct, PRODUCT_SELECT } = require('../services/products');
const { trackEvent } = require('../services/audit');
const { withCache, invalidatePrefix } = require('../services/cache');

const router = express.Router();

router.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    const { value: rows } = await withCache('categories', 60, async () => {
      const result = await query(
        `SELECT c.id, c.slug, c.name, c.description, COUNT(p.id)::int AS product_count
         FROM categories c
         LEFT JOIN products p ON p.category_id = c.id AND p.is_active = TRUE
         GROUP BY c.id
         ORDER BY c.name`
      );
      return result.rows;
    });
    res.json(rows);
  })
);

/**
 * Product listing with multi-facet filtering:
 *   - category / category_id  -> facet: category
 *   - min_price / max_price   -> facet: price range
 *   - in_stock=true           -> facet: stock availability
 *   - min_rating              -> facet: ratings
 *   - q                       -> full-text-ish search (trigram similarity
 *                                over name + description, backed by the
 *                                GIN trigram indexes in init.sql)
 */
router.get(
  '/products',
  asyncHandler(async (req, res) => {
    const { category, category_id: categoryId, q, in_stock: inStock } = req.query;
    const minPrice = req.query.min_price;
    const maxPrice = req.query.max_price;
    const minRating = req.query.min_rating;
    const sort = req.query.sort;

    const clauses = ['p.is_active = TRUE'];
    const params = [];
    let similarityExpr = null;

    if (categoryId) {
      params.push(Number(categoryId));
      clauses.push(`p.category_id = $${params.length}`);
    } else if (category) {
      params.push(String(category));
      clauses.push(`c.slug = $${params.length}`);
    }

    if (q && String(q).trim()) {
      const term = String(q).trim();
      params.push(term);
      const paramIdx = params.length;
      // Trigram similarity search across name + description, tolerant of
      // typos/partial matches. Falls back to a plain match if either side
      // has similarity above a low threshold; ILIKE keeps exact substrings
      // working even when trigram similarity is too low (e.g. very short
      // queries like "S24").
      clauses.push(
        `(p.name ILIKE '%' || $${paramIdx} || '%'
          OR p.description ILIKE '%' || $${paramIdx} || '%'
          OR similarity(p.name, $${paramIdx}) > 0.15
          OR similarity(p.description, $${paramIdx}) > 0.15)`
      );
      similarityExpr = `GREATEST(similarity(p.name, $${paramIdx}), similarity(p.description, $${paramIdx}))`;
    }

    if (minPrice != null && minPrice !== '') {
      params.push(Number(minPrice));
      clauses.push(`COALESCE(p.sale_price, p.price) >= $${params.length}`);
    }
    if (maxPrice != null && maxPrice !== '') {
      params.push(Number(maxPrice));
      clauses.push(`COALESCE(p.sale_price, p.price) <= $${params.length}`);
    }
    if (minRating != null && minRating !== '') {
      params.push(Number(minRating));
      clauses.push(`p.rating >= $${params.length}`);
    }
    if (inStock === 'true') {
      clauses.push('p.stock > 0');
    }

    let orderBy = 'p.name ASC';
    if (sort === 'price_asc') orderBy = 'COALESCE(p.sale_price, p.price) ASC';
    else if (sort === 'price_desc') orderBy = 'COALESCE(p.sale_price, p.price) DESC';
    else if (sort === 'rating') orderBy = 'p.rating DESC, p.rating_count DESC';
    else if (similarityExpr) orderBy = `${similarityExpr} DESC, p.name ASC`;

    const { rows } = await query(
      `${PRODUCT_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY ${orderBy}`,
      params
    );
    res.json(rows.map(toDisplayProduct));
  })
);

/**
 * Product detail page. Fires a PRODUCT_VIEW impression event (async, via
 * BullMQ) capturing product_id, category_id, and request metadata. Dwell
 * time is reported separately by the client via POST /api/track/dwell once
 * the shopper navigates away (see src/routes/track.js).
 */
router.get(
  '/products/:id',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const productId = Number(req.params.id);
    if (!Number.isInteger(productId) || productId < 1) {
      throw new HttpError(400, 'Invalid product id');
    }

    const { rows } = await query(
      `${PRODUCT_SELECT} WHERE p.id = $1 AND p.is_active = TRUE`,
      [productId]
    );
    if (!rows[0]) throw new HttpError(404, 'Product not found');

    trackEvent({
      userId: req.user?.id || null,
      eventType: 'PRODUCT_VIEW',
      productId: rows[0].id,
      categoryId: rows[0].category_id,
      path: req.originalUrl,
      referrer: req.headers.referer || req.headers.referrer || null,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      payload: { sku: rows[0].sku, name: rows[0].name }
    });

    res.json(toDisplayProduct(rows[0]));
  })
);

module.exports = router;
