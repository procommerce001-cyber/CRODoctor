'use strict';

// ---------------------------------------------------------------------------
// Phase 1A — conversion-first decision object (decisionV2) scenario tests.
// Exercises the pure buildDecisionV2() with synthetic contexts. No DB, no I/O,
// no Apply/Rollback — buildDecisionV2 is a pure function.
//
// Run: node --test src/__tests__/metrics-decision.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const { buildDecisionV2 } = require('../services/metrics.service');

const OLD = new Date(Date.now() - 5 * 86400000).toISOString();  // 5 days ago (past cooldown)
const NOW = new Date().toISOString();                            // within cooldown

function cmp(o = {}) {
  const {
    pSessB = null, pSessA = null, ordB = 0, ordA = 0, revB = 100, revA = 100,
    atcB = null, atcA = null, cvrB = null, cvrA = null,
    cvrPct = null, ordPct = null, revPct = null, atcPct = null,
  } = o;
  const w = { windowStart: new Date(), windowEnd: new Date() };
  return {
    success: true,
    before: { productSessions: pSessB, productAtcCount: atcB, orderCount: ordB, revenue: String(revB), unitsSold: ordB, ...w },
    after:  { productSessions: pSessA, productAtcCount: atcA, orderCount: ordA, revenue: String(revA), unitsSold: ordA, ...w },
    diff: {
      productCvrBefore: cvrB, productCvrAfter: cvrA, productCvrChangePercent: cvrPct,
      productAtcCountChangePercent: atcPct, orderCountChangePercent: ordPct,
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
  assert.ok(d.confidenceScore <= 40);
});

// 2 — cooldown active → continue_measuring + cooling_down
test('cooldown active → continue_measuring (cooling_down)', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: NOW, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, revA: 2000 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 60, uAtc: 30, eRate: 0.10, uRate: 0.05 }),
    confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.measurementStatus, 'cooling_down');
  assert.strictEqual(d.recommendedAction, 'continue_measuring');
});

// 3 — clear positive exposure ATC lift → keep
test('clear positive exposure ATC lift → keep', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, revB: 1000, revA: 2000 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 60, uAtc: 30, eRate: 0.10, uRate: 0.05 }),
    confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.primaryMetric, 'exposure_atc_rate');
  assert.strictEqual(d.recommendedAction, 'keep');
  assert.ok(d.confidenceScore >= 80);
  assert.ok(d.downsideRiskScore < 35);
  assert.strictEqual(d.attributionConfidence, 90);
});

// 4 — clear negative exposure ATC lift → undo_suggested
test('clear negative exposure ATC lift → undo_suggested', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 60, ordA: 18, revB: 2000, revA: 1000 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 18, uAtc: 60, eRate: 0.03, uRate: 0.10 }),
    confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.recommendedAction, 'undo_suggested');
  assert.ok(d.downsideRiskScore >= 50);
  assert.ok(d.internalReasonCodes.includes('negative_cvr_lift'));
});

// 5 — neutral result with enough data → try_alternative
test('neutral result → try_alternative', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 31, revB: 1000, revA: 1010 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 31, uAtc: 30, eRate: 0.0517, uRate: 0.05 }),
    confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.recommendedAction, 'try_alternative');
  assert.ok(d.internalReasonCodes.includes('no_clear_effect'));
});

// 6 — severe confound → manual_review (never decides)
test('severe confound → manual_review', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, revA: 2000 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 60, uAtc: 30, eRate: 0.10, uRate: 0.05 }),
    confoundedBy: [], confoundSignals: [{ type: 'store_revenue_spike', severity: 'high' }] });
  assert.strictEqual(d.recommendedAction, 'manual_review');
  assert.strictEqual(d.measurementStatus, 'inconclusive');
  assert.ok(d.confoundFlags.includes('store_revenue_spike'));
  assert.ok(d.shouldNotTouchReason !== null);
});

// 7 — revenue-only fallback → low attribution, not overconfident
test('revenue-only fallback → low attributionConfidence, not overconfident', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'medium',
    compare: cmp({ pSessB: null, pSessA: null, ordB: 10, ordA: 12, revB: 1000, revA: 1200, ordPct: 20, revPct: 20 }),
    exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.primaryMetric, 'revenue_per_view');
  assert.strictEqual(d.attributionConfidence, 35);
  assert.ok(d.internalReasonCodes.includes('revenue_only_fallback'));
  assert.ok(d.recommendedAction !== 'keep' && d.recommendedAction !== 'undo_suggested',
    'revenue-only must not produce a confident keep/undo');
});

// 8 — additive contract: all required fields present (backward-compat shape)
test('decisionV2 always returns the full required field set', () => {
  const d = buildDecisionV2({ status: 'waiting_for_more_data', createdAt: OLD, confidence: 'insufficient',
    compare: null, exposure: null, confoundedBy: [], confoundSignals: [] });
  for (const f of REQUIRED_FIELDS) assert.ok(f in d, `missing field: ${f}`);
  assert.strictEqual(d.measurementStatus, 'not_started');
});

// 9 — pure & deterministic, no side effects (not a Promise; stable output)
test('buildDecisionV2 is pure/synchronous and deterministic', () => {
  const ctx = { status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, revA: 2000 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 60, uAtc: 30, eRate: 0.10, uRate: 0.05 }),
    confoundedBy: [], confoundSignals: [] };
  const a = buildDecisionV2(ctx);
  const b = buildDecisionV2(ctx);
  assert.ok(!(a instanceof Promise), 'must be synchronous');
  assert.strictEqual(a.recommendedAction, b.recommendedAction);
  assert.strictEqual(a.confidenceScore, b.confidenceScore);
});
