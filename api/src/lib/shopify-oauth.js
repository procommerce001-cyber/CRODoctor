'use strict';

const crypto = require('crypto');

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Name of the temporary, signed, httpOnly cookie that carries OAuth state
// across the Shopify install → callback round trip. This replaces the old
// in-memory Map, which did not survive Render restart/redeploy/cold-start.
const OAUTH_STATE_COOKIE = 'cro.oauth_state';

// The OAuth state cookie is signed with the same server secret express-session
// uses. The dev fallback mirrors server.js so local dev works; production is
// guarded to require SESSION_SECRET before the app boots.
function stateSecret() {
  return process.env.SESSION_SECRET || 'dev-fallback-secret';
}

/**
 * Sign a small OAuth-state payload into a tamper-evident token:
 *   "<base64url(JSON payload)>.<base64url(HMAC-SHA256)>"
 * The payload is not secret (it only holds shop/state/expiresAt), but the
 * signature prevents a client from forging or altering it.
 */
function signOAuthState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * Verify a token produced by signOAuthState. Returns the parsed payload object
 * on success, or null if the token is missing, malformed, or the signature does
 * not match (constant-time comparison).
 */
function verifyOAuthState(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  if (!body || !sig) return null;

  const expected = crypto.createHmac('sha256', stateSecret()).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Read a single named cookie from the raw request Cookie header. Avoids adding
 * a cookie-parser dependency just for the OAuth callback.
 */
function readCookie(req, name) {
  const header = req && req.headers && req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

/**
 * Cookie attributes for the temporary OAuth state cookie.
 * Cross-site in staging (Vercel dashboard ↔ Render API), so SameSite=None in
 * production; None requires Secure, which holds in production. Scoped to /auth
 * so it is only ever sent to the install/callback routes.
 */
function oauthStateCookieOptions() {
  const prod = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure:   prod,
    sameSite: prod ? 'none' : 'lax',
    maxAge:   OAUTH_STATE_TTL_MS,
    path:     '/auth',
  };
}

// Same attributes minus maxAge — used to reliably clear the cookie (a
// SameSite=None; Secure cookie must be cleared with matching attributes).
function oauthStateClearOptions() {
  const { maxAge, ...rest } = oauthStateCookieOptions();
  return rest;
}

/**
 * Pure validation of the OAuth callback against the signed state cookie.
 * Returns { ok: true, payload } or { ok: false, status, error }.
 * Preserves the original 403 CSRF semantics; never bypasses validation.
 */
function validateOAuthCallback({ cookieToken, returnedState, shop, now = Date.now() }) {
  const payload = verifyOAuthState(cookieToken);
  if (!payload) {
    return { ok: false, status: 403, error: 'Invalid or expired state parameter.' };
  }
  if (!returnedState || typeof payload.state !== 'string' || payload.state !== returnedState) {
    return { ok: false, status: 403, error: 'State parameter mismatch.' };
  }
  if (payload.shop !== shop) {
    return { ok: false, status: 403, error: 'State/shop mismatch.' };
  }
  if (typeof payload.expiresAt !== 'number' || now > payload.expiresAt) {
    return { ok: false, status: 403, error: 'OAuth state expired. Please restart the install flow.' };
  }
  return { ok: true, payload };
}

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

module.exports = {
  OAUTH_STATE_TTL_MS,
  OAUTH_STATE_COOKIE,
  signOAuthState,
  verifyOAuthState,
  readCookie,
  oauthStateCookieOptions,
  oauthStateClearOptions,
  validateOAuthCallback,
  verifyShopifyHmac,
  isValidShopDomain,
};
