const { redis } = require('../config/redis');

const NAMESPACE = 'shop:cache:';

/**
 * Fetch a cached JSON value. Returns null on a cache miss OR any Redis
 * error -- caching must never be a hard dependency for correctness.
 */
async function getCached(key) {
  try {
    const raw = await redis.get(NAMESPACE + key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('[cache] get failed:', err.message);
    return null;
  }
}

async function setCached(key, value, ttlSeconds) {
  try {
    await redis.set(NAMESPACE + key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    console.error('[cache] set failed:', err.message);
  }
}

/**
 * Wrap a loader function with cache-aside semantics.
 */
async function withCache(key, ttlSeconds, loader) {
  const cached = await getCached(key);
  if (cached !== null) return { value: cached, hit: true };
  const value = await loader();
  await setCached(key, value, ttlSeconds);
  return { value, hit: false };
}

/**
 * Invalidate every cached entry under a prefix, e.g. all product listing
 * pages, after a mutation that changes catalog data (checkout stock
 * decrement, product update, etc). Uses SCAN so it never blocks Redis.
 */
async function invalidatePrefix(prefix) {
  try {
    const stream = redis.scanStream({ match: `${NAMESPACE}${prefix}*`, count: 100 });
    const keys = [];
    for await (const batch of stream) {
      keys.push(...batch);
    }
    if (keys.length) await redis.del(keys);
  } catch (err) {
    console.error('[cache] invalidation failed:', err.message);
  }
}

module.exports = { getCached, setCached, withCache, invalidatePrefix };
