'use strict';

const PUBLIC_PATHS = new Set([
  '/health',
  '/auth/shopify',
  '/auth/shopify/callback',
  '/auth/install',
  '/auth/callback',
]);

function requireSession(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  if (!req.session || !req.session.storeId) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  next();
}

module.exports = { requireSession, PUBLIC_PATHS };
