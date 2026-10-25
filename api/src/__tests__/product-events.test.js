'use strict';

// ---------------------------------------------------------------------------
// Web Pixel product events → normalized facts → product funnel → scoring.
// Pure unit tests: no DB, no Shopify, no network, synthetic events only.
//
// Run: node --test src/__tests__/product-events.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const {
  normalizeProductEvents,
  aggregateProductEvents,
  toScoringFunnels,
  parseShopifyId,
} = require('../services/product-events.service');
const { buildStoreBaseline, assembleStoreBaselineRows } = require('../services/store-baseline.service');
const { buildOpportunityDiagnostics } = require('../services/product-opportunity-input.adapter');

const SHOP = 'events-a.myshopify.com';
const STORE = {
  storeId: 'st_a',
  shopDomain: SHOP,
  active: true,
  products: {
    101: { productId: 'hoodie', variantIds: ['1011', '1012'] },
    102: { productId: 'tee', variantIds: ['1021'] },
    103: { productId: 'jacket', variantIds: ['1031'] },
  },
};
const WINDOW = {
  storeId: 'st_a',
  windowStart: '2026-09-24T00:00:00Z',
  windowEnd: '2026-10-22T00:00:00Z',
  collectionStartedAt: '2026-09-01T00:00:00Z',
};
const AT = '2026-10-10T12:00:00.000Z';

let seq = 0;
function env(name, data, over = {}) {
  seq += 1;
  return {
    shop: SHOP,
    receivedAt: over.receivedAt || AT,
    visitorKey: over.visitorKey ?? 'vk_1',
    analyticsAllowed: over.analyticsAllowed ?? true,
    event: { id: over.id || `ev_${seq}`, name, timestamp: over.timestamp || AT, clientId: 'raw-client-id-secret', data },
    ...(over.shop ? { shop: over.shop } : {}),
  };
}
const viewed = (productId, variantId, over) =>
  env('product_viewed', { productVariant: { id: variantId, product: { id: productId } } }, over);
const added = (productId, variantId, quantity = 1, over) =>
  env('product_added_to_cart', { cartLine: { quantity, merchandise: { id: variantId, product: { id: productId } } } }, over);
const completed = (orderId, lines, over, token = null) =>
  env('checkout_completed', {
    checkout: {
      token,
      order: { id: orderId },
      lineItems: lines.map(([productId, variantId, quantity = 1]) => ({ quantity, variant: { id: variantId, product: { id: productId } } })),
    },
  }, over);

const reasons = (out) => out.rejected.map((r) => r.reason);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// ── Identity parsing ────────────────────────────────────────────────────────

test('parseShopifyId accepts numeric ids and gids of the expected type only', () => {
  assert.deepStrictEqual(parseShopifyId('gid://shopify/Product/101', ['Product']), { id: '101' });
  assert.deepStrictEqual(parseShopifyId('101', ['Product']), { id: '101' });
  assert.deepStrictEqual(parseShopifyId(101, ['Product']), { id: '101' });
  assert.deepStrictEqual(parseShopifyId('gid://shopify/Collection/101', ['Product']), { invalid: true });
  assert.deepStrictEqual(parseShopifyId('gid://shopify/Product/101?x=1', ['Product']), { invalid: true });
  assert.deepStrictEqual(parseShopifyId('0', ['Product']), { invalid: true });
  assert.deepStrictEqual(parseShopifyId(null, ['Product']), { missing: true });
});

// ── 1. Duplicates ───────────────────────────────────────────────────────────

test('a retried event id is counted once', () => {
  const e = viewed('gid://shopify/Product/101', 'gid://shopify/ProductVariant/1011', { id: 'same' });
  const out = normalizeProductEvents([e, { ...e }, { ...e }], STORE);
  assert.strictEqual(out.facts.length, 1);
  assert.strictEqual(out.stats.duplicates, 2);
  assert.deepStrictEqual(reasons(out), ['duplicate_event', 'duplicate_event']);
});

test('repeated checkout_completed for one order yields one purchase per product', () => {
  const lines = [['101', '1011', 1], ['101', '1012', 2], ['102', '1021', 1]];
  const out = normalizeProductEvents([
    completed('gid://shopify/Order/9001', lines),
    completed('gid://shopify/Order/9001', lines), // thank-you page reload: new event id
    completed('9001', lines),
  ], STORE);
  const purchases = out.facts.filter((f) => f.kind === 'purchase');
  assert.strictEqual(purchases.length, 2, 'hoodie + tee, once each');
  assert.strictEqual(purchases.find((f) => f.productId === 'hoodie').quantity, 3, 'two hoodie lines summed');
  assert.deepStrictEqual(reasons(out), ['duplicate_order', 'duplicate_order']);
});

test('checkout without an order id dedupes on its token', () => {
  const out = normalizeProductEvents([
    completed(null, [['101', '1011']], {}, 'tok_1'),
    completed(null, [['101', '1011']], {}, 'tok_1'),
  ], STORE);
  assert.strictEqual(out.facts.length, 1);
  assert.strictEqual(out.facts[0].orderRef, 'token:tok_1');
});

// ── 2. Store isolation ──────────────────────────────────────────────────────

test('events for another shop or an inactive store are rejected', () => {
  const foreign = normalizeProductEvents([viewed('101', null, { shop: 'events-b.myshopify.com' })], STORE);
  assert.deepStrictEqual(reasons(foreign), ['store_mismatch']);
  const inactive = normalizeProductEvents([viewed('101', null)], { ...STORE, active: false });
  assert.deepStrictEqual(reasons(inactive), ['store_inactive']);
});

test('aggregation ignores facts that belong to another store', () => {
  const { facts } = normalizeProductEvents([viewed('101', null)], STORE);
  const leaked = facts.map((f) => ({ ...f, storeId: 'st_b' }));
  const agg = aggregateProductEvents([...facts, ...leaked], WINDOW);
  assert.strictEqual(agg.excluded.foreignStore, 1);
  assert.strictEqual(agg.products.length, 1);
  assert.strictEqual(agg.products[0].viewDays, 1);
});

test('storeContext without storeId or shopDomain is a programming error', () => {
  assert.throws(() => normalizeProductEvents([], { shopDomain: SHOP }), TypeError);
  assert.throws(() => aggregateProductEvents([], { windowStart: WINDOW.windowStart, windowEnd: WINDOW.windowEnd }), TypeError);
});

// ── 3. Invalid / unknown products ───────────────────────────────────────────

test('unknown, malformed and mismatched product identities are rejected', () => {
  const out = normalizeProductEvents([
    viewed('999', null),                                  // not in this store
    viewed('gid://shopify/Collection/101', null),         // wrong gid type
    viewed(null, null),                                   // missing
    viewed('101', '1021'),                                // tee's variant on hoodie
    viewed('101', 'gid://shopify/Product/1011'),          // variant field holds a product gid
    env('product_added_to_cart', { cartLine: null }),
    added('101', '1011', 0),
    added('101', '1011', 1.5),
  ], STORE);
  assert.strictEqual(out.facts.length, 0);
  assert.deepStrictEqual(reasons(out), [
    'unknown_product', 'invalid_product_id', 'missing_product_id', 'variant_product_mismatch',
    'invalid_variant_id', 'missing_cart_line', 'invalid_quantity', 'invalid_quantity',
  ]);
});

test('a checkout keeps known lines and reports unknown ones per line', () => {
  const out = normalizeProductEvents([completed('9002', [['101', '1011'], ['555', '5551']])], STORE);
  assert.strictEqual(out.facts.length, 1);
  assert.deepStrictEqual(out.rejected, [{ eventId: out.rejected[0].eventId, reason: 'unknown_product', line: 1 }]);
});

test('unsupported events, missing ids and malformed envelopes are rejected', () => {
  const out = normalizeProductEvents([
    env('page_viewed', {}),
    { ...viewed('101', null), event: { ...viewed('101', null).event, id: '' } },
    null,
    { shop: SHOP },
    viewed('101', null, { visitorKey: '' }),
    completed(null, [['101', '1011']]),
    env('checkout_completed', {}),
    env('checkout_completed', { checkout: { order: { id: '9003' }, lineItems: [] } }),
  ], STORE);
  assert.deepStrictEqual(reasons(out), [
    'unsupported_event', 'missing_event_id', 'malformed_envelope', 'malformed_envelope',
    'missing_visitor_key', 'missing_order_ref', 'missing_checkout', 'missing_line_items',
  ]);
});

// ── 4. Time window and replay ───────────────────────────────────────────────

test('events outside the window are excluded and skewed timestamps rejected', () => {
  const norm = normalizeProductEvents([
    viewed('101', null, { timestamp: '2026-09-23T23:59:59Z', receivedAt: '2026-09-24T00:00:10Z' }), // before start
    viewed('101', null, { timestamp: '2026-10-22T00:00:00Z', receivedAt: '2026-10-22T00:00:01Z' }), // end is exclusive
    viewed('101', null, { visitorKey: 'vk_2' }),
    viewed('101', null, { timestamp: '2026-10-10T12:10:00Z' }),  // 10 min in the future
    viewed('101', null, { timestamp: '2026-10-06T12:00:00Z' }),  // 4 days before receipt
    viewed('101', null, { timestamp: 'not-a-date' }),
  ], STORE);
  assert.deepStrictEqual(reasons(norm), ['timestamp_in_future', 'timestamp_too_old', 'invalid_timestamp']);
  const agg = aggregateProductEvents(norm.facts, WINDOW);
  assert.strictEqual(agg.excluded.outOfWindow, 2);
  assert.strictEqual(agg.products[0].viewDays, 1);
});

test('an inverted or missing window is a programming error', () => {
  assert.throws(() => aggregateProductEvents([], { ...WINDOW, windowEnd: WINDOW.windowStart }), TypeError);
  assert.throws(() => aggregateProductEvents([], { ...WINDOW, windowStart: null }), TypeError);
});

// ── 5. Units and populations ────────────────────────────────────────────────

test('viewer-days collapse repeat views; ATC and purchases count only within viewers', () => {
  const day2 = { timestamp: '2026-10-11T12:00:00Z', receivedAt: '2026-10-11T12:00:01Z' };
  const norm = normalizeProductEvents([
    viewed('101', null, { visitorKey: 'a' }),
    viewed('101', null, { visitorKey: 'a' }),            // same viewer-day
    viewed('101', null, { visitorKey: 'a', ...day2 }),   // new viewer-day
    viewed('101', null, { visitorKey: 'b' }),
    added('101', '1011', 1, { visitorKey: 'a' }),
    added('101', '1011', 1, { visitorKey: 'a' }),        // second ATC same viewer-day
    added('101', '1011', 1, { visitorKey: 'c' }),        // quick-add, never viewed
    completed('9010', [['101', '1011']], { visitorKey: 'a' }),
    completed('9011', [['101', '1011']], { visitorKey: 'd' }), // bought without a view
  ], STORE);
  const agg = aggregateProductEvents(norm.facts, WINDOW);
  const [hoodie] = agg.products;
  // Scoring sees viewer-day purchases (1), never all observed orders (2).
  assert.deepStrictEqual(toScoringFunnels(agg)[0].funnel, { sessions: 3, atcCount: 1, atcRate: round(1 / 3), orderCount: 1 });
  assert.strictEqual(hoodie.viewDays, 3);
  assert.strictEqual(hoodie.atcDays, 1);
  assert.strictEqual(hoodie.atcWithoutViewDays, 1);
  assert.strictEqual(hoodie.purchaseDays, 1);
  assert.strictEqual(hoodie.purchaseWithoutViewDays, 1);
  assert.strictEqual(hoodie.checkoutOrders, 2, 'all observed orders, reported separately');
  assert.strictEqual(hoodie.atcRate, round(1 / 3));
  assert.deepStrictEqual(hoodie.dataQuality, ['atc_without_view', 'purchase_without_view']);
});

function round(v) { return Math.round(v * 10000) / 10000; }

test('Admin orders measure coverage only and never change the funnel', () => {
  const norm = normalizeProductEvents([
    viewed('101', null, { visitorKey: 'a' }),
    added('101', '1011', 1, { visitorKey: 'a' }),
    completed('gid://shopify/Order/9020', [['101', '1011']], { visitorKey: 'a' }),
  ], STORE);
  const without = aggregateProductEvents(norm.facts, WINDOW);
  const withAdmin = aggregateProductEvents(norm.facts, { ...WINDOW, adminOrderRefs: ['9020', '9021', '9022', '9023'] });
  assert.deepStrictEqual(withAdmin.products, without.products);
  assert.strictEqual(withAdmin.coverage.observedOrderShare, 0.25);
  assert.ok(withAdmin.dataQuality.includes('low_observed_order_share'));
  assert.ok(without.dataQuality.includes('admin_orders_unavailable'));
  assert.strictEqual(without.coverage.observedOrderShare, null);
});

test('pixel orders missing from Admin are flagged, not added', () => {
  const norm = normalizeProductEvents([completed('9030', [['101', '1011']])], STORE);
  const agg = aggregateProductEvents(norm.facts, { ...WINDOW, adminOrderRefs: [] });
  assert.strictEqual(agg.coverage.pixelOrdersNotInAdmin, 1);
  assert.strictEqual(agg.coverage.observedOrderShare, null);
  assert.ok(agg.dataQuality.includes('pixel_orders_not_in_admin'));
});

// ── 6. Consent, coverage and suspicious activity ────────────────────────────

test('events without analytics consent are rejected', () => {
  const out = normalizeProductEvents([
    viewed('101', null, { analyticsAllowed: false }),
    { ...viewed('101', null), analyticsAllowed: undefined },
  ], STORE);
  assert.deepStrictEqual(reasons(out), ['no_analytics_consent', 'no_analytics_consent']);
});

test('coverage reports partial, insufficient and unknown collection windows', () => {
  const partial = aggregateProductEvents([], { ...WINDOW, collectionStartedAt: '2026-10-10T00:00:00Z' });
  assert.strictEqual(partial.coverage.coverageDays, 12);
  assert.strictEqual(partial.coverage.partialWindow, true);
  assert.ok(partial.dataQuality.includes('partial_window'));
  assert.ok(!partial.dataQuality.includes('insufficient_coverage'));

  const thin = aggregateProductEvents([], { ...WINDOW, collectionStartedAt: '2026-10-18T00:00:00Z' });
  assert.strictEqual(thin.coverage.coverageDays, 4);
  assert.ok(thin.dataQuality.includes('insufficient_coverage'));

  const unknown = aggregateProductEvents([], { ...WINDOW, collectionStartedAt: null });
  assert.strictEqual(unknown.coverage.coverageDays, null);
  assert.ok(unknown.dataQuality.includes('collection_start_unknown'));
});

test('a viewer-day with implausible volume is excluded entirely', () => {
  const flood = [];
  for (let i = 0; i < 6; i += 1) flood.push(viewed('101', null, { visitorKey: 'bot' }));
  flood.push(viewed('102', null, { visitorKey: 'human' }));
  const norm = normalizeProductEvents(flood, STORE);
  const agg = aggregateProductEvents(norm.facts, WINDOW, { maxFactsPerVisitorDay: 5 });
  assert.strictEqual(agg.excluded.suspicious, 6);
  assert.deepStrictEqual(agg.products.map((p) => p.productId), ['tee']);
  assert.ok(agg.dataQuality.includes('suspicious_activity_excluded'));
});

// ── 7. Scoring receives only compatible inputs ──────────────────────────────

test('toScoringFunnels keeps unit metadata out of dataGaps and nulls ineligible funnels', () => {
  const norm = normalizeProductEvents([viewed('101', null), added('101', '1011')], STORE);
  const ok = toScoringFunnels(aggregateProductEvents(norm.facts, WINDOW));
  assert.deepStrictEqual(ok[0].funnel, { sessions: 1, atcCount: 1, atcRate: 1, orderCount: 0 });
  assert.deepStrictEqual(ok[0].measurement.source, 'web_pixel');
  assert.deepStrictEqual(ok[0].measurement.unit, 'viewer_day');
  assert.strictEqual('dataGaps' in ok[0], false);

  const thin = toScoringFunnels(aggregateProductEvents(norm.facts, { ...WINDOW, collectionStartedAt: '2026-10-19T00:00:00Z' }));
  assert.strictEqual(thin[0].eligible, false);
  assert.deepStrictEqual(thin[0].reasons, ['insufficient_coverage']);
  assert.deepStrictEqual(thin[0].funnel, { sessions: null, atcCount: null, atcRate: null, orderCount: null });

  assert.throws(() => toScoringFunnels({ measurement: { source: 'shopify_sessions', unit: 'session' } }), TypeError);
});

test('a purchase-heavy funnel (purchases > ATC) is ineligible rather than clamped', () => {
  const norm = normalizeProductEvents([
    viewed('101', null, { visitorKey: 'a' }),
    completed('9040', [['101', '1011']], { visitorKey: 'a' }),
  ], STORE);
  const [f] = toScoringFunnels(aggregateProductEvents(norm.facts, WINDOW));
  assert.strictEqual(f.eligible, false);
  assert.deepStrictEqual(f.reasons, ['purchase_exceeds_atc']);
});

// ── 8 + 9. End to end through the existing scoring engine ──────────────────

// Synthetic store: `views` viewer-days per product, the first `atc` add to
// cart, the first `buys` of those complete a checkout (one order each).
function syntheticEvents(shopifyProductId, variantId, views, atc, buys) {
  const out = [];
  for (let i = 0; i < views; i += 1) {
    const visitorKey = `${shopifyProductId}_v${i}`;
    out.push(viewed(shopifyProductId, variantId, { visitorKey }));
    if (i < atc) out.push(added(shopifyProductId, variantId, 1, { visitorKey }));
    if (i < buys) out.push(completed(`${shopifyProductId}${String(i).padStart(4, '0')}`, [[shopifyProductId, variantId]], { visitorKey }));
  }
  return out;
}

function diagnosticsFromEvents(envelopes, window = WINDOW) {
  const norm = normalizeProductEvents(envelopes, STORE);
  const aggregate = aggregateProductEvents(norm.facts, window);
  const contexts = toScoringFunnels(aggregate).map((f) => ({
    rawProduct: { id: f.productId, status: 'active', updatedAt: '2026-09-01T00:00:00Z', variants: [{ availableForSale: true }] },
    actions: [{ issueId: 'no_trust_bullets', severity: 'high', riskLevel: 'low' }],
    profile: { ...f.funnel, windowDays: f.measurement.windowDays, capturedAt: f.measurement.windowEnd, dataGaps: [], archetype: 'unknown' },
  }));
  const storeBaseline = buildStoreBaseline({
    shop: SHOP,
    timeWindow: { days: aggregate.window.days },
    products: assembleStoreBaselineRows(contexts, []),
    sources: ['web_pixel'],
  });
  return { norm, aggregate, storeBaseline, out: buildOpportunityDiagnostics(contexts, { storeBaseline }) };
}

test('synthetic Hoodie / Jacket / Tee events reproduce the expected leaks', () => {
  const events = [
    ...syntheticEvents('101', '1011', 1200, 24, 6),  // hoodie: weak view→ATC
    ...syntheticEvents('102', '1021', 900, 90, 30),  // tee: healthy
    ...syntheticEvents('103', '1031', 800, 80, 2),   // jacket: ATC but no purchase
  ];
  const { norm, aggregate, storeBaseline, out } = diagnosticsFromEvents(events);
  assert.strictEqual(norm.rejected.length, 0);
  assert.deepStrictEqual(
    aggregate.products.map((p) => [p.productId, p.viewDays, p.atcDays, p.purchaseDays]),
    [['hoodie', 1200, 24, 6], ['jacket', 800, 80, 2], ['tee', 900, 90, 30]],
  );
  assert.ok(['usable', 'good'].includes(storeBaseline.reliability.level));

  const by = Object.fromEntries(out.products.map((p) => [p.productId, p]));
  assert.strictEqual(by.hoodie.primaryLeak, 'low_view_to_atc');
  assert.strictEqual(by.jacket.primaryLeak, 'high_interest_low_purchase');
  assert.strictEqual(by.tee.primaryLeak, 'no_clear_leak');
  for (const p of out.products) assert.strictEqual(p.estimatedRevenueUpside, null);
});

test('insufficient coverage yields insufficient scores, never fabricated ones', () => {
  const events = [
    ...syntheticEvents('101', '1011', 1200, 24, 6),
    ...syntheticEvents('102', '1021', 900, 90, 30),
    ...syntheticEvents('103', '1031', 800, 80, 2),
  ];
  const { out } = diagnosticsFromEvents(events, { ...WINDOW, collectionStartedAt: '2026-10-19T00:00:00Z' });
  for (const p of out.products) {
    assert.strictEqual(p.primaryLeak, 'insufficient_data');
    assert.strictEqual(p.dataConfidence, 'insufficient');
    assert.strictEqual(p.estimatedRevenueUpside, null);
  }
});

test('a product below the traffic threshold stays insufficient', () => {
  const { out } = diagnosticsFromEvents([
    ...syntheticEvents('101', '1011', 30, 3, 1),
    ...syntheticEvents('102', '1021', 900, 90, 30),
    ...syntheticEvents('103', '1031', 800, 80, 2),
  ]);
  const hoodie = out.products.find((p) => p.productId === 'hoodie');
  assert.strictEqual(hoodie.primaryLeak, 'insufficient_data');
  assert.strictEqual(hoodie.estimatedRevenueUpside, null);
});

// ── 10. Purity and privacy ──────────────────────────────────────────────────

test('inputs are not mutated and raw client ids never reach the output', () => {
  const input = deepFreeze([
    viewed('101', '1011', { visitorKey: 'a' }),
    added('101', '1011', 1, { visitorKey: 'a' }),
    completed('9050', [['101', '1011']], { visitorKey: 'a' }),
  ]);
  const norm = normalizeProductEvents(input, deepFreeze({ ...STORE }));
  const agg = aggregateProductEvents(deepFreeze(norm.facts), deepFreeze({ ...WINDOW }));
  const serialized = JSON.stringify([norm, agg, toScoringFunnels(agg)]);
  assert.ok(!serialized.includes('raw-client-id-secret'));
  assert.ok(!/clientId/.test(serialized));
});

test('products with no events are absent (unknown), not zero', () => {
  const norm = normalizeProductEvents([viewed('101', null)], STORE);
  const agg = aggregateProductEvents(norm.facts, WINDOW);
  assert.deepStrictEqual(agg.products.map((p) => p.productId), ['hoodie']);
  const empty = aggregateProductEvents([], WINDOW);
  assert.deepStrictEqual(empty.products, []);
  assert.strictEqual(empty.coverage.pixelCheckoutOrders, 0);
});
