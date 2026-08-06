'use strict';

// ---------------------------------------------------------------------------
// Snapshot AOV feed — pure assembly + dedicated-AOV-pair tests.
// No DB / Shopify / Anthropic / network / Express. Verifies that snapshot
// revenue/orders unlock AOV ONLY, without contaminating the funnel window.
//
// Run: node --test src/__tests__/store-baseline-assembly.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const {
  buildStoreBaseline,
  assembleStoreBaselineRows,
  coerceNonNegativeNumber,
  selectLatestSnapshotsByProductId,
} = require('../services/store-baseline.service');

// A minimal Prisma-Decimal-like object (only toString, like Prisma.Decimal).
function decimalLike(str) {
  return { toString() { return String(str); } };
}

const NOW = '2026-08-06T00:00:00.000Z';

function ctx(productId, profile) {
  return { rawProduct: { id: productId }, actions: [], profile: profile || null };
}
function snap(productId, over = {}) {
  return {
    productId,
    revenue: 1000,
    orderCount: 20,
    unitsSold: 25,
    snapshotDate: '2026-08-01T00:00:00.000Z',
    ...over,
  };
}

// ── coerceNonNegativeNumber ──────────────────────────────────────────────────

test('coerceNonNegativeNumber handles number/string/Decimal/bigint/null/invalid', () => {
  assert.strictEqual(coerceNonNegativeNumber(1500), 1500);
  assert.strictEqual(coerceNonNegativeNumber('1500'), 1500);
  assert.strictEqual(coerceNonNegativeNumber('1500.50'), 1500.5);
  assert.strictEqual(coerceNonNegativeNumber(decimalLike('2999.99')), 2999.99);
  assert.strictEqual(coerceNonNegativeNumber(10n), 10);
  assert.strictEqual(coerceNonNegativeNumber(null), null);
  assert.strictEqual(coerceNonNegativeNumber(undefined), null);
  assert.strictEqual(coerceNonNegativeNumber('abc'), null);      // invalid string
  assert.strictEqual(coerceNonNegativeNumber(''), null);         // empty string
  assert.strictEqual(coerceNonNegativeNumber(-5), null);         // negative
  assert.strictEqual(coerceNonNegativeNumber('-5'), null);       // negative string
  assert.strictEqual(coerceNonNegativeNumber(NaN), null);
  assert.strictEqual(coerceNonNegativeNumber(Infinity), null);
});

// ── selectLatestSnapshotsByProductId ─────────────────────────────────────────

test('latest snapshot wins by snapshotDate; ties keep first-seen deterministically', () => {
  const rows = [
    snap('p1', { snapshotDate: '2026-07-01T00:00:00.000Z', revenue: 100 }),
    snap('p1', { snapshotDate: '2026-08-05T00:00:00.000Z', revenue: 999 }), // latest
    snap('p1', { snapshotDate: '2026-07-15T00:00:00.000Z', revenue: 500 }),
  ];
  const map = selectLatestSnapshotsByProductId(rows);
  assert.strictEqual(map.get('p1').revenue, 999);

  // Tie → first-seen wins (stable/deterministic).
  const tie = [
    snap('p2', { snapshotDate: '2026-08-01T00:00:00.000Z', revenue: 1 }),
    snap('p2', { snapshotDate: '2026-08-01T00:00:00.000Z', revenue: 2 }),
  ];
  assert.strictEqual(selectLatestSnapshotsByProductId(tie).get('p2').revenue, 1);
  assert.deepStrictEqual([...selectLatestSnapshotsByProductId(null).keys()], []);
});

// ── assembleStoreBaselineRows: AOV pair separate from funnel ─────────────────

test('assembly puts snapshot revenue/orders into AOV pair, profile into funnel', () => {
  const contexts = [ctx('p1', { sessions: 800, atcCount: 40, orderCount: 16, windowDays: 28 })];
  const snapshots = [snap('p1', { revenue: 2000, orderCount: 25 })];
  const rows = assembleStoreBaselineRows(contexts, snapshots);
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  // funnel from profile
  assert.strictEqual(r.sessions, 800);
  assert.strictEqual(r.atc, 40);
  assert.strictEqual(r.orders, 16);          // profile funnel orders, NOT snapshot 25
  // AOV pair from snapshot
  assert.strictEqual(r.aovRevenue, 2000);
  assert.strictEqual(r.aovOrders, 25);
  assert.strictEqual(r.productViews, null);  // deferred
  assert.strictEqual(r.sourceFlags.hasSnapshotRevenue, true);
  assert.strictEqual(r.sourceFlags.hasPdpEvents, false);
});

test('assembly does not mutate inputs', () => {
  const contexts = [ctx('p1', { sessions: 800, atcCount: 40, orderCount: 16 })];
  const snapshots = [snap('p1')];
  const snap1 = JSON.stringify(contexts), snap2 = JSON.stringify(snapshots);
  assembleStoreBaselineRows(contexts, snapshots);
  assert.strictEqual(JSON.stringify(contexts), snap1);
  assert.strictEqual(JSON.stringify(snapshots), snap2);
});

test('assembly is null-safe (no contexts / no snapshots)', () => {
  assert.deepStrictEqual(assembleStoreBaselineRows(null, null), []);
  const rows = assembleStoreBaselineRows([ctx('p1', null)], []);
  assert.strictEqual(rows[0].aovRevenue, null);
  assert.strictEqual(rows[0].sessions, null);
});

// ── buildStoreBaseline: AOV from dedicated pair, funnel untouched ────────────

function build(rows) {
  return buildStoreBaseline({ shop: 's', now: NOW, sources: ['performance_profile', 'metrics_snapshot'], products: rows });
}

test('snapshot AOV pair unlocks averageOrderValue', () => {
  const rows = assembleStoreBaselineRows(
    [ctx('p1', { sessions: 800, atcCount: 40, orderCount: 16 })],
    [snap('p1', { revenue: 2000, orderCount: 25 })]
  );
  const b = build(rows);
  assert.strictEqual(b.metrics.averageOrderValue, 80); // 2000 / 25
});

test('missing snapshot → AOV null + missingData, funnel still computed', () => {
  const rows = assembleStoreBaselineRows(
    [ctx('p1', { sessions: 800, atcCount: 40, orderCount: 16 })],
    [] // no snapshot
  );
  const b = build(rows);
  assert.strictEqual(b.metrics.averageOrderValue, null);
  assert.ok(b.reliability.missingData.includes('aov_revenue'));
  // funnel window metrics still present from profile
  assert.ok(b.metrics.storeConversionRate > 0);
  assert.ok(b.metrics.atcToPurchaseRate > 0);
});

test('null / zero / one-sided revenue-orders never fabricate AOV or NaN/Infinity', () => {
  const mk = (over) => build(assembleStoreBaselineRows([ctx('p1', { sessions: 800, atcCount: 40, orderCount: 16 })], [snap('p1', over)]));
  assert.strictEqual(mk({ revenue: null }).metrics.averageOrderValue, null);          // null revenue
  assert.strictEqual(mk({ orderCount: 0 }).metrics.averageOrderValue, null);          // zero orders
  assert.strictEqual(mk({ revenue: 500, orderCount: 0 }).metrics.averageOrderValue, null); // revenue w/o orders → null (zero denom)
  // revenue 0 with real orders is valid data → AOV 0 (not fabricated, not null).
  assert.strictEqual(mk({ revenue: 0, orderCount: 10 }).metrics.averageOrderValue, 0);
  assert.strictEqual(mk({ revenue: 'garbage' }).metrics.averageOrderValue, null);     // invalid
  assert.strictEqual(mk({ revenue: -100 }).metrics.averageOrderValue, null);          // negative
  for (const v of Object.values(mk({ orderCount: 0 }).metrics)) {
    assert.ok(v === null || Number.isFinite(v));
  }
});

test('Decimal-like and numeric-string revenue coerce into AOV', () => {
  const b = build(assembleStoreBaselineRows(
    [ctx('p1', { sessions: 800, atcCount: 40, orderCount: 16 })],
    [snap('p1', { revenue: decimalLike('3000.00'), orderCount: '15' })]
  ));
  assert.strictEqual(b.metrics.averageOrderValue, 200); // 3000 / 15
});

// ── The window-safety guarantees ─────────────────────────────────────────────

test('snapshot orders do NOT replace profile funnel orders (CVR/ATC use profile)', () => {
  // profile: sessions 1000, atc 50, orders 20  → CVR 0.02, atc→purchase 0.4
  // snapshot: cumulative orders 9999 (must NOT affect CVR/ATC→purchase)
  const rows = assembleStoreBaselineRows(
    [ctx('p1', { sessions: 1000, atcCount: 50, orderCount: 20 })],
    [snap('p1', { revenue: 4000, orderCount: 9999 })]
  );
  const b = build(rows);
  assert.strictEqual(b.metrics.storeConversionRate, 0.02);   // 20 / 1000 (profile orders)
  assert.strictEqual(b.metrics.atcToPurchaseRate, 0.4);      // 20 / 50 (profile orders)
  assert.strictEqual(b.metrics.averageOrderValue, 0.4);      // 4000 / 9999 (snapshot pair)
});

test('cumulative snapshot revenue does NOT create revenuePerSession/revenuePerProductView', () => {
  const rows = assembleStoreBaselineRows(
    [ctx('p1', { sessions: 1000, atcCount: 50, orderCount: 20 })],
    [snap('p1', { revenue: 5000, orderCount: 25 })]
  );
  const b = build(rows);
  assert.strictEqual(b.metrics.revenuePerSession, null);      // snapshot revenue not window-matched to sessions
  assert.strictEqual(b.metrics.revenuePerProductView, null);  // productViews null
  assert.strictEqual(b.metrics.productViewToAtcRate, null);   // no raw views
  assert.strictEqual(b.metrics.averageOrderValue, 200);       // AOV still unlocked
});
