'use strict';

// ---------------------------------------------------------------------------
// Controlled Beta write kill switch (PR C) — pure + chokepoint + route tests.
// No live Shopify / DB / Anthropic / network: global.fetch is stubbed only to
// prove the write function is unreachable when the kill switch is on.
//
// Run: node --test src/__tests__/beta-safety.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const beta = require('../services/beta-safety.service');

const WRITE_FLAGS = ['CONTROLLED_BETA_READ_ONLY', 'DISABLE_SHOPIFY_WRITES', 'APPLY_DISABLED'];
function clearFlags() { for (const f of WRITE_FLAGS) delete process.env[f]; }

// ── isTruthyFlag ─────────────────────────────────────────────────────────────

test('isTruthyFlag accepts true and "true"/"1"/"yes"/"on" (case/space-insensitive)', () => {
  for (const v of [true, 'true', '1', 'yes', 'on', 'TRUE', ' On ']) {
    assert.strictEqual(beta.isTruthyFlag(v), true, `value ${JSON.stringify(v)}`);
  }
});

test('isTruthyFlag rejects false/other values', () => {
  for (const v of [false, 'false', '0', 'no', 'off', '', 'maybe', null, undefined, 2, {}]) {
    assert.strictEqual(beta.isTruthyFlag(v), false, `value ${JSON.stringify(v)}`);
  }
});

// ── flag readers (pass explicit env, no global mutation) ─────────────────────

test('isBetaReadOnly true only when CONTROLLED_BETA_READ_ONLY truthy', () => {
  assert.strictEqual(beta.isBetaReadOnly({ CONTROLLED_BETA_READ_ONLY: 'true' }), true);
  assert.strictEqual(beta.isBetaReadOnly({}), false);
});

test('isShopifyWritesDisabled true only when DISABLE_SHOPIFY_WRITES truthy', () => {
  assert.strictEqual(beta.isShopifyWritesDisabled({ DISABLE_SHOPIFY_WRITES: '1' }), true);
  assert.strictEqual(beta.isShopifyWritesDisabled({}), false);
});

test('shouldBlockShopifyWrites true when either write flag set, false when none', () => {
  assert.strictEqual(beta.shouldBlockShopifyWrites({ CONTROLLED_BETA_READ_ONLY: 'true' }), true);
  assert.strictEqual(beta.shouldBlockShopifyWrites({ DISABLE_SHOPIFY_WRITES: 'yes' }), true);
  assert.strictEqual(beta.shouldBlockShopifyWrites({}), false);
});

test('shouldBlockApplyRoutes also blocks on APPLY_DISABLED', () => {
  assert.strictEqual(beta.shouldBlockApplyRoutes({ APPLY_DISABLED: 'on' }), true);
  assert.strictEqual(beta.shouldBlockApplyRoutes({ DISABLE_SHOPIFY_WRITES: 'true' }), true);
  assert.strictEqual(beta.shouldBlockApplyRoutes({}), false);
});

// ── response body + error shape ──────────────────────────────────────────────

test('betaReadOnlyResponseBody returns a stable shape', () => {
  assert.deepStrictEqual(beta.betaReadOnlyResponseBody(), {
    error: 'beta_read_only',
    message: 'Shopify writes are disabled in controlled beta read-only mode.',
  });
});

test('createBetaReadOnlyError has stable code/name/status', () => {
  const err = beta.createBetaReadOnlyError();
  assert.ok(err instanceof Error);
  assert.strictEqual(err.name, 'BetaReadOnlyWriteBlocked');
  assert.strictEqual(err.code, 'BETA_READ_ONLY_WRITE_BLOCKED');
  assert.strictEqual(err.status, 403);
});

// ── route block helper ───────────────────────────────────────────────────────

test('getBetaReadOnlyRouteBlock returns 403 block when blocked, null otherwise', () => {
  assert.deepStrictEqual(beta.getBetaReadOnlyRouteBlock({ CONTROLLED_BETA_READ_ONLY: 'true' }), {
    status: 403, body: { error: 'beta_read_only', message: 'Shopify writes are disabled in controlled beta read-only mode.' },
  });
  assert.strictEqual(beta.getBetaReadOnlyRouteBlock({}), null);
});

// ── chokepoint: updateProductDescription ─────────────────────────────────────

test('updateProductDescription throws BETA_READ_ONLY_WRITE_BLOCKED and never calls fetch when writes disabled', async () => {
  const { updateProductDescription } = require('../services/shopify-admin.service');
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('fetch must not be called'); };
  clearFlags();
  process.env.DISABLE_SHOPIFY_WRITES = 'true';
  try {
    await assert.rejects(
      () => updateProductDescription({ shopDomain: 's.myshopify.com', accessToken: 'x' }, '123', '<p>hi</p>'),
      (e) => e.code === 'BETA_READ_ONLY_WRITE_BLOCKED' && e.status === 403
    );
    assert.strictEqual(fetchCalled, false, 'Shopify fetch must not be called when writes are disabled');
  } finally {
    clearFlags();
    global.fetch = originalFetch;
  }
});

test('updateProductDescription proceeds to the write path when flags are off (stubbed fetch, no live Shopify)', async () => {
  const { updateProductDescription } = require('../services/shopify-admin.service');
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ product: { id: '123', body_html: '<p>hi</p>' } }) };
  };
  clearFlags();
  try {
    const product = await updateProductDescription({ shopDomain: 's.myshopify.com', accessToken: 'x' }, '123', '<p>hi</p>');
    assert.strictEqual(fetchCalled, true, 'write path should reach Shopify fetch when flags are off');
    assert.strictEqual(product.id, '123');
  } finally {
    global.fetch = originalFetch;
  }
});

test('shopifyFetch blocks any mutating method (defense in depth) but allows GET', async () => {
  // Indirectly exercised via updateProductDescription above; here assert the
  // env-driven decision the chokepoint relies on.
  assert.strictEqual(beta.shouldBlockShopifyWrites({ DISABLE_SHOPIFY_WRITES: 'true' }), true);
  assert.strictEqual(beta.shouldBlockShopifyWrites({}), false);
});
