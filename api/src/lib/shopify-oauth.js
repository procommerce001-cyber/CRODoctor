'use strict';

const crypto = require('crypto');

// In-memory nonce store. Single-process safe; replace with Redis before
// running multiple server instances.
const pendingOAuthStates = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Verify the HMAC Shopify appends to OAuth callback URLs.
 * Accepts clientSecret as a parameter so it can be called from any module.
 */
function verifyShopifyHmac(query, clientSecret) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join('&');

  const digest = crypto
    .createHmac('sha256', clientSecret)
    .update(message)
    .digest('hex');

  const digestBuf = Buffer.from(digest);
  const hmacBuf   = Buffer.from(hmac);
  if (digestBuf.length !== hmacBuf.length) return false;
  return crypto.timingSafeEqual(digestBuf, hmacBuf);
}

function isValidShopDomain(shop) {
  return /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop);
}

module.exports = { pendingOAuthStates, OAUTH_STATE_TTL_MS, verifyShopifyHmac, isValidShopDomain };
