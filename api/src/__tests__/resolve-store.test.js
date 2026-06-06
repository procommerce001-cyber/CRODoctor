'use strict';

// ---------------------------------------------------------------------------
// Focused tests for resolveStore — tenant ownership + inactive-store guard.
// Pure unit tests with mocked prisma/res/req (no DB, no I/O).
//
// Run: node --test src/__tests__/resolve-store.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const { resolveStore } = require('../lib/resolve-store');

function mkRes() {
  return {
    code: null, body: null,
    status(c) { this.code = c; return this; },
    json(o)   { this.body = o; return this; },
  };
}
const mkPrisma = (store) => ({ store: { findUnique: async () => store } });

const ACTIVE   = { id: 's1', shopDomain: 'a.myshopify.com', isActive: true,  accessToken: 'tok_a' };
const INACTIVE = { id: 's1', shopDomain: 'a.myshopify.com', isActive: false, accessToken: null };
const NOTOKEN  = { id: 's1', shopDomain: 'a.myshopify.com', isActive: true,  accessToken: null };

test('active store + matching session → returns store, no response written', async () => {
  const res = mkRes();
  const out = await resolveStore(mkPrisma(ACTIVE), 'a.myshopify.com', res, { session: { storeId: 's1' } });
  assert.strictEqual(out, ACTIVE);
  assert.strictEqual(res.code, null);
});

test('Store A session + Store B shop → 403 Forbidden, null', async () => {
  const res = mkRes();
  const out = await resolveStore(mkPrisma(ACTIVE), 'a.myshopify.com', res, { session: { storeId: 'OTHER' } });
  assert.strictEqual(out, null);
  assert.strictEqual(res.code, 403);
  assert.strictEqual(res.body.error, 'Forbidden.');
});

test('inactive store + matching session → 403 Store inactive, null', async () => {
  const res = mkRes();
  const out = await resolveStore(mkPrisma(INACTIVE), 'a.myshopify.com', res, { session: { storeId: 's1' } });
  assert.strictEqual(out, null);
  assert.strictEqual(res.code, 403);
  assert.strictEqual(res.body.error, 'Store is inactive.');
});

test('active flag but accessToken=null + matching session → 403 Store inactive, null', async () => {
  const res = mkRes();
  const out = await resolveStore(mkPrisma(NOTOKEN), 'a.myshopify.com', res, { session: { storeId: 's1' } });
  assert.strictEqual(out, null);
  assert.strictEqual(res.code, 403);
  assert.strictEqual(res.body.error, 'Store is inactive.');
});

test('missing shop → 400 (unchanged behavior)', async () => {
  const res = mkRes();
  const out = await resolveStore(mkPrisma(ACTIVE), '', res, { session: { storeId: 's1' } });
  assert.strictEqual(out, null);
  assert.strictEqual(res.code, 400);
});

test('unknown store → 404 (unchanged behavior)', async () => {
  const res = mkRes();
  const out = await resolveStore(mkPrisma(null), 'ghost.myshopify.com', res, { session: { storeId: 's1' } });
  assert.strictEqual(out, null);
  assert.strictEqual(res.code, 404);
});

test('dev-bearer path (no session) + active store → returns store', async () => {
  const res = mkRes();
  const out = await resolveStore(mkPrisma(ACTIVE), 'a.myshopify.com', res, { session: {} });
  assert.strictEqual(out, ACTIVE);
  assert.strictEqual(res.code, null);
});

test('dev-bearer path (no session) + inactive store → still blocked (403)', async () => {
  const res = mkRes();
  const out = await resolveStore(mkPrisma(INACTIVE), 'a.myshopify.com', res, { session: {} });
  assert.strictEqual(out, null);
  assert.strictEqual(res.code, 403);
  assert.strictEqual(res.body.error, 'Store is inactive.');
});
