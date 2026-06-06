'use strict';

// ---------------------------------------------------------------------------
// Focused tests for the beta rate limiter middleware. Pure unit — drives the
// middleware with mock req/res, no server, no DB, no network.
//
// Run: node --test src/__tests__/rate-limits.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const { makeLimiter, writeLimiter, LIMITS } = require('../middleware/rate-limits');

function mkRes() {
  return {
    code: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(o)   { this.body = o; return this; },
  };
}
function run(limiter, req) {
  const res = mkRes();
  let nexted = false;
  limiter(req, res, () => { nexted = true; });
  return { res, nexted };
}

test('writeLimiter allows up to the limit, then 429', () => {
  const req = { session: { storeId: 'tWrite' }, ip: '9.9.9.9' };
  for (let i = 0; i < LIMITS.write; i++) {
    const r = run(writeLimiter, req);
    assert.ok(r.nexted, `call ${i + 1} within limit should pass`);
  }
  const over = run(writeLimiter, req);
  assert.strictEqual(over.nexted, false, 'over-limit call must be blocked');
  assert.strictEqual(over.res.code, 429);
  assert.strictEqual(over.res.body.error, 'Too many requests. Please slow down.');
  assert.ok(over.res.headers['Retry-After'], 'sets Retry-After');
});

test('separate keys have independent buckets', () => {
  const a = run(writeLimiter, { session: { storeId: 'tIndepA' }, ip: '1.1.1.1' });
  const b = run(writeLimiter, { session: { storeId: 'tIndepB' }, ip: '1.1.1.1' });
  assert.ok(a.nexted && b.nexted, 'different tenants are not shared');
});

test('makeLimiter: tenant key prefers storeId, falls back to shop then ip', () => {
  const lim = makeLimiter('t_keytest', 1, (req) => (req.session && req.session.storeId) || (req.query && req.query.shop) || req.ip);
  // storeId path
  assert.ok(run(lim, { session: { storeId: 'S' }, ip: 'x' }).nexted);
  assert.strictEqual(run(lim, { session: { storeId: 'S' }, ip: 'x' }).res.code, 429);
  // shop path (independent key)
  assert.ok(run(lim, { query: { shop: 'shopA.myshopify.com' }, ip: 'x' }).nexted);
  // ip path (independent key)
  assert.ok(run(lim, { ip: 'ip-only' }).nexted);
});

test('exceeding limit sets standard RateLimit headers', () => {
  const lim = makeLimiter('t_headers', 2, () => 'k');
  run(lim, { ip: 'k' });
  const r2 = run(lim, { ip: 'k' });
  assert.strictEqual(r2.res.headers['RateLimit-Limit'], '2');
  assert.ok('RateLimit-Remaining' in r2.res.headers);
  assert.ok('RateLimit-Reset' in r2.res.headers);
});
