'use strict';

// ---------------------------------------------------------------------------
// decisionV2 scenario tests — conversion-first + exposure-as-directional.
// Pure: drives buildDecisionV2() with synthetic contexts (no DB/I/O).
//
// Attribution policy under test:
//   - product before/after (view-normalized) is PRIMARY for keep/undo
//   - exposure (exposed vs unexposed) is a DIRECTIONAL signal only — it can
//     corroborate or conflict with the baseline but never drives keep/undo alone
//   - no randomized holdout exists, so attributionConfidence is capped (<90)
//
// Run: node --test src/__tests__/metrics-decision.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const { buildDecisionV2 } = require('../services/metrics.service');

const OLD = new Date(Date.now() - 5 * 86400000).toISOString();  // past cooldown
const NOW = new Date().toISOString();                            // within cooldown

// before/after compare; auto-derives product CVR from orders/sessions so the
// before/after path is primary whenever sessions are present.
function cmp(o = {}) {
  const {
    pSessB = null, pSessA = null, ordB = 0, ordA = 0, revB = 100, revA = 100,
    atcB = null, atcA = null, ordPct = null, revPct = null,
  } = o;
  const cvrB = pSessB ? +((ordB / pSessB) * 100).toFixed(4) : null;
  const cvrA = pSessA ? +((ordA / pSessA) * 100).toFixed(4) : null;
  const cvrPct = (cvrB != null && cvrA != null && cvrB !== 0)
    ? +(((cvrA - cvrB) / cvrB) * 100).toFixed(2) : null;
  const w = { windowStart: new Date(), windowEnd: new Date() };
  return {
    success: true,
    before: { productSessions: pSessB, productAtcCount: atcB, orderCount: ordB, revenue: String(revB), unitsSold: ordB, ...w },
    after:  { productSessions: pSessA, productAtcCount: atcA, orderCount: ordA, revenue: String(revA), unitsSold: ordA, ...w },
    diff: {
      productCvrBefore: cvrB, productCvrAfter: cvrA, productCvrChangePercent: cvrPct,
      productAtcCountChangePercent: null, orderCountChangePercent: ordPct,
      revenueChangePercent: revPct, productSessionsChangePercent: 0,
    },
    store: null,
  };
}
function exp({ eN, uN, eAtc, uAtc, eRate, uRate }) {
  return {
    exposedSessionCount: eN, unexposedPdpSessionCount: uN,
    funnel: {
      exposed:   { atcSessions: eAtc, atcRate: eRate, checkoutSessions: 0, checkoutRate: null },
      unexposed: { atcSessions: uAtc, atcRate: uRate, checkoutSessions: 0, checkoutRate: null },
    },
  };
}
const REQUIRED_FIELDS = [
  'measurementStatus','recommendedAction','primaryMetric','primaryMetricBefore','primaryMetricAfter',
  'primaryMetricLift','exposureLift','revenuePerViewLift','addToCartLift','checkoutStartLift',
  'confidenceScore','dataQualityScore','downsideRiskScore','attributionConfidence','expectedImpactScore',
  'confoundFlags','explanationForMerchant','internalReasonCodes','nextAllowedAction','canAutoUndoLater',
  'shouldNotTouchReason',
];

// 1 — insufficient data → continue_measuring
test('insufficient data → continue_measuring', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'insufficient',
    compare: cmp({ pSessB: 50, pSessA: 50, ordB: 1, ordA: 1 }), exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.recommendedAction, 'continue_measuring');
});

// 2 — cooldown → continue_measuring (cooling_down)
test('cooldown active → continue_measuring (cooling_down)', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: NOW, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, revA: 2000 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 60, uAtc: 30, eRate: 0.10, uRate: 0.05 }),
    confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.measurementStatus, 'cooling_down');
  assert.strictEqual(d.recommendedAction, 'continue_measuring');
});

// 3 — positive before/after + supporting exposure → keep (baseline primary)
test('positive baseline + supporting exposure → keep (before/after primary, not exposure)', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, revB: 1000, revA: 2000 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 60, uAtc: 30, eRate: 0.10, uRate: 0.05 }),
    confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.primaryMetric, 'product_cvr', 'baseline is primary, not exposure');
  assert.strictEqual(d.recommendedAction, 'keep');
  assert.ok(d.internalReasonCodes.includes('before_after_primary'));
  assert.ok(d.internalReasonCodes.includes('exposure_supports_trend'));
  assert.ok(d.attributionConfidence < 90, 'never causal-grade without a holdout');
});

// 4 — negative before/after + negative exposure + high downside → undo_suggested
test('negative baseline + negative exposure → undo_suggested', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 60, ordA: 18, revB: 2000, revA: 1000 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 18, uAtc: 60, eRate: 0.03, uRate: 0.10 }),
    confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.primaryMetric, 'product_cvr');
  assert.strictEqual(d.recommendedAction, 'undo_suggested');
  assert.ok(d.downsideRiskScore >= 50);
});

// 5 — neutral baseline → try_alternative
test('neutral baseline → try_alternative', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 31, revB: 1000, revA: 1010 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 31, uAtc: 30, eRate: 0.0517, uRate: 0.05 }),
    confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.recommendedAction, 'try_alternative');
});

// 6 — severe confound → manual_review
test('severe confound → manual_review', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, revA: 2000 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 60, uAtc: 30, eRate: 0.10, uRate: 0.05 }),
    confoundedBy: [], confoundSignals: [{ type: 'store_revenue_spike', severity: 'high' }] });
  assert.strictEqual(d.recommendedAction, 'manual_review');
});

// 7 — revenue-only fallback → low attribution, not overconfident
test('revenue-only fallback → low attributionConfidence, not keep/undo', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'medium',
    compare: cmp({ pSessB: null, pSessA: null, ordB: 10, ordA: 12, revB: 1000, revA: 1200, ordPct: 20, revPct: 20 }),
    exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.primaryMetric, 'revenue_per_view');
  assert.strictEqual(d.attributionConfidence, 35);
  assert.ok(d.recommendedAction !== 'keep' && d.recommendedAction !== 'undo_suggested');
});

// 8 — exposure-only positive (no baseline) → directional, NOT keep
test('positive exposure only (no baseline) → continue_measuring, never keep', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: null, pSessA: null, ordB: 0, ordA: 0 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 60, uAtc: 30, eRate: 0.10, uRate: 0.05 }),
    confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.primaryMetric, 'exposure_atc_rate');
  assert.strictEqual(d.recommendedAction, 'continue_measuring');
  assert.ok(d.recommendedAction !== 'keep');
  assert.ok(d.attributionConfidence <= 50, 'exposure-only is low confidence');
  assert.ok(d.internalReasonCodes.includes('exposure_directional_only'));
  assert.ok(d.internalReasonCodes.includes('no_randomized_holdout'));
});

// 9 — exposure positive but baseline negative → conflict, never keep
test('exposure positive but baseline negative → conflict, not keep', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 60, ordA: 30, revB: 2000, revA: 1000 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 60, uAtc: 30, eRate: 0.10, uRate: 0.05 }),
    confoundedBy: [], confoundSignals: [] });
  assert.ok(['continue_measuring', 'manual_review'].includes(d.recommendedAction));
  assert.notStrictEqual(d.recommendedAction, 'keep');
  assert.ok(d.internalReasonCodes.includes('exposure_conflicts_with_baseline'));
});

// 10 — additive contract: all required fields present (backward-compat)
test('decisionV2 always returns the full required field set', () => {
  const d = buildDecisionV2({ status: 'waiting_for_more_data', createdAt: OLD, confidence: 'insufficient',
    compare: null, exposure: null, confoundedBy: [], confoundSignals: [] });
  for (const f of REQUIRED_FIELDS) assert.ok(f in d, `missing field: ${f}`);
  assert.strictEqual(d.measurementStatus, 'not_started');
});

// 11 — pure & deterministic
test('buildDecisionV2 is pure/synchronous and deterministic', () => {
  const ctx = { status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, revA: 2000 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 60, uAtc: 30, eRate: 0.10, uRate: 0.05 }),
    confoundedBy: [], confoundSignals: [] };
  const a = buildDecisionV2(ctx);
  const b = buildDecisionV2(ctx);
  assert.ok(!(a instanceof Promise));
  assert.strictEqual(a.recommendedAction, b.recommendedAction);
  assert.strictEqual(a.attributionConfidence, b.attributionConfidence);
});
