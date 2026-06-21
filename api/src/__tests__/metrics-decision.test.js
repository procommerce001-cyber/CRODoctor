'use strict';

// ---------------------------------------------------------------------------
// decisionV2 scenario tests — conversion-first + exposure-directional +
// store-trend (DiD) adjusted partial credit + anti-stuck states.
// Pure: drives buildDecisionV2() with synthetic contexts (no DB/I/O).
//
// Policy under test:
//   - product before/after (view-normalized) is PRIMARY; exposure is directional
//   - keep/undo use the DiD-corrected (store-trend-subtracted) lift, never raw
//   - credit is partial, confound/confidence-discounted, capped at 'medium' (no holdout)
//   - neutral_no_clear_lift / measurement_expired prevent infinite measuring
//
// Run: node --test src/__tests__/metrics-decision.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const { buildDecisionV2 } = require('../services/metrics.service');

const OLD = new Date(Date.now() - 5 * 86400000).toISOString();   // past cooldown, < max window
const NOW = new Date().toISOString();                            // within cooldown
const ANCIENT = new Date(Date.now() - 40 * 86400000).toISOString(); // > max window (28d)

function cmp(o = {}) {
  const {
    pSessB = null, pSessA = null, ordB = 0, ordA = 0, revB = 100, revA = 100,
    ordPct = null, revPct = null,
    storeCvrPct = undefined, storeOrdPct = undefined, storeRevPct = undefined,
  } = o;
  const cvrB = pSessB ? +((ordB / pSessB) * 100).toFixed(4) : null;
  const cvrA = pSessA ? +((ordA / pSessA) * 100).toFixed(4) : null;
  const cvrPct = (cvrB != null && cvrA != null && cvrB !== 0)
    ? +(((cvrA - cvrB) / cvrB) * 100).toFixed(2) : null;
  const w = { windowStart: new Date(), windowEnd: new Date() };
  const hasStore = storeCvrPct !== undefined || storeOrdPct !== undefined || storeRevPct !== undefined;
  return {
    success: true,
    before: { productSessions: pSessB, productAtcCount: null, orderCount: ordB, revenue: String(revB), unitsSold: ordB, ...w },
    after:  { productSessions: pSessA, productAtcCount: null, orderCount: ordA, revenue: String(revA), unitsSold: ordA, ...w },
    diff: {
      productCvrBefore: cvrB, productCvrAfter: cvrA, productCvrChangePercent: cvrPct,
      productAtcCountChangePercent: null, orderCountChangePercent: ordPct,
      revenueChangePercent: revPct, productSessionsChangePercent: 0,
    },
    store: hasStore ? { diff: {
      cvrChangePercent: storeCvrPct ?? null,
      orderCountChangePercent: storeOrdPct ?? null,
      revenueChangePercent: storeRevPct ?? null,
    } } : null,
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
  'measurementStatus','recommendedAction','primaryMetric','primaryMetricLift',
  'rawLiftPercent','expectedBaselineLiftPercent','adjustedLiftPercent',
  'creditedLiftPercent','creditedRevenueImpact','creditedOrdersImpact','creditBand',
  'confidenceScore','dataQualityScore','downsideRiskScore','attributionConfidence',
  'confoundFlags','explanationForMerchant','internalReasonCodes','nextAllowedAction',
  'canAutoUndoLater','shouldNotTouchReason',
];

// 1 — insufficient data → continue_measuring
test('insufficient data → continue_measuring', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'insufficient',
    compare: cmp({ pSessB: 50, pSessA: 50, ordB: 1, ordA: 1 }), exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.recommendedAction, 'continue_measuring');
});

// 2 — cooldown → cooling_down / continue
test('cooldown active → continue_measuring (cooling_down)', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: NOW, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, storeCvrPct: 0 }),
    exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.measurementStatus, 'cooling_down');
  assert.strictEqual(d.recommendedAction, 'continue_measuring');
});

// 3 — product +100%, store flat → adjusted +100 → keep with partial credit (medium)
test('product up, store flat → keep with partial credit (medium, capped)', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, revB: 1000, revA: 2000, storeCvrPct: 0 }),
    exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.recommendedAction, 'keep');
  assert.strictEqual(d.primaryMetric, 'product_cvr');
  assert.strictEqual(d.expectedBaselineLiftPercent, 0);
  assert.strictEqual(d.adjustedLiftPercent, 100);
  assert.strictEqual(d.creditBand, 'medium');
  assert.notStrictEqual(d.creditBand, 'strong');           // never strong without a holdout
  assert.ok(d.creditedLiftPercent != null && d.creditedLiftPercent < 100); // discounted
  assert.ok(d.internalReasonCodes.includes('store_trend_adjusted'));
  assert.ok(d.internalReasonCodes.includes('no_causal_credit_without_holdout'));
});

// 4 — product +20%, store +18% → adjusted ~+2% (< floor) → not over-credited
test('product up but store up too → not creditable, neutral (no over-credit)', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 36, storeCvrPct: 18 }),
    exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.adjustedLiftPercent, 2);            // 20 - 18
  assert.notStrictEqual(d.recommendedAction, 'keep');
  assert.strictEqual(d.creditBand, 'not_creditable');
  assert.ok(d.internalReasonCodes.includes('store_trend_adjusted'));
  assert.ok(d.internalReasonCodes.includes('adjusted_lift_neutral'));
});

// 5 — product +100%, store +120% → adjusted negative → not keep, store_also_improved
test('store improved more than product → not keep, store_also_improved', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, storeCvrPct: 120 }),
    exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.ok(d.adjustedLiftPercent < 0);
  assert.notStrictEqual(d.recommendedAction, 'keep');
  assert.ok(d.internalReasonCodes.includes('store_also_improved'));
  assert.ok(d.internalReasonCodes.includes('adjusted_lift_negative'));
  assert.strictEqual(d.creditBand, 'not_creditable');
});

// 6 — product flat, enough data → neutral_no_clear_lift (not stuck forever)
test('flat product with enough data → neutral_no_clear_lift', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 31, storeCvrPct: 0 }),
    exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.recommendedAction, 'neutral_no_clear_lift');
  assert.ok(d.internalReasonCodes.includes('adjusted_lift_neutral'));
});

// 7 — product negative, store flat, high downside → undo_suggested
test('negative adjusted lift + high downside → undo_suggested', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 60, ordA: 18, revB: 2000, revA: 1000, storeCvrPct: 0 }),
    exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.recommendedAction, 'undo_suggested');
  assert.ok(d.downsideRiskScore >= 50);
  assert.strictEqual(d.creditBand, 'not_creditable');
});

// 8 — max window reached + insufficient traffic → measurement_expired
test('max window + insufficient traffic → measurement_expired', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: ANCIENT, confidence: 'insufficient',
    compare: cmp({ pSessB: 80, pSessA: 80, ordB: 1, ordA: 1, storeCvrPct: 0 }),
    exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.recommendedAction, 'measurement_expired');
  assert.strictEqual(d.creditBand, 'not_creditable');
  assert.ok(d.internalReasonCodes.includes('measurement_expired'));
  assert.ok(d.internalReasonCodes.includes('insufficient_traffic'));
});

// 9 — severe confound → manual_review, not creditable, discounted by confound
test('severe confound → manual_review, not_creditable', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, storeCvrPct: 0 }),
    exposure: null, confoundedBy: [], confoundSignals: [{ type: 'store_revenue_spike', severity: 'high' }] });
  assert.strictEqual(d.recommendedAction, 'manual_review');
  assert.strictEqual(d.creditBand, 'not_creditable');
  assert.ok(d.internalReasonCodes.includes('credit_discounted_by_confound'));
});

// 10 — store trend unavailable → conservative credit (low, not medium)
test('store trend unavailable → conservative low credit, keep allowed', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, revB: 1000, revA: 2000 }), // store: null
    exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.expectedBaselineLiftPercent, null);
  assert.strictEqual(d.recommendedAction, 'keep');
  assert.strictEqual(d.creditBand, 'low');                 // baseline unknown → never medium
  assert.ok(d.internalReasonCodes.includes('store_trend_unavailable'));
});

// 11 — exposure positive but adjusted baseline neutral → not keep, exposure directional
test('exposure positive but baseline neutral → not keep, neutral', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 31, storeCvrPct: 0 }),
    exposure: exp({ eN: 600, uN: 600, eAtc: 60, uAtc: 30, eRate: 0.10, uRate: 0.05 }),
    confoundedBy: [], confoundSignals: [] });
  assert.notStrictEqual(d.recommendedAction, 'keep');
  assert.strictEqual(d.recommendedAction, 'neutral_no_clear_lift');
  assert.ok(d.exposureLift != null, 'exposure still reported (directional)');
});

// 12 — revenue-only fallback → low attribution, not creditable, no overclaim
test('revenue-only fallback → low attribution, not creditable', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'medium',
    compare: cmp({ pSessB: null, pSessA: null, ordB: 10, ordA: 12, revB: 1000, revA: 1200, ordPct: 20, revPct: 20 }),
    exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.primaryMetric, 'revenue_per_view');
  assert.strictEqual(d.attributionConfidence, 35);
  assert.strictEqual(d.creditBand, 'not_creditable');
  assert.ok(d.recommendedAction !== 'keep' && d.recommendedAction !== 'undo_suggested');
});

// 13 — backward-compat contract: all fields present + decisionV2 shape
test('decisionV2 returns the full required field set (backward compatible)', () => {
  const d = buildDecisionV2({ status: 'waiting_for_more_data', createdAt: OLD, confidence: 'insufficient',
    compare: null, exposure: null, confoundedBy: [], confoundSignals: [] });
  for (const f of REQUIRED_FIELDS) assert.ok(f in d, `missing field: ${f}`);
  assert.strictEqual(d.measurementStatus, 'not_started');
  assert.strictEqual(d.creditBand, 'not_creditable');
});

// 14 — pure & deterministic
test('buildDecisionV2 is pure/synchronous and deterministic', () => {
  const ctx = { status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, storeCvrPct: 0 }),
    exposure: null, confoundedBy: [], confoundSignals: [] };
  const a = buildDecisionV2(ctx);
  const b = buildDecisionV2(ctx);
  assert.ok(!(a instanceof Promise));
  assert.strictEqual(a.recommendedAction, b.recommendedAction);
  assert.strictEqual(a.creditBand, b.creditBand);
  assert.strictEqual(a.creditedLiftPercent, b.creditedLiftPercent);
});

// ---------------------------------------------------------------------------
// DATA #2B — honest measurement labels (pure interpretation layer).
// These never claim statistical proof; they relabel existing decisionV2 scores
// as sufficiency / quality / directional signal. No schema, no new inference.
// ---------------------------------------------------------------------------
const { deriveMeasurementLabels } = require('../services/measurement-labels');

const LABEL_FIELDS = [
  'measurementDataSufficiency','measurementDataQuality','measurementSignalLabel',
  'measurementDisclaimer','measurementEvidenceSource','measurementCaveats',
];
// No merchant-facing label may ever imply statistical proof.
const FORBIDDEN = /statistically significant|proven lift|confirmed (revenue )?lift|guaranteed/i;

// 15 — labels are spread into every buildDecisionV2 result (back-compat additive)
test('decisionV2 includes derived measurement labels alongside existing fields', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, storeCvrPct: 0 }),
    exposure: null, confoundedBy: [], confoundSignals: [] });
  for (const f of REQUIRED_FIELDS) assert.ok(f in d, `lost existing field: ${f}`);
  for (const f of LABEL_FIELDS)    assert.ok(f in d, `missing label field: ${f}`);
});

// 16 — low / not-started data → "Not enough data yet", insufficient, waits
test('insufficient data → not-enough-data label + waits for more data', () => {
  const labels = deriveMeasurementLabels(buildDecisionV2({
    status: 'waiting_for_more_data', createdAt: OLD, confidence: 'insufficient',
    compare: null, exposure: null, confoundedBy: [], confoundSignals: [] }));
  assert.strictEqual(labels.measurementDataSufficiency, 'insufficient');
  assert.strictEqual(labels.measurementSignalLabel, 'Not enough data yet');
  assert.match(labels.measurementDisclaimer, /wait for more data/i);
  assert.strictEqual(labels.measurementEvidenceSource, 'decision_v2');
});

// 17 — cooldown → "Collecting data", still insufficient
test('cooldown → collecting-data label', () => {
  const labels = deriveMeasurementLabels(buildDecisionV2({
    status: 'measured', createdAt: NOW, confidence: 'high',
    compare: cmp({ pSessB: 600, pSessA: 600, ordB: 30, ordA: 60, storeCvrPct: 0 }),
    exposure: null, confoundedBy: [], confoundSignals: [] }));
  assert.strictEqual(labels.measurementSignalLabel, 'Collecting data');
  assert.strictEqual(labels.measurementDataSufficiency, 'insufficient');
});

// 18 — orders-only fallback → weak data quality, source orders_only
test('orders-only fallback → weak quality, orders_only source, no proof', () => {
  const d = buildDecisionV2({ status: 'measured', createdAt: OLD, confidence: 'high',
    compare: cmp({ pSessB: null, pSessA: null, ordB: 10, ordA: 20, revB: 1000, revA: 2000, ordPct: 100 }),
    exposure: null, confoundedBy: [], confoundSignals: [] });
  assert.strictEqual(d.primaryMetric, 'revenue_per_view');
  const labels = deriveMeasurementLabels(d);
  assert.ok(['insufficient','weak'].includes(labels.measurementDataQuality));
  assert.strictEqual(labels.measurementEvidenceSource, 'orders_only');
  // Weak source can never be called more than directional.
  assert.ok(['insufficient','directional'].includes(labels.measurementDataSufficiency));
});

// 19 — confoundFlags present → safe caveats surfaced
test('confoundFlags → merchant-safe caveats, no raw codes', () => {
  const labels = deriveMeasurementLabels({
    measurementStatus: 'decided', recommendedAction: 'keep', primaryMetric: 'product_cvr',
    confidenceScore: 80, dataQualityScore: 85,
    confoundFlags: ['store_revenue_spike', 'overlapping_execution', 'unknown_flag_xyz'],
  });
  assert.ok(labels.measurementCaveats.length >= 2);
  assert.ok(labels.measurementCaveats.every(c => !/_/.test(c)), 'no raw snake_case codes');
  // Strong score but active confounds → quality downgraded from good.
  assert.strictEqual(labels.measurementDataQuality, 'usable');
});

// 20 — strong product_cvr signal → high sufficiency but NEVER "significant"
test('strong measured signal → high sufficiency, never statistical-proof wording', () => {
  const labels = deriveMeasurementLabels({
    measurementStatus: 'decided', recommendedAction: 'keep', primaryMetric: 'product_cvr',
    confidenceScore: 90, dataQualityScore: 90, confoundFlags: [],
  });
  assert.strictEqual(labels.measurementDataSufficiency, 'high_sufficiency');
  assert.strictEqual(labels.measurementDataQuality, 'good');
  assert.match(labels.measurementDisclaimer, /not statistical proof/i);
});

// 21 — no merchant-facing string ever implies statistical proof
test('no derived label text implies statistical proof', () => {
  const samples = [
    deriveMeasurementLabels(null),
    deriveMeasurementLabels({ measurementStatus: 'decided', recommendedAction: 'keep',
      primaryMetric: 'product_cvr', confidenceScore: 99, dataQualityScore: 99, confoundFlags: [] }),
    deriveMeasurementLabels({ measurementStatus: 'decided', recommendedAction: 'undo_suggested',
      primaryMetric: 'exposure_atc_rate', confidenceScore: 70, dataQualityScore: 70, confoundFlags: ['low_traffic'] }),
  ];
  for (const s of samples) {
    const text = [s.measurementSignalLabel, s.measurementDisclaimer, ...s.measurementCaveats].join(' ');
    assert.ok(!FORBIDDEN.test(text), `forbidden proof wording in: ${text}`);
  }
});

// 22 — pure & null-safe
test('deriveMeasurementLabels is pure and null-safe', () => {
  const a = deriveMeasurementLabels(null);
  assert.strictEqual(a.measurementEvidenceSource, 'unknown');
  assert.strictEqual(a.measurementDataSufficiency, 'insufficient');
  assert.deepStrictEqual(a.measurementCaveats, []);
});
