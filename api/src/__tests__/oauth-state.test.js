'use strict';

// Focused tests for the durable, signed-cookie OAuth state mechanism that
// replaced the in-memory Map. Covers sign/verify, the pure callback validator,
// and cookie attributes/parsing. Uses the built-in node:test runner.

const test   = require('node:test');
const assert = require('node:assert');

// Ensure a deterministic secret + production cookie posture for these tests.
process.env.SESSION_SECRET = 'test-oauth-secret';
process.env.NODE_ENV       = 'production';

const {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  signOAuthState,
  verifyOAuthState,
  readCookie,
  oauthStateCookieOptions,
  oauthStateClearOptions,
  validateOAuthCallback,
} = require('../lib/shopify-oauth');

const SHOP  = 'jw5kjx-1z.myshopify.com';
const STATE = 'abc123def456';

function freshToken(overrides = {}) {
  return signOAuthState({
    shop:      SHOP,
    state:     STATE,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    ...overrides,
  });
}

test('sign/verify round-trips a payload', () => {
  const payload = { shop: SHOP, state: STATE, expiresAt: 123 };
  const parsed  = verifyOAuthState(signOAuthState(payload));
  assert.deepStrictEqual(parsed, payload);
});

test('valid signed OAuth state passes validation', () => {
  const result = validateOAuthCallback({ cookieToken: freshToken(), returnedState: STATE, shop: SHOP });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.payload.shop, SHOP);
});

test('missing cookie fails with 403', () => {
  const result = validateOAuthCallback({ cookieToken: null, returnedState: STATE, shop: SHOP });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 403);
  assert.match(result.error, /Invalid or expired state/);
});

test('tampered cookie (bad signature) fails', () => {
  const token   = freshToken();
  const [body]  = token.split('.');
  const forged  = `${body}.deadbeefdeadbeef`;
  const result  = validateOAuthCallback({ cookieToken: forged, returnedState: STATE, shop: SHOP });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 403);
});

test('tampered payload without re-signing fails', () => {
  // Re-encode a different shop into the body but keep the old signature.
  const token   = freshToken();
  const sig     = token.split('.')[1];
  const evilBody = Buffer.from(JSON.stringify({ shop: 'evil.myshopify.com', state: STATE, expiresAt: Date.now() + 1000 })).toString('base64url');
  const result  = validateOAuthCallback({ cookieToken: `${evilBody}.${sig}`, returnedState: STATE, shop: 'evil.myshopify.com' });
  assert.strictEqual(result.ok, false);
});

test('expired state fails', () => {
  const token  = freshToken({ expiresAt: Date.now() - 1 });
  const result = validateOAuthCallback({ cookieToken: token, returnedState: STATE, shop: SHOP });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 403);
  assert.match(result.error, /expired/i);
});

test('mismatched returned state fails', () => {
  const result = validateOAuthCallback({ cookieToken: freshToken(), returnedState: 'WRONG', shop: SHOP });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /mismatch/i);
});

test('mismatched shop fails', () => {
  const result = validateOAuthCallback({ cookieToken: freshToken(), returnedState: STATE, shop: 'other.myshopify.com' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /shop mismatch/i);
});

test('cookie options are httpOnly, Secure, SameSite=None, /auth, 10min in production', () => {
  const opts = oauthStateCookieOptions();
  assert.strictEqual(opts.httpOnly, true);
  assert.strictEqual(opts.secure, true);
  assert.strictEqual(opts.sameSite, 'none');
  assert.strictEqual(opts.path, '/auth');
  assert.strictEqual(opts.maxAge, OAUTH_STATE_TTL_MS);
});

test('clear options match set options without maxAge (so the cookie clears)', () => {
  const clear = oauthStateClearOptions();
  assert.strictEqual(clear.maxAge, undefined);
  assert.strictEqual(clear.secure, true);
  assert.strictEqual(clear.sameSite, 'none');
  assert.strictEqual(clear.path, '/auth');
});

test('readCookie parses the named cookie from a raw header', () => {
  const req = { headers: { cookie: `other=1; ${OAUTH_STATE_COOKIE}=tok.value; another=2` } };
  assert.strictEqual(readCookie(req, OAUTH_STATE_COOKIE), 'tok.value');
  assert.strictEqual(readCookie({ headers: {} }, OAUTH_STATE_COOKIE), null);
});
