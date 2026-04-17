'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Auth middleware
//
// All routes are protected by default.
// Exempt paths bypass the check entirely (Shopify OAuth flow + health).
// Fail-closed: if API_SECRET is not configured, all protected routes return 503.
// ---------------------------------------------------------------------------

const PUBLIC_PATHS = new Set([
  '/health',
  '/auth/shopify',
  '/auth/shopify/callback',
  '/auth/install',
  '/auth/callback',
]);

function makeRequireAuth(apiSecret) {
  return function requireAuth(req, res, next) {
    if (PUBLIC_PATHS.has(req.path)) return next();

    if (!apiSecret) {
      return res.status(503).json({ error: 'API_SECRET is not configured on this server.' });
    }

    const authHeader = req.headers['authorization'] || '';
    const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Authorization header with Bearer token required.' });
    }

    // Constant-time comparison to prevent timing attacks.
    // Both buffers must be the same byte-length for timingSafeEqual.
    const expected = Buffer.from(apiSecret);
    const provided = Buffer.from(token);
    const match = expected.length === provided.length &&
      crypto.timingSafeEqual(expected, provided);

    if (!match) {
      return res.status(401).json({ error: 'Invalid token.' });
    }

    next();
  };
}

module.exports = { makeRequireAuth, PUBLIC_PATHS };
