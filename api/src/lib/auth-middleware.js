'use strict';

const PUBLIC_PATHS = new Set([
  '/health',
  '/auth/shopify',
  '/auth/shopify/callback',
  '/auth/install',
  '/auth/callback',
]);

const DEV_TOKEN = process.env.NODE_ENV !== 'production' ? process.env.DEV_BEARER_TOKEN : null;

function requireSession(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  if (DEV_TOKEN) {
    const auth = req.headers['authorization'] ?? '';
    if (auth === `Bearer ${DEV_TOKEN}`) return next();
  }

  if (!req.session || !req.session.storeId) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  next();
}

module.exports = { requireSession, PUBLIC_PATHS };
