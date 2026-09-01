/**
 * Async event pipeline worker.
 *
 * Run as its own process/container (`node src/workers/auditWorker.js`, or
 * `npm run worker`). Consumes the `audit-events` BullMQ queue -- fed by
 * enqueueAuditEvent() in src/queues/auditQueue.js -- and persists each
 * PAGE_VIEW / PRODUCT_VIEW impression into Postgres. This keeps high-volume,
 * non-critical tracking writes completely off the API's request/response path.
 */
const { Worker } = require('bullmq');
const { createBullConnection } = require('../config/redis');
const { pool } = require('../config/db');
const { QUEUE_NAME } = require('../queues/auditQueue');

const CONCURRENCY = Number(process.env.AUDIT_WORKER_CONCURRENCY) || 5;

async function persistEvent(event) {
  const {
    userId = null,
    eventType,
    productId = null,
    categoryId = null,
    path = null,
    referrer = null,
    ipAddress = null,
    userAgent = null,
    dwellTimeMs = null,
    payload = {}
  } = event;

  await pool.query(
    `INSERT INTO audit_logs
       (user_id, event_type, product_id, category_id, path, referrer,
        ip_address, user_agent, dwell_time_ms, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, (NOW() AT TIME ZONE 'utc'))`,
    [
      userId,
      eventType,
      productId,
      categoryId,
      path,
      referrer,
      ipAddress,
      userAgent,
      dwellTimeMs,
      JSON.stringify(payload)
    ]
  );
}

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    await persistEvent(job.data);
  },
  {
    ...createBullConnection(),
    concurrency: CONCURRENCY
  }
);

worker.on('completed', (job) => {
  console.log(`[audit-worker] wrote ${job.data.eventType} (job ${job.id})`);
});

worker.on('failed', (job, err) => {
  console.error(`[audit-worker] job ${job?.id} failed:`, err.message);
});

console.log(`[audit-worker] listening on queue "${QUEUE_NAME}" with concurrency ${CONCURRENCY}`);

async function shutdown() {
  await worker.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
