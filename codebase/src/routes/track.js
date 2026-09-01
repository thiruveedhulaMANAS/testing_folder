const express = require('express');
const { optionalAuth } = require('../middleware/auth');
const { asyncHandler, HttpError } = require('../middleware/error');
const { trackEvent } = require('../services/audit');
const { query } = require('../config/db');

const router = express.Router();
router.use(optionalAuth);

/**
 * Beacon endpoint the frontend calls (via navigator.sendBeacon) when a
 * shopper navigates away from a product page, reporting how long they
 * actually looked at it. Completes the PRODUCT_VIEW dwell_time_ms capture
 * described in the audit spec without blocking the initial page load on it.
 */
router.post(
  '/dwell',
  asyncHandler(async (req, res) => {
    const productId = Number(req.body?.productId);
    const dwellTimeMs = Number(req.body?.dwellTimeMs);
    if (!Number.isInteger(productId) || productId < 1 || !Number.isFinite(dwellTimeMs) || dwellTimeMs < 0) {
      throw new HttpError(400, 'productId and a non-negative dwellTimeMs are required');
    }

    const { rows } = await query('SELECT category_id FROM products WHERE id = $1', [productId]);
    if (!rows[0]) throw new HttpError(404, 'Product not found');

    trackEvent({
      userId: req.user?.id || null,
      eventType: 'PRODUCT_VIEW',
      productId,
      categoryId: rows[0].category_id,
      path: req.originalUrl,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      dwellTimeMs: Math.round(dwellTimeMs),
      payload: { dwellUpdate: true }
    });

    res.status(202).json({ accepted: true });
  })
);

/**
 * Explicit client-side navigation beacon for the single-page app, since
 * hash-based route changes (#/cart, #/product/1) don't produce a fresh HTTP
 * request the server-side pageImpressionLogger middleware could observe.
 */
router.post(
  '/page-view',
  asyncHandler(async (req, res) => {
    const page = String(req.body?.page || '').trim();
    const path = String(req.body?.path || '').trim();
    if (!page) throw new HttpError(400, 'page is required');

    trackEvent({
      userId: req.user?.id || null,
      eventType: 'PAGE_VIEW',
      path: path || null,
      referrer: req.headers.referer || req.headers.referrer || null,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      payload: { page, source: 'spa-navigation' }
    });

    res.status(202).json({ accepted: true });
  })
);

module.exports = router;
