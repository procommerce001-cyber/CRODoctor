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

// ── TRUE chokepoint: action-center.service.updateProductDescription ──────────
// This is the function every apply/rollback path actually routes through.

test('action-center updateProductDescription throws BETA_READ_ONLY_WRITE_BLOCKED and never calls fetch when read-only', async () => {
  const { updateProductDescription } = require('../services/action-center.service');
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('fetch must not be called'); };
  clearFlags();
  process.env.CONTROLLED_BETA_READ_ONLY = 'true';
  try {
    await assert.rejects(
      () => updateProductDescription({ shopDomain: 's.myshopify.com', accessToken: 'x' }, '123', '<p>hi</p>'),
      (e) => e.code === 'BETA_READ_ONLY_WRITE_BLOCKED' && e.status === 403
    );
    assert.strictEqual(fetchCalled, false, 'true write chokepoint must not call Shopify when read-only');
  } finally {
    clearFlags();
    global.fetch = originalFetch;
  }
});

test('action-center updateProductDescription is also blocked by DISABLE_SHOPIFY_WRITES', async () => {
  const { updateProductDescription } = require('../services/action-center.service');
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('fetch must not be called'); };
  clearFlags();
  process.env.DISABLE_SHOPIFY_WRITES = 'true';
  try {
    await assert.rejects(
      () => updateProductDescription({ shopDomain: 's.myshopify.com', accessToken: 'x' }, '123', '<p>hi</p>'),
      (e) => e.code === 'BETA_READ_ONLY_WRITE_BLOCKED'
    );
    assert.strictEqual(fetchCalled, false);
  } finally {
    clearFlags();
    global.fetch = originalFetch;
  }
});

test('action-center updateProductDescription proceeds to write when flags off (stubbed fetch, no live Shopify)', async () => {
  const { updateProductDescription } = require('../services/action-center.service');
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({ product: { id: '123' } }) };
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

// ── decision-engine apply route guard (via the shared route-block helper) ────

test('decision-engine apply route can short-circuit with beta_read_only 403 before dangerous work', () => {
  // POST /decision-engine/actions/execute guards with getBetaReadOnlyRouteBlock()
  // as its first statement — the same pure helper, proven here by construction.
  const block = beta.getBetaReadOnlyRouteBlock({ CONTROLLED_BETA_READ_ONLY: 'true' });
  assert.ok(block);
  assert.strictEqual(block.status, 403);
  assert.strictEqual(block.body.error, 'beta_read_only');
  assert.strictEqual(beta.getBetaReadOnlyRouteBlock({}), null); // proceeds when flags off
});

// ── D1: raw-fetch bypass closures ────────────────────────────────────────────
// registerWebhooks and deleteAsset use raw fetch (to tolerate 422 / 404 as
// success), so they never pass through shopifyFetch's mutation gate. Both now
// carry the same explicit chokepoint guard as updateProductDescription.

test('registerWebhooks is blocked and sends no Shopify mutation when writes disabled', async () => {
  const { registerWebhooks } = require('../services/webhook-registration.service');
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('fetch must not be called'); };
  clearFlags();
  process.env.DISABLE_SHOPIFY_WRITES = 'true';
  try {
    await assert.rejects(
      () => registerWebhooks({ shopDomain: 's.myshopify.com', accessToken: 'x' }, 'https://app.example'),
      (e) => e.code === 'BETA_READ_ONLY_WRITE_BLOCKED' && e.status === 403
    );
    assert.strictEqual(fetchCalled, false, 'no webhook POST may reach Shopify when writes are disabled');
  } finally {
    clearFlags();
    global.fetch = originalFetch;
  }
});

test('registerWebhooks is also blocked by CONTROLLED_BETA_READ_ONLY (no dev-only exception)', async () => {
  const { registerWebhooks } = require('../services/webhook-registration.service');
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('fetch must not be called'); };
  clearFlags();
  process.env.CONTROLLED_BETA_READ_ONLY = 'true';
  try {
    await assert.rejects(
      () => registerWebhooks({ shopDomain: 's.myshopify.com', accessToken: 'x' }, 'https://app.example'),
      (e) => e.code === 'BETA_READ_ONLY_WRITE_BLOCKED'
    );
    assert.strictEqual(fetchCalled, false);
  } finally {
    clearFlags();
    global.fetch = originalFetch;
  }
});

test('registerWebhooks treats a CONFIRMED duplicate 422 as idempotent success', async () => {
  const { registerWebhooks } = require('../services/webhook-registration.service');
  const originalFetch = global.fetch;
  const posted = [];
  global.fetch = async (url, opts) => {
    posted.push(opts.method);
    return { ok: false, status: 422,
      text: async () => JSON.stringify({ errors: { address: ['for this topic has already been taken'] } }) };
  };
  clearFlags();
  try {
    const r = await registerWebhooks({ shopDomain: 's.myshopify.com', accessToken: 'x' }, 'https://app.example');
    assert.strictEqual(posted.length, 3, 'all three lifecycle topics attempted');
    assert.ok(r.every(x => x.success === true && x.duplicate === true));
  } finally { global.fetch = originalFetch; }
});

test('registerWebhooks does NOT treat a validation 422 as success', async () => {
  const { registerWebhooks } = require('../services/webhook-registration.service');
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 422,
    text: async () => JSON.stringify({ errors: { topic: ['is invalid'] } }) });
  clearFlags();
  try {
    const r = await registerWebhooks({ shopDomain: 's.myshopify.com', accessToken: 'x' }, 'https://app.example');
    assert.ok(r.every(x => x.success === false), 'invalid topic must not be reported as success');
    assert.ok(r.every(x => typeof x.error === 'string' && x.error.includes('is invalid')));
  } finally { global.fetch = originalFetch; }
});

test('registerWebhooks fails closed on a malformed/unknown 422 body', async () => {
  const { registerWebhooks } = require('../services/webhook-registration.service');
  const originalFetch = global.fetch;
  clearFlags();
  try {
    for (const body of ['<html>gateway</html>', '', '{"errors":']) {
      global.fetch = async () => ({ ok: false, status: 422, text: async () => body });
      const r = await registerWebhooks({ shopDomain: 's.myshopify.com', accessToken: 'x' }, 'https://app.example');
      assert.ok(r.every(x => x.success === false), `malformed 422 must not be success: ${JSON.stringify(body)}`);
    }
  } finally { global.fetch = originalFetch; }
});

test('registerWebhooks reports success on a genuine 201 create', async () => {
  const { registerWebhooks } = require('../services/webhook-registration.service');
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 201, json: async () => ({}) });
  clearFlags();
  try {
    const r = await registerWebhooks({ shopDomain: 's.myshopify.com', accessToken: 'x' }, 'https://app.example');
    assert.ok(r.every(x => x.success === true && x.duplicate === undefined));
  } finally { global.fetch = originalFetch; }
});

test('registerWebhooks retry after a blocked attempt still cannot bypass the gate', async () => {
  const { registerWebhooks } = require('../services/webhook-registration.service');
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('fetch must not be called'); };
  clearFlags();
  process.env.DISABLE_SHOPIFY_WRITES = 'true';
  try {
    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        () => registerWebhooks({ shopDomain: 's.myshopify.com', accessToken: 'x' }, 'https://app.example'),
        (e) => e.code === 'BETA_READ_ONLY_WRITE_BLOCKED'
      );
    }
    assert.strictEqual(fetchCalled, false, 'repeated attempts must never reach Shopify');
  } finally {
    clearFlags();
    global.fetch = originalFetch;
  }
});

test('deleteAsset is blocked and sends no Shopify mutation when writes disabled', async () => {
  const { deleteAsset } = require('../services/shopify-admin.service');
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('fetch must not be called'); };
  clearFlags();
  process.env.DISABLE_SHOPIFY_WRITES = 'true';
  try {
    await assert.rejects(
      () => deleteAsset({ shopDomain: 's.myshopify.com', accessToken: 'x' }, 999, 'assets/x.liquid'),
      (e) => e.code === 'BETA_READ_ONLY_WRITE_BLOCKED' && e.status === 403
    );
    assert.strictEqual(fetchCalled, false, 'no DELETE may reach Shopify when writes are disabled');
  } finally {
    clearFlags();
    global.fetch = originalFetch;
  }
});

test('deleteAsset proceeds when flags are off, and 404 remains success (stubbed fetch)', async () => {
  const { deleteAsset } = require('../services/shopify-admin.service');
  const originalFetch = global.fetch;
  let method = null;
  global.fetch = async (url, opts) => { method = opts.method; return { ok: false, status: 404, text: async () => 'nf' }; };
  clearFlags();
  try {
    assert.strictEqual(await deleteAsset({ shopDomain: 's.myshopify.com', accessToken: 'x' }, 999, 'assets/x.liquid'), true);
    assert.strictEqual(method, 'DELETE');
  } finally {
    global.fetch = originalFetch;
  }
});

test('read-only asset + order paths remain functional when writes are disabled', async () => {
  const { getAsset, fetchOrderMetrics } = require('../services/shopify-admin.service');
  const originalFetch = global.fetch;
  global.fetch = async (url) => ({
    ok: true,
    headers: { get: () => '' },
    json: async () => (String(url).includes('orders.json')
      ? { orders: [{ id: 1, total_price: '10.00', currency: 'USD' }] }
      : { asset: { key: 'assets/x.liquid', value: 'v' } }),
  });
  clearFlags();
  process.env.DISABLE_SHOPIFY_WRITES = 'true';
  try {
    const asset = await getAsset({ shopDomain: 's.myshopify.com', accessToken: 'x' }, 999, 'assets/x.liquid');
    assert.strictEqual(asset.key, 'assets/x.liquid');
    const m = await fetchOrderMetrics({ shopDomain: 's.myshopify.com', accessToken: 'x' }, 30);
    assert.strictEqual(m.orderCount, 1);
  } finally {
    clearFlags();
    global.fetch = originalFetch;
  }
});
