const { query } = require('../config/db');
const { enqueueAuditEvent } = require('../queues/auditQueue');

/**
 * Synchronous audit write for critical, low-volume MUTATION events
 * (USER_REGISTER, LOGIN, ADD_TO_CART, UPDATE_CART, REMOVE_FROM_CART,
 * PURCHASE_COMPLETED). These are written inline -- often inside the same
 * DB transaction as the mutation -- because losing one would mean an
 * incomplete record of what actually changed in the system.
 *
 * `db` may be a pg Pool/PoolClient (for transactional writes) or omitted
 * to use the default pool.
 */
async function writeAudit(db, { userId = null, eventName, eventType, payload = {}, ...rest }) {
  const executor = db && db.query ? db : { query };
  await executor.query(
    `INSERT INTO audit_logs
       (user_id, event_type, product_id, category_id, path, referrer,
        ip_address, user_agent, dwell_time_ms, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, (NOW() AT TIME ZONE 'utc'))`,
    [
      userId,
      eventType || eventName,
      rest.productId ?? null,
      rest.categoryId ?? null,
      rest.path ?? null,
      rest.referrer ?? null,
      rest.ipAddress ?? null,
      rest.userAgent ?? null,
      rest.dwellTimeMs ?? null,
      JSON.stringify(payload)
    ]
  );
}

/**
 * Fire-and-forget audit write for high-volume, non-critical READ/IMPRESSION
 * events (PAGE_VIEW, PRODUCT_VIEW). Enqueues onto the `audit-events` BullMQ
 * queue (Redis-backed) and returns immediately -- the actual Postgres INSERT
 * happens out-of-band in src/workers/auditWorker.js, so tracking never adds
 * latency to the request/response cycle. Never throws: a tracking failure
 * must never break the page/product the user is trying to load.
 */
function trackEvent(event) {
  enqueueAuditEvent(event).catch((err) => {
    console.error('[audit] trackEvent enqueue failed:', err.message);
  });
}

module.exports = { writeAudit, trackEvent };
