// ---------------------------------------------------------------------------
// measurement-labels.js
//
// Pure, no-schema interpretation layer (DATA #2B).
//
// Maps the ALREADY-COMPUTED decisionV2 object (built by buildDecisionV2 in
// metrics.service.js) into honest, merchant-facing measurement labels. This
// file adds NO new inference: it does not compute p-values, run A/B tests,
// model attribution, or touch the database. It only relabels existing
// decisionV2 signals so the UI never implies "statistical proof" or
// "confirmed lift" when the real state is data sufficiency / directional
// signal / early measurement.
//
// All outputs are derived deterministically from fields decisionV2 already
// exposes: measurementStatus, recommendedAction, primaryMetric,
// confidenceScore, dataQualityScore, confoundFlags. Pure & synchronous.
// ---------------------------------------------------------------------------

'use strict';

// Map a decisionV2 confoundFlag (or internal reason code) → a short, plain,
// merchant-safe caveat. Unknown flags are dropped (never shown as raw codes).
const CAVEAT_COPY = {
  overlapping_execution: 'Another change overlapped this one, so the result is harder to attribute.',
  store_revenue_spike:   'A store-wide sales change happened during measurement.',
  product_traffic_spike: 'This product saw unusual traffic during measurement.',
  inventory_depletion:   'Inventory changed during measurement.',
  low_traffic:           'Traffic was low during the measurement window.',
  traffic_unstable:      'Traffic was unstable during the measurement window.',
  missing_analytics:     'Some analytics data was missing for this window.',
  price_change:          'The product price changed during measurement.',
  manual_edit_risk:      'The product was also edited manually during measurement.',
};

// decisionV2.primaryMetric → which underlying evidence the signal rests on.
function evidenceSourceFor(d) {
  switch (d && d.primaryMetric) {
    case 'product_cvr':       return 'product_metrics_snapshot';
    case 'exposure_atc_rate': return 'first_party_events';
    case 'revenue_per_view':  return 'orders_only';
    default:
      // No measured primary metric yet, but a decisionV2 exists (waiting/cooldown).
      return d ? 'decision_v2' : 'unknown';
  }
}

// A measured primary metric exists only once we've left the waiting branch.
function isMeasured(d) {
  return !!d &&
    d.measurementStatus !== 'not_started' &&
    d.measurementStatus !== 'cooling_down' &&
    d.measurementStatus !== 'measuring' &&
    d.primaryMetric != null;
}

// Weaker evidence sources can never be called more than "directional", no
// matter how high the raw scores read — they are not a randomized holdout.
function isWeakSource(d) {
  return d && (d.primaryMetric === 'exposure_atc_rate' || d.primaryMetric === 'revenue_per_view');
}

// ── Data sufficiency: how much usable observation backs the signal. ──────────
function dataSufficiencyFor(d) {
  if (!isMeasured(d)) return 'insufficient';
  const dq = typeof d.dataQualityScore === 'number' ? d.dataQualityScore : 0;
  let band;
  if (dq < 40)      band = 'insufficient';
  else if (dq < 60) band = 'directional';
  else if (dq < 80) band = 'moderate';
  else              band = 'high_sufficiency';
  // Cap weaker sources at directional — exposure/orders-only are not proof-grade.
  if (isWeakSource(d) && (band === 'moderate' || band === 'high_sufficiency')) {
    band = 'directional';
  }
  return band;
}

// ── Data quality: how trustworthy the underlying metrics are. ────────────────
function dataQualityFor(d) {
  if (!d || typeof d.dataQualityScore !== 'number') return 'insufficient';
  const dq = d.dataQualityScore;
  const hasConfounds = Array.isArray(d.confoundFlags) && d.confoundFlags.length > 0;
  // Orders-only fallback is structurally weak regardless of score.
  if (d.primaryMetric === 'revenue_per_view') return dq < 35 ? 'insufficient' : 'weak';
  if (dq < 35)      return 'insufficient';
  if (dq < 60)      return 'weak';
  if (dq < 80)      return 'usable';
  // Strong score but with active confounds → downgrade to usable, not good.
  return hasConfounds ? 'usable' : 'good';
}

// ── Signal label: the short merchant-facing headline. Never claims proof. ────
function signalLabelFor(d, sufficiency) {
  if (!isMeasured(d)) {
    if (!d || d.measurementStatus === 'not_started') return 'Not enough data yet';
    return 'Collecting data'; // cooling_down / measuring
  }
  if (sufficiency === 'insufficient') return 'Not enough data yet';
  switch (d.recommendedAction) {
    case 'keep':                  return 'Early positive signal';
    case 'stack_next_change':     return 'Early positive signal';
    case 'undo_suggested':        return 'Possible negative signal';
    case 'neutral_no_clear_lift': return 'Neutral so far';
    case 'try_alternative':       return 'Neutral so far';
    case 'measurement_expired':   return 'Not enough data yet';
    case 'manual_review':         return 'Measured, preliminary';
    default:                      return 'Measured, preliminary';
  }
}

// Merchant-facing disclaimer. Honest about it being an in-progress measurement,
// but framed as confident, value-positive monitoring — never academic
// "no proof" wording (that internal nuance lives in the scores/caveats, not here).
function disclaimerFor(sufficiency) {
  return sufficiency === 'insufficient'
    ? 'Collecting more data before making a final recommendation.'
    : 'Tracking impact — we’ll confirm as more visitors see this change.';
}

function caveatsFor(d) {
  if (!d || !Array.isArray(d.confoundFlags)) return [];
  const out = [];
  for (const flag of d.confoundFlags) {
    const copy = CAVEAT_COPY[flag];
    if (copy && !out.includes(copy)) out.push(copy);
  }
  return out;
}

// ---------------------------------------------------------------------------
// deriveMeasurementLabels(decisionV2) → additive, merchant-safe labels.
// Pure. Safe on null/partial input. Never throws.
// ---------------------------------------------------------------------------
function deriveMeasurementLabels(decisionV2) {
  const d = decisionV2 || null;
  const measurementDataSufficiency = dataSufficiencyFor(d);
  return {
    measurementDataSufficiency,
    measurementDataQuality:  dataQualityFor(d),
    measurementSignalLabel:  signalLabelFor(d, measurementDataSufficiency),
    measurementDisclaimer:   disclaimerFor(measurementDataSufficiency),
    measurementEvidenceSource: evidenceSourceFor(d),
    measurementCaveats:      caveatsFor(d),
  };
}

module.exports = { deriveMeasurementLabels };
