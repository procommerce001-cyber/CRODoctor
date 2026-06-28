'use strict';

// ---------------------------------------------------------------------------
// ProductOpportunityScore v1 — pure scoring + funnel-leak tests.
// No DB/I/O; drives the pure helpers with synthetic product contexts.
//
// Run: node --test src/tests/product-opportunity.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const {
  computeProductOpportunity,
  detectPrimaryLeak,
  rankProductOpportunities,
} = require('../services/product-opportunity.service');

// Store baseline used across cases: 5% ATC, 2% CVR, $1.00 RPV, $50 AOV.
const BASELINE = { storeAtcRate: 0.05, storeCvr: 0.02, storeRpv: 1.0, storeAov: 50 };

// Merchant-facing strings must never sound academic or over-claim.
const FORBIDDEN = /statistically significant|guaranteed|proven lift|no proof|not proven|not statistically significant/i;

function ctx(over = {}) {
  return {
    productId: 'p1',
    snapshot: { productSessions: 800, productAtcCount: 16, orderCount: 4, revenue: 200, unitsSold: 4 },
    profile:  { atcRate: 0.02, refundRate: 0.0, dataGaps: [], archetype: 'standard' },
    storeBaseline: BASELINE,
    eligibleIssues: [],
    product: { id: 'p1', status: 'active', updatedAt: new Date(Date.now() - 30 * 86400000).toISOString() },
    variants: [{ availableForSale: true }],
    confoundFlags: [],
    ...over,
  };
}

// 1 — high traffic + weak ATC + revenue upside → high score / top / low_view_to_atc
test('high traffic + weak ATC + upside → top band, low_view_to_atc', () => {
  const r = computeProductOpportunity(ctx({
    snapshot: { productSessions: 1500, productAtcCount: 15, orderCount: 6, revenue: 150, unitsSold: 6 },
    eligibleIssues: [{ issueId: 'no_trust_bullets', leakStage: 'view_to_atc', riskLevel: 'low', canRollback: true }],
  }));
  assert.strictEqual(r.primaryLeak, 'low_view_to_atc');
  assert.ok(r.opportunityScore >= 70, `score ${r.opportunityScore} should be high`);
  assert.ok(['top', 'good'].includes(r.band));
  assert.strictEqual(r.subScores.interventionFit, 1); // trust issue matches the leak
  assert.ok(r.estimatedRevenueUpside > 0);
});

// 2 — low traffic → not_yet / insufficient_data
test('low traffic → not_yet + insufficient_data', () => {
  const r = computeProductOpportunity(ctx({
    snapshot: { productSessions: 20, productAtcCount: 0, orderCount: 0, revenue: 0, unitsSold: 0 },
  }));
  assert.strictEqual(r.band, 'not_yet');
  assert.strictEqual(r.opportunityScore, 0);
  assert.strictEqual(r.primaryLeak, 'insufficient_data');
  assert.strictEqual(r.dataConfidence, 'insufficient');
  assert.ok(r.excludedReason);
});

// 3 — high traffic + already strong conversion → lower priority / no_clear_leak
test('strong conversion → no_clear_leak, not top', () => {
  const r = computeProductOpportunity(ctx({
    // ATC 8% > 5% baseline, CVR 3% > 2%, RPV $1.50 > $1.00, AOV $50 == baseline.
    snapshot: { productSessions: 1000, productAtcCount: 80, orderCount: 30, revenue: 1500, unitsSold: 30 },
  }));
  assert.strictEqual(r.primaryLeak, 'no_clear_leak');
  assert.ok(r.opportunityScore < 60, `score ${r.opportunityScore} should be lower priority`);
});

// 3b — good conversion but low AOV → good_conversion_low_aov
test('good conversion, low AOV → good_conversion_low_aov', () => {
  const r = computeProductOpportunity(ctx({
    // CVR 3% ≥ baseline, RPV not below baseline, AOV $20 ≪ $50.
    snapshot: { productSessions: 1000, productAtcCount: 80, orderCount: 30, revenue: 600, unitsSold: 30 },
  }));
  assert.strictEqual(r.primaryLeak, 'good_conversion_low_aov');
});

// 4 — orders-only / missing sessions → weak/insufficient data quality, no crash
test('orders-only (no sessions) → safe, weak/insufficient data quality', () => {
  const r = computeProductOpportunity(ctx({
    snapshot: { productSessions: null, productAtcCount: null, orderCount: 10, revenue: 500, unitsSold: 10 },
    profile:  { atcRate: null, refundRate: null, dataGaps: ['sessions'], archetype: 'standard' },
  }));
  // No measurable traffic → excluded path, insufficient.
  assert.strictEqual(r.primaryLeak, 'insufficient_data');
  assert.ok(['insufficient', 'weak'].includes(r.dataConfidence));
  assert.strictEqual(r.opportunityScore, 0);
});

// 5 — out of stock → score 0 / excludedReason
test('out of stock → excluded, score 0', () => {
  const r = computeProductOpportunity(ctx({
    variants: [{ availableForSale: false }, { availableForSale: false }],
  }));
  assert.strictEqual(r.opportunityScore, 0);
  assert.strictEqual(r.band, 'not_yet');
  assert.match(r.excludedReason, /out of stock/i);
});

// 5b — draft product → excluded
test('draft product → excluded', () => {
  const r = computeProductOpportunity(ctx({ product: { id: 'p1', status: 'draft' } }));
  assert.strictEqual(r.opportunityScore, 0);
  assert.match(r.excludedReason, /draft/i);
});

// 6 — severe confound flag → excluded (score reduced to 0)
test('severe confound → excluded', () => {
  const r = computeProductOpportunity(ctx({ confoundFlags: ['store_revenue_spike'] }));
  assert.strictEqual(r.opportunityScore, 0);
  assert.ok(r.excludedReason);
});

// 6b — non-severe confound → soft penalty, not excluded
test('non-severe confound → penalized but not excluded', () => {
  const clean = computeProductOpportunity(ctx({
    snapshot: { productSessions: 1500, productAtcCount: 15, orderCount: 6, revenue: 150, unitsSold: 6 },
  }));
  const flagged = computeProductOpportunity(ctx({
    snapshot: { productSessions: 1500, productAtcCount: 15, orderCount: 6, revenue: 150, unitsSold: 6 },
    confoundFlags: ['low_traffic'],
  }));
  assert.strictEqual(flagged.excludedReason, null);
  assert.ok(flagged.riskPenalty > 0);
  assert.ok(flagged.opportunityScore < clean.opportunityScore);
});

// 7 — eligible trust issue + low_view_to_atc → interventionFit = 1
test('matching trust issue → interventionFit 1', () => {
  const r = computeProductOpportunity(ctx({
    snapshot: { productSessions: 1200, productAtcCount: 12, orderCount: 4, revenue: 120, unitsSold: 4 },
    eligibleIssues: [{ issueId: 'no_trust_bullets', leakStage: 'view_to_atc' }],
  }));
  assert.strictEqual(r.primaryLeak, 'low_view_to_atc');
  assert.strictEqual(r.subScores.interventionFit, 1);
});

// 8 — no eligible issue → interventionFit 0 and lower score
test('no eligible issue → interventionFit 0', () => {
  const withIssue = computeProductOpportunity(ctx({
    snapshot: { productSessions: 1200, productAtcCount: 12, orderCount: 4, revenue: 120, unitsSold: 4 },
    eligibleIssues: [{ issueId: 'no_trust_bullets', leakStage: 'view_to_atc' }],
  }));
  const noIssue = computeProductOpportunity(ctx({
    snapshot: { productSessions: 1200, productAtcCount: 12, orderCount: 4, revenue: 120, unitsSold: 4 },
    eligibleIssues: [],
  }));
  assert.strictEqual(noIssue.subScores.interventionFit, 0);
  assert.ok(noIssue.opportunityScore < withIssue.opportunityScore);
});

// 9 — missing analytics / null fields → safe fallback, no throw
test('null-heavy input → safe fallback, no throw', () => {
  assert.doesNotThrow(() => computeProductOpportunity({}));
  assert.doesNotThrow(() => computeProductOpportunity(null));
  assert.doesNotThrow(() => detectPrimaryLeak({}));
  const r = computeProductOpportunity({ productId: 'x' });
  assert.strictEqual(r.opportunityScore, 0);
  assert.strictEqual(r.primaryLeak, 'insufficient_data');
});

// 10 — deterministic + bounded output
test('deterministic and bounded 0–100 / subscores 0–1', () => {
  const input = ctx();
  const a = computeProductOpportunity(input);
  const b = computeProductOpportunity(input);
  assert.deepStrictEqual(a, b);
  assert.ok(a.opportunityScore >= 0 && a.opportunityScore <= 100);
  for (const v of Object.values(a.subScores)) assert.ok(v >= 0 && v <= 1, `subscore ${v} out of range`);
  assert.ok(a.riskPenalty >= 0 && a.riskPenalty <= 1);
});

// 11 — rankProductOpportunities sorts desc, does not mutate input
test('rank sorts descending and does not mutate input', () => {
  const inputs = [
    ctx({ productId: 'low',  snapshot: { productSessions: 60, productAtcCount: 3, orderCount: 1, revenue: 30, unitsSold: 1 } }),
    ctx({ productId: 'high', snapshot: { productSessions: 1500, productAtcCount: 15, orderCount: 6, revenue: 150, unitsSold: 6 },
          eligibleIssues: [{ issueId: 'no_trust_bullets', leakStage: 'view_to_atc' }] }),
  ];
  const snapshot = JSON.stringify(inputs);
  const ranked = rankProductOpportunities(inputs);
  assert.strictEqual(ranked.length, 2);
  assert.ok(ranked[0].opportunityScore >= ranked[1].opportunityScore);
  assert.strictEqual(ranked[0].productId, 'high');
  assert.strictEqual(JSON.stringify(inputs), snapshot, 'input array was mutated');
  // null-safe
  assert.deepStrictEqual(rankProductOpportunities(null), []);
});

// 12 — merchant-safe explanations: never academic / over-claiming
test('explanations never contain forbidden academic/over-claim wording', () => {
  const cases = [
    ctx({ snapshot: { productSessions: 1500, productAtcCount: 15, orderCount: 6, revenue: 150, unitsSold: 6 },
          eligibleIssues: [{ issueId: 'no_trust_bullets', leakStage: 'view_to_atc' }] }),
    ctx({ snapshot: { productSessions: 20 } }),
    ctx({ variants: [{ availableForSale: false }] }),
    ctx({ snapshot: { productSessions: 1000, productAtcCount: 80, orderCount: 30, revenue: 600, unitsSold: 30 } }),
  ];
  for (const c of cases) {
    const r = computeProductOpportunity(c);
    assert.ok(!FORBIDDEN.test(r.explanation), `forbidden wording: ${r.explanation}`);
  }
});
