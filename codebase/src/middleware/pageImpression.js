const { trackEvent } = require('../services/audit');

/**
 * Maps a request to a logical "page" name for impression logging. Returns
 * null for requests that aren't a core page view (health checks, static
 * assets, mutation-only endpoints already covered by their own audit calls).
 */
function resolvePage(req) {
  const { method, path, query } = req;

  if (method === 'GET' && (path === '/' || path === '/index.html')) return 'HOME';

  if (method === 'GET' && path === '/api/products') {
    return query.category || query.category_id || query.q ? 'CATEGORY_LIST' : 'HOME';
  }
  if (method === 'GET' && path === '/api/categories') return 'CATEGORY_LIST';
  if (method === 'GET' && path === '/api/cart') return 'CART';
  if (method === 'POST' && path === '/api/checkout') return 'CHECKOUT';
  if (method === 'GET' && path === '/api/orders') return 'ORDERS';

  return null;
}

/**
 * Automatic route/page impression logger. Mounted globally in app.js.
 * Every matched request enqueues a PAGE_VIEW event (async, via BullMQ) with
 * the resolved page, target path, referral query params, and request
 * metadata -- with zero per-route wiring required elsewhere.
 */
function pageImpressionLogger(req, _res, next) {
  const page = resolvePage(req);
  if (page) {
    trackEvent({
      userId: req.user?.id || null,
      eventType: 'PAGE_VIEW',
      path: req.originalUrl,
      referrer: req.headers.referer || req.headers.referrer || null,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'] || null,
      payload: {
        page,
        query: req.query
      }
    });
  }
  next();
}

module.exports = { pageImpressionLogger, resolvePage };
