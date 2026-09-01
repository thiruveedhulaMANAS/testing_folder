const IORedis = require('ioredis');
const env = require('./env');

// A single shared connection for caching + session storage.
// maxRetriesPerRequest is left at ioredis default here (cache/session paths
// tolerate a failed lookup); BullMQ connections use their own client with
// maxRetriesPerRequest: null, per BullMQ's requirement.
const redis = new IORedis(env.redisUrl, {
  lazyConnect: false,
  retryStrategy: (times) => Math.min(times * 200, 2000)
});

redis.on('error', (err) => {
  console.error('[redis] connection error:', err.message);
});

// BullMQ requires its own Redis connection option `maxRetriesPerRequest: null`.
// We expose a factory so the queue and the worker each get a compliant client.
function createBullConnection() {
  return {
    connection: new IORedis(env.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    })
  };
}

module.exports = { redis, createBullConnection };
