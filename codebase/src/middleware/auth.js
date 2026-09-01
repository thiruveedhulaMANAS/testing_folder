const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { HttpError } = require('./error');
const { query } = require('../config/db');
const { writeAudit } = require('../services/audit');

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role || 'user' },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
}

function requireAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new HttpError(401, 'Authentication required'));
  }
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    req.user = { id: payload.sub, email: payload.email, role: payload.role || 'user' };
    next();
  } catch {
    next(new HttpError(401, 'Invalid or expired token'));
  }
}

/**
 * Guards every /admin/* API route and UI view.
 *
 * Deliberately does NOT trust the `role` claim baked into the JWT at sign
 * time: a token can be minutes to days old (see JWT_EXPIRES_IN), and if an
 * admin is demoted or deactivated mid-session a stale claim would let them
 * keep issuing admin actions until the token expires. Every admin request
 * re-checks the role against the database instead -- the extra indexed
 * lookup (idx_users_role) is a non-issue on the admin surface's traffic
 * volume, and it closes that privilege-persistence window.
 *
 * Must run after requireAuth. Any failure -- missing auth, non-admin role,
 * or a since-deleted account -- is logged to audit_logs and answered with
 * a generic 403 so we don't leak *why* access was denied to the caller.
 */
async function requireAdmin(req, res, next) {
  try {
    if (!req.user) {
      return next(new HttpError(401, 'Authentication required'));
    }

    const result = await query('SELECT role FROM users WHERE id = $1', [req.user.id]);
    const dbUser = result.rows[0];

    if (!dbUser || dbUser.role !== 'admin') {
      await writeAudit(null, {
        userId: req.user.id,
        eventName: 'ADMIN_ACCESS_DENIED',
        path: req.originalUrl,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        payload: { method: req.method, reason: dbUser ? 'not_admin' : 'user_not_found' }
      });
      return next(new HttpError(403, 'Forbidden'));
    }

    req.user.role = 'admin';
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Like requireAuth, but never rejects the request. Used on endpoints that
 * are open to anonymous visitors (product views, page-view/dwell beacons)
 * but should still attribute the event to a logged-in user when a valid
 * token is present.
 */
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next();
  }
  try {
    const payload = jwt.verify(token, env.jwtSecret);
    req.user = { id: payload.sub, email: payload.email };
  } catch {
    // Invalid/expired token on an optional-auth route: proceed as anonymous.
  }
  next();
}

module.exports = { signToken, requireAuth, requireAdmin, optionalAuth };
