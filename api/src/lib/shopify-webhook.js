'use strict';

const crypto = require('crypto');

/**
 * Verify the X-Shopify-Hmac-Sha256 header on incoming webhook requests.
 *
 * Shopify signs the RAW request body (not query params) with HMAC-SHA256
 * and base64-encodes the result. The caller MUST pass the raw Buffer —
 * if express.json() has already parsed the body this will always fail.
 *
 * @param {Buffer} rawBody   - req.body when express.raw() is used on the route
 * @param {string} hmacHeader - value of X-Shopify-Hmac-Sha256 header
 * @param {string} secret     - SHOPIFY_CLIENT_SECRET
 * @returns {boolean}
 */
function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !rawBody || !secret) return false;

  const digest  = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  const expected = Buffer.from(digest);
  const provided = Buffer.from(hmacHeader);

  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

module.exports = { verifyWebhookHmac };
