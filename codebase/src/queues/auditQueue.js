const { Queue } = require('bullmq');
const { createBullConnection } = require('../config/redis');

const QUEUE_NAME = 'audit-events';

const auditQueue = new Queue(QUEUE_NAME, {
  ...createBullConnection(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400 }
  }
});

auditQueue.on('error', (err) => {
  console.error('[audit-queue] error:', err.message);
});

/**
 * Enqueue a high-volume, non-critical tracking event (PAGE_VIEW,
 * PRODUCT_VIEW). This resolves as soon as the job is persisted to Redis --
 * typically sub-millisecond -- so it never blocks the HTTP response while
 * waiting on a Postgres write. A background worker (src/workers/auditWorker.js)
 * drains the queue and performs the actual INSERT.
 */
async function enqueueAuditEvent(event) {
  try {
    await auditQueue.add('log', event, { removeOnComplete: true });
  } catch (err) {
    // Tracking must never break the user-facing request.
    console.error('[audit-queue] enqueue failed:', err.message);
  }
}

module.exports = { auditQueue, enqueueAuditEvent, QUEUE_NAME };
