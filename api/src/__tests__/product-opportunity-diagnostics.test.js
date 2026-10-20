'use strict';

// ---------------------------------------------------------------------------
// PR A — ProductOpportunityScore internal diagnostics behind a flag.
// Pure unit tests for the flag gate + adapter + diagnostics builder.
// No DB, no Shopify, no Anthropic, no network, no express.
//
// Run: node --test src/__tests__/product-opportunity-diagnostics.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const {
  FLAG,
  isDiagnosticsEnabled,
  toOpportunityInput,
  buildOpportunityDiagnostics,
} = require('../services/product-opportunity-input.adapter');

// A realistic-ish raw product + LLM-free actions + performance profile.
function rawCtx(over = {}) {
  return {
    rawProduct: {
      id: 'prod_1',
      status: 'active',
      updatedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      variants: [{ availableForSale: true }],
    },
    actions: [{ issueId: 'no_trust_bullets', severity: 'high', riskLevel: 'low' }],
    profile: { sessions: 800, atcRate: 0.02, refundRate: 0, dataGaps: [], archetype: 'standard' },
    ...over,
  };
}

// ── Flag gate ───────────────────────────────────────────────────────────────

test('flag OFF by default: diagnostics disabled when env unset', () => {
  assert.strictEqual(isDiagnosticsEnabled({}), false);
});

test('flag disabled for any value other than the exact string "true"', () => {
  for (const v of ['false', 'TRUE', '1', 'yes', '', undefined]) {
    assert.strictEqual(isDiagnosticsEnabled({ [FLAG]: v }), false, `value ${JSON.stringify(v)}`);
  }
});

test('flag enabled only when env value is exactly "true"', () => {
  assert.strictEqual(isDiagnosticsEnabled({ [FLAG]: 'true' }), true);
});

test('isDiagnosticsEnabled() with no arg does not throw (reads process.env)', () => {
  assert.doesNotThrow(() => isDiagnosticsEnabled());
});

// ── Adapter honesty: never invents baseline or leakStage ─────────────────────

test('adapter omits store baseline (no runtime source) and does not invent it', () => {
  const input = toOpportunityInput(rawCtx());
  assert.strictEqual(input.storeBaseline, undefined);
});

test('adapter maps eligibleIssues WITHOUT a fabricated leakStage', () => {
  const input = toOpportunityInput(rawCtx());
  assert.strictEqual(input.eligibleIssues.length, 1);
  assert.strictEqual(input.eligibleIssues[0].issueId, 'no_trust_bullets');
  assert.ok(!('leakStage' in input.eligibleIssues[0]), 'leakStage must not be synthesized');
});

test('adapter passes null product signals through instead of faking them', () => {
  const input = toOpportunityInput(rawCtx({
    profile: { sessions: null, atcRate: null, refundRate: null, dataGaps: ['sessions'] },
  }));
  assert.strictEqual(input.snapshot.productSessions, null);
  assert.strictEqual(input.profile.sessions, null);
  assert.deepStrictEqual(input.profile.dataGaps, ['sessions']);
});

test('adapter is null-safe and never throws on empty/garbage context', () => {
  assert.doesNotThrow(() => toOpportunityInput());
  assert.doesNotThrow(() => toOpportunityInput({}));
  assert.doesNotThrow(() => toOpportunityInput({ rawProduct: null, actions: null, profile: null }));
});

test('adapter does not mutate its input context', () => {
  const ctx = rawCtx();
  const snapshot = JSON.stringify(ctx);
  toOpportunityInput(ctx);
  assert.strictEqual(JSON.stringify(ctx), snapshot, 'adapter mutated its input');
});

// ── Diagnostics builder: shape, ranking, honesty ─────────────────────────────

test('flag ON: builder returns ranked diagnostics with the expected fields', () => {
  const out = buildOpportunityDiagnostics([
    rawCtx({ rawProduct: { id: 'low',  status: 'active', variants: [{ availableForSale: true }] },
             profile: { sessions: 60 } }),
    rawCtx({ rawProduct: { id: 'high', status: 'active', variants: [{ availableForSale: true }],
                           updatedAt: new Date(Date.now() - 30 * 86400000).toISOString() },
             profile: { sessions: 1500, atcRate: 0.02 } }),
  ]);

  assert.strictEqual(out.enabled, true);
  assert.strictEqual(out.count, 2);
  assert.ok(Array.isArray(out.products));

  // Ranked descending by opportunityScore (uses rankProductOpportunities).
  assert.ok(out.products[0].opportunityScore >= out.products[1].opportunityScore);

  // Each product exposes the internal diagnostic fields from the plan.
  for (const p of out.products) {
    for (const key of [
      'productId', 'opportunityScore', 'band', 'primaryLeak', 'excludedReason',
      'dataConfidence', 'recommendedFocus', 'subScores', 'estimatedRevenueUpside',
      'explanation', 'notes',
    ]) {
      assert.ok(key in p, `missing field ${key}`);
    }
  }
});

test('flag ON: builder honestly reports the two runtime data gaps', () => {
  const out = buildOpportunityDiagnostics([rawCtx()]);
  assert.strictEqual(out.dataGaps.noStoreBaseline, true);
  // Issues exist but none carry leakStage → gap flagged true.
  assert.strictEqual(out.dataGaps.noLeakStageMapping, true);
  assert.ok(/not.*merchant-facing/i.test(out.note));
});

test('missing data does not crash and does not produce fake confident ranking', () => {
  const out = buildOpportunityDiagnostics([
    { rawProduct: { id: 'a', status: 'active', variants: [] }, actions: [], profile: null },
    { rawProduct: { id: 'b' } },
  ]);
  assert.strictEqual(out.count, 2);
  for (const p of out.products) {
    // With no sessions/baseline, scores must not be confidently high.
    assert.strictEqual(p.opportunityScore, 0);
    assert.ok(['insufficient', 'weak'].includes(p.dataConfidence));
    assert.ok(p.notes.includes('no_store_baseline'));
  }
});

test('builder is null-safe on empty / non-array input', () => {
  assert.deepStrictEqual(buildOpportunityDiagnostics([]).products, []);
  assert.deepStrictEqual(buildOpportunityDiagnostics(null).products, []);
  assert.strictEqual(buildOpportunityDiagnostics(undefined).count, 0);
});

test('builder does not mutate its input contexts', () => {
  const contexts = [rawCtx(), rawCtx({ rawProduct: { id: 'prod_2', status: 'active', variants: [] } })];
  const snapshot = JSON.stringify(contexts);
  buildOpportunityDiagnostics(contexts);
  assert.strictEqual(JSON.stringify(contexts), snapshot, 'builder mutated its input');
});

// ── Store baseline → scoring wiring ─────────────────────────────────────────

const { toScoringBaseline } = require('../services/product-opportunity-input.adapter');
const { buildStoreBaseline } = require('../services/store-baseline.service');

function storeBaselineFixture(over = {}) {
  return {
    metrics: { storeConversionRate: 0.02, revenuePerSession: null, averageOrderValue: 40, atcToPurchaseRate: 0.2 },
    distribution: { medianAtcRate: 0.08 },
    reliability: { level: 'usable' },
    ...over,
  };
}

test('toScoringBaseline maps Store Baseline fields onto the scoring contract', () => {
  assert.deepStrictEqual(toScoringBaseline(storeBaselineFixture()), {
    storeCvr: 0.02, storeRpv: null, storeAtcRate: 0.08, storeAov: 40,
  });
});

test('toScoringBaseline returns null for absent, insufficient or empty baselines', () => {
  assert.strictEqual(toScoringBaseline(null), null);
  assert.strictEqual(toScoringBaseline(storeBaselineFixture({ reliability: { level: 'insufficient' } })), null);
  assert.strictEqual(toScoringBaseline({ metrics: {}, distribution: {}, reliability: { level: 'weak' } }), null);
});

test('adapter passes window orders and the AOV pair, never funnel revenue', () => {
  const input = toOpportunityInput(
    rawCtx({ profile: { sessions: 800, atcCount: 16, atcRate: 0.02, orderCount: 4 }, aovRevenue: 200, aovOrders: 5 }),
    toScoringBaseline(storeBaselineFixture()),
  );
  assert.strictEqual(input.snapshot.orderCount, 4);
  assert.strictEqual(input.snapshot.aovRevenue, 200);
  assert.strictEqual(input.snapshot.aovOrders, 5);
  assert.strictEqual(input.snapshot.revenue, undefined);
  assert.deepStrictEqual(input.storeBaseline, { storeCvr: 0.02, storeRpv: null, storeAtcRate: 0.08, storeAov: 40 });
});

test('builder with a baseline detects funnel leaks and ranks healthy products lower', () => {
  const ctxFor = (id, sessions, atcCount, orderCount) => rawCtx({
    rawProduct: { id, status: 'active', updatedAt: new Date(Date.now() - 30 * 86400000).toISOString(), variants: [{ availableForSale: true }] },
    profile: { sessions, atcCount, atcRate: atcCount / sessions, orderCount, dataGaps: [] },
  });
  const out = buildOpportunityDiagnostics(
    [ctxFor('tee', 900, 90, 30), ctxFor('hoodie', 1200, 24, 6), ctxFor('jacket', 800, 80, 2)],
    { storeBaseline: storeBaselineFixture({ distribution: { medianAtcRate: 0.1 } }) },
  );
  const by = Object.fromEntries(out.products.map((p) => [p.productId, p]));
  assert.strictEqual(out.dataGaps.noStoreBaseline, false);
  assert.strictEqual(by.hoodie.primaryLeak, 'low_view_to_atc');
  assert.strictEqual(by.jacket.primaryLeak, 'high_interest_low_purchase');
  assert.strictEqual(by.tee.primaryLeak, 'no_clear_leak');
  assert.deepStrictEqual(out.products.map((p) => p.productId).slice(0, 2).sort(), ['hoodie', 'jacket']);
  for (const p of out.products) {
    assert.strictEqual(p.estimatedRevenueUpside, null, 'no same-window revenue → no $ upside');
    assert.ok(!p.notes.includes('no_store_baseline'));
  }
  assert.strictEqual(out.dataGaps.noSameWindowRevenue, true);
});

test('builder with an insufficient baseline behaves exactly as without one', () => {
  const ctxs = [rawCtx()];
  const without = buildOpportunityDiagnostics(ctxs);
  const insufficient = buildOpportunityDiagnostics(ctxs, { storeBaseline: buildStoreBaseline({ products: [] }) });
  assert.strictEqual(insufficient.dataGaps.noStoreBaseline, true);
  assert.deepStrictEqual(insufficient.products, without.products);
});

// ── Real route: /action-center/opportunity-diagnostics (in-memory prisma) ────
// Invokes the actual express handler with a fake prisma. No DB, no Shopify,
// no network: fetch is replaced with a thrower for the duration of the test.

const SHOP_A = 'wiring-a.myshopify.com';
const SHOP_B = 'wiring-b.myshopify.com';

function routeFixture() {
  const old = new Date('2026-09-01T00:00:00Z');
  const product = (id, storeId, extra = {}) => ({
    id, storeId, shopifyProductId: 'sp_' + id, title: id, handle: id, status: 'active', vendor: 'Acme',
    productType: 'Apparel', tags: '', bodyHtml: '<p>' + 'Soft breathable cotton for everyday wear. '.repeat(12) + '</p>',
    publishedAt: old, createdAt: old, updatedAt: old,
    variants: [{ id: id + 'v', shopifyVariantId: 'g' + id, title: 'Default', sku: id, price: '40.00', compareAtPrice: null, inventoryQuantity: 5, availableForSale: true }],
    images: [{ id: id + 'i', src: 'x.jpg', altText: id, position: 1 }],
    ...extra,
  });
  const profile = (productId, sessions, atcCount, orderCount) => ({
    productId, storeId: 'st_a', capturedAt: new Date('2026-10-19T00:00:00Z'), windowDays: 28,
    sessions, atcCount, atcRate: sessions ? atcCount / sessions : null, orderCount,
    refundRate: null, archetype: 'unknown', dataGaps: sessions == null ? ['no_sessions'] : [],
  });
  return {
    stores: [
      { id: 'st_a', shopDomain: SHOP_A, accessToken: 'fake', isActive: true },
      { id: 'st_b', shopDomain: SHOP_B, accessToken: 'fake', isActive: true },
    ],
    products: [
      product('hoodie', 'st_a'), product('tee', 'st_a'), product('jacket', 'st_a'),
      product('mug', 'st_a'), product('sock', 'st_a'), product('b_secret', 'st_b'),
    ],
    profiles: [
      profile('hoodie', 1200, 24, 6), profile('tee', 900, 90, 30), profile('jacket', 800, 80, 2),
      profile('mug', 20, 2, 1), profile('sock', null, null, 12),
      { ...profile('b_secret', 5000, 1, 1), storeId: 'st_b' },
    ],
    snapshots: [
      ['hoodie', 480, 6], ['tee', 900, 30], ['jacket', 240, 2], ['mug', 15, 1], ['sock', 120, 12], ['b_secret', 99999, 1],
    ].map(([productId, revenue, orderCount]) => ({ productId, revenue, orderCount, unitsSold: orderCount, snapshotDate: new Date('2026-10-19'), phase: 'standalone' })),
  };
}

function fakePrisma(fx) {
  return {
    store: { findUnique: async ({ where }) => fx.stores.find((s) => s.shopDomain === where.shopDomain) || null },
    product: { findMany: async ({ where }) => fx.products.filter((p) => p.storeId === where.storeId) },
    productPerformanceProfile: { findFirst: async ({ where }) => fx.profiles.find((p) => p.productId === where.productId) || null },
    productMetricsSnapshot: { findMany: async ({ where }) => fx.snapshots.filter((s) => where.productId.in.includes(s.productId)) },
    actionItem: { findMany: async () => [] },
  };
}

async function callDiagnosticsRoute(shop, session = {}) {
  const router = require('../routes/action-center.routes');
  const layer = router.stack.find((l) => l.route && l.route.path === '/opportunity-diagnostics');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const prisma = fakePrisma(routeFixture());
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler({ query: { shop }, session, app: { get: () => prisma } }, res)).catch(reject);
  });
}

async function withDiagnosticsEnv(fn) {
  const saved = {
    flag: process.env.PRODUCT_OPPORTUNITY_DIAGNOSTICS,
    allow: process.env.DIAGNOSTICS_STORE_ALLOWLIST,
    fetch: globalThis.fetch,
  };
  process.env.PRODUCT_OPPORTUNITY_DIAGNOSTICS = 'true';
  process.env.DIAGNOSTICS_STORE_ALLOWLIST = `${SHOP_A},${SHOP_B}`;
  let netCalls = 0;
  globalThis.fetch = async () => { netCalls++; throw new Error('network disabled in test'); };
  try {
    return await fn(() => netCalls);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.flag === undefined) delete process.env.PRODUCT_OPPORTUNITY_DIAGNOSTICS; else process.env.PRODUCT_OPPORTUNITY_DIAGNOSTICS = saved.flag;
    if (saved.allow === undefined) delete process.env.DIAGNOSTICS_STORE_ALLOWLIST; else process.env.DIAGNOSTICS_STORE_ALLOWLIST = saved.allow;
  }
}

test('route: baseline reaches scoring and the real handler ranks leaks above healthy products', async () => {
  await withDiagnosticsEnv(async (netCalls) => {
    const { status, body } = await callDiagnosticsRoute(SHOP_A);
    assert.strictEqual(status, 200);
    const by = Object.fromEntries(body.products.map((p) => [p.productId, p]));

    assert.strictEqual(body.dataGaps.noStoreBaseline, false);
    assert.strictEqual(by.hoodie.primaryLeak, 'low_view_to_atc');
    assert.strictEqual(by.jacket.primaryLeak, 'high_interest_low_purchase');
    assert.strictEqual(by.tee.primaryLeak, 'no_clear_leak');
    assert.deepStrictEqual(body.products.slice(0, 2).map((p) => p.productId).sort(), ['hoodie', 'jacket']);
    assert.ok(by.tee.opportunityScore < by.jacket.opportunityScore);

    // Missing / thin data stays honest.
    assert.strictEqual(by.sock.opportunityScore, 0);
    assert.strictEqual(by.sock.dataConfidence, 'insufficient');
    assert.strictEqual(by.mug.opportunityScore, 0);
    assert.strictEqual(by.mug.primaryLeak, 'insufficient_data');

    // No invented revenue; no cross-store leakage; no network.
    for (const p of body.products) assert.strictEqual(p.estimatedRevenueUpside, null);
    assert.ok(!JSON.stringify(body).includes('b_secret'));
    assert.strictEqual(netCalls(), 0);

    // Store CVR excludes the sock's 12 orders (no sessions): 39 / 2920.
    assert.strictEqual(body.storeBaseline.metrics.storeConversionRate, 0.0134);
    assert.strictEqual(body.storeBaseline.distribution.medianAtcRate, 0.1);
    assert.strictEqual(body.storeBaseline.metrics.averageOrderValue, 34.41); // 1755 / 51 (AOV pair)
  });
});

test('route: enrollment and ownership gates are unchanged', async () => {
  await withDiagnosticsEnv(async () => {
    const crossStore = await callDiagnosticsRoute(SHOP_A, { storeId: 'st_b' });
    assert.strictEqual(crossStore.status, 403);
    process.env.DIAGNOSTICS_STORE_ALLOWLIST = SHOP_B;
    const notEnrolled = await callDiagnosticsRoute(SHOP_A);
    assert.strictEqual(notEnrolled.status, 404);
  });
});
