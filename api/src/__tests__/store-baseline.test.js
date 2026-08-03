'use strict';

// ---------------------------------------------------------------------------
// Store Baseline Engine — Option A pure helper tests.
// No DB / Shopify / Anthropic / network — pure aggregation over given rows.
//
// Run: node --test src/__tests__/store-baseline.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const {
  buildStoreBaseline,
  computeRate,
  classifyBaselineReliability,
  DEFAULT_THRESHOLDS,
} = require('../services/store-baseline.service');

const NOW = '2026-08-04T00:00:00.000Z';

function baseInput(over = {}) {
  return {
    shop: 'demo.myshopify.com',
    timeWindow: { start: '2026-07-07', end: '2026-08-04', days: 28 },
    now: NOW,
    sources: ['performance_profile'],
    products: [
      { sessions: 1000, productViews: 1000, atc: 80, orders: 30, revenue: 1500 },
      { sessions: 800,  productViews: 800,  atc: 40, orders: 16, revenue: 640 },
      { sessions: 600,  productViews: 600,  atc: 30, orders: 12, revenue: 600 },
      { sessions: 400,  productViews: 400,  atc: 12, orders: 4,  revenue: 200 },
    ],
    ...over,
  };
}

// ── computeRate primitive ────────────────────────────────────────────────────

test('computeRate: zero/absent denominator returns null (no NaN/Infinity)', () => {
  assert.strictEqual(computeRate(10, 0), null);
  assert.strictEqual(computeRate(10, null), null);
  assert.strictEqual(computeRate(null, 100), null);
  assert.strictEqual(computeRate(10, undefined), null);
  const r = computeRate(30, 1000);
  assert.ok(Number.isFinite(r));
  assert.strictEqual(r, 0.03);
});

// ── Happy path ───────────────────────────────────────────────────────────────

test('happy path: full data → all metrics present, reliability good', () => {
  const b = buildStoreBaseline(baseInput());
  // AOV = 2940 / 62 = 47.42
  assert.strictEqual(b.metrics.averageOrderValue, 47.42);
  // CVR = 62 / 2800
  assert.strictEqual(b.metrics.storeConversionRate, computeRate(62, 2800));
  // view→ATC = 162 / 2800
  assert.strictEqual(b.metrics.productViewToAtcRate, computeRate(162, 2800));
  // ATC→purchase = 62 / 162
  assert.strictEqual(b.metrics.atcToPurchaseRate, computeRate(62, 162));
  assert.ok(b.metrics.revenuePerSession > 0);
  assert.ok(b.metrics.revenuePerProductView > 0);
  assert.strictEqual(b.reliability.level, 'good');
  assert.deepStrictEqual(b.reliability.missingData, []);
  assert.deepStrictEqual(b.reliability.sourcesUsed, ['performance_profile']);
  assert.strictEqual(b.reliability.confoundersKnown, false);
  assert.strictEqual(b.generatedAt, NOW);
});

// ── Missing revenue: AOV/RPV null, but CVR/funnel still present ───────────────

test('no revenue → AOV/RPV null + missingData, but CVR/funnel computable', () => {
  const b = buildStoreBaseline(baseInput({
    products: baseInput().products.map((p) => ({ ...p, revenue: null })),
  }));
  assert.strictEqual(b.metrics.averageOrderValue, null);
  assert.strictEqual(b.metrics.revenuePerSession, null);
  assert.strictEqual(b.metrics.revenuePerProductView, null);
  // Funnel/CVR still available from sessions/atc/orders.
  assert.ok(b.metrics.storeConversionRate > 0);
  assert.ok(b.metrics.atcToPurchaseRate > 0);
  assert.ok(b.reliability.missingData.includes('revenue'));
  assert.ok(['usable', 'weak'].includes(b.reliability.level));
  assert.notStrictEqual(b.reliability.level, 'good');
});

// ── Missing session/view denominator: rates null, AOV survives ───────────────

test('no sessions/views → CVR/RPV/view→ATC null, AOV still available', () => {
  const b = buildStoreBaseline(baseInput({
    products: baseInput().products.map((p) => ({
      sessions: null, productViews: null, atc: null, orders: p.orders, revenue: p.revenue,
    })),
  }));
  assert.strictEqual(b.metrics.storeConversionRate, null);
  assert.strictEqual(b.metrics.revenuePerSession, null);
  assert.strictEqual(b.metrics.revenuePerProductView, null);
  assert.strictEqual(b.metrics.productViewToAtcRate, null);
  assert.strictEqual(b.metrics.atcToPurchaseRate, null);
  // AOV = revenue / orders still works.
  assert.ok(b.metrics.averageOrderValue > 0);
  for (const k of ['sessions', 'productViews', 'atc']) {
    assert.ok(b.reliability.missingData.includes(k), `missingData should include ${k}`);
  }
});

// ── Zero denominators: no throw / NaN / Infinity ─────────────────────────────

test('zero denominators are safe (no throw, no NaN/Infinity)', () => {
  const b = buildStoreBaseline({
    shop: 's', now: NOW,
    products: [{ sessions: 0, productViews: 0, atc: 0, orders: 0, revenue: 0 }],
  });
  for (const v of Object.values(b.metrics)) {
    assert.ok(v === null || Number.isFinite(v), `metric ${v} must be null or finite`);
  }
  assert.strictEqual(b.reliability.level, 'insufficient');
});

// ── Insufficient sample ──────────────────────────────────────────────────────

test('too few products with data → insufficient with clear reasons', () => {
  const b = buildStoreBaseline(baseInput({
    products: [{ sessions: 20, productViews: 20, atc: 1, orders: 0, revenue: 0 }],
  }));
  assert.strictEqual(b.reliability.level, 'insufficient');
  assert.ok(b.reliability.reasons.length > 0);
  assert.ok(b.reliability.reasons.some((r) => /minProductsWithData/.test(r)));
});

// ── Outlier / traffic-weighting determinism + no mutation ────────────────────

test('outlier product: traffic-weighted store metrics + deterministic + no mutation', () => {
  const input = baseInput({
    products: [
      { sessions: 100000, productViews: 100000, atc: 5000, orders: 3000, revenue: 150000 }, // whale
      { sessions: 50, productViews: 50, atc: 1, orders: 0, revenue: 0 },
      { sessions: 60, productViews: 60, atc: 2, orders: 1, revenue: 40 },
    ],
  });
  const snapshot = JSON.stringify(input);
  const a = buildStoreBaseline(input);
  const b = buildStoreBaseline(input);
  assert.deepStrictEqual(a, b, 'output must be deterministic for fixed now');
  assert.strictEqual(JSON.stringify(input), snapshot, 'input must not be mutated');
  // Store CVR is dominated by the whale (traffic-weighted), not an equal-weight average.
  assert.strictEqual(a.metrics.storeConversionRate, computeRate(3001, 100110));
  assert.strictEqual(a.distribution.trafficWeighted, true);
});

// ── Empty input ──────────────────────────────────────────────────────────────

test('empty / missing products → safe baseline, reliability insufficient', () => {
  assert.doesNotThrow(() => buildStoreBaseline());
  assert.doesNotThrow(() => buildStoreBaseline({}));
  const b = buildStoreBaseline({ shop: 's', now: NOW, products: [] });
  assert.strictEqual(b.reliability.level, 'insufficient');
  assert.strictEqual(b.sampleSize.products, 0);
  for (const v of Object.values(b.metrics)) assert.strictEqual(v, null);
});

// ── Determinism of generatedAt injection ─────────────────────────────────────

test('generatedAt is the injected now; omitting it does not throw', () => {
  assert.strictEqual(buildStoreBaseline(baseInput()).generatedAt, NOW);
  assert.doesNotThrow(() => buildStoreBaseline({ ...baseInput(), now: undefined }));
});

// ── sources default ──────────────────────────────────────────────────────────

test('sourcesUsed defaults to [] when caller declares none', () => {
  const b = buildStoreBaseline({ shop: 's', now: NOW, products: baseInput().products });
  assert.deepStrictEqual(b.reliability.sourcesUsed, []);
});

// ── classify unit ────────────────────────────────────────────────────────────

test('classifyBaselineReliability lists every absent raw input in missingData', () => {
  const r = classifyBaselineReliability({
    sums: { sessions: null, productViews: null, atc: null, orders: null, revenue: null },
    sampleSize: { productsWithData: 0 },
    thresholds: DEFAULT_THRESHOLDS,
    timeWindow: null,
  });
  assert.strictEqual(r.level, 'insufficient');
  for (const k of ['sessions', 'productViews', 'atc', 'orders', 'revenue']) {
    assert.ok(r.missingData.includes(k));
  }
});
