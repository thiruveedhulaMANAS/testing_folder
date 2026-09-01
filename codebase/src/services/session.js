const { redis } = require('../config/redis');

const SESSION_PREFIX = 'shop:session:'; // shop:session:<jti> -> session metadata (active session state)
const REVOKED_PREFIX = 'shop:revoked:'; // shop:revoked:<jti> -> '1' (logout / revocation marker)

function ttlFromExpiry(expiresAtSeconds) {
  const ttl = expiresAtSeconds - Math.floor(Date.now() / 1000);
  return ttl > 0 ? ttl : 1;
}

/**
 * Store session state in Redis when a JWT is issued (login/register).
 * This is the "session state storage" layer: the JWT itself stays stateless
 * and self-contained, but Redis lets us see active sessions and revoke one
 * on demand (logout) without waiting for the token to naturally expire.
 */
async function createSession(jti, { userId, email, expiresAt, ip, userAgent }) {
  try {
    await redis.set(
      SESSION_PREFIX + jti,
      JSON.stringify({ userId, email, ip, userAgent, issuedAt: new Date().toISOString() }),
      'EX',
      ttlFromExpiry(expiresAt)
    );
  } catch (err) {
    console.error('[session] create failed:', err.message);
  }
}

/**
 * Revoke a session (logout). Marks the token's jti as revoked until it would
 * have naturally expired, and drops the session record.
 */
async function revokeSession(jti, expiresAt) {
  try {
    await redis.multi()
      .set(REVOKED_PREFIX + jti, '1', 'EX', ttlFromExpiry(expiresAt))
      .del(SESSION_PREFIX + jti)
      .exec();
  } catch (err) {
    console.error('[session] revoke failed:', err.message);
  }
}

async function isRevoked(jti) {
  try {
    const val = await redis.get(REVOKED_PREFIX + jti);
    return val === '1';
  } catch (err) {
    console.error('[session] revocation check failed:', err.message);
    // Fail open: Redis being unavailable should not lock every user out.
    return false;
  }
}

module.exports = { createSession, revokeSession, isRevoked };
