'use strict';

const DEFAULT_CONFIG = require('./phase2-config');

// ---------------------------------------------------------------------------
// Product performance archetypes
// ---------------------------------------------------------------------------
const ARCHETYPES = {
  CONTENT_BOTTLENECK: 'content_bottleneck',
  TRAFFIC_PROBLEM:    'traffic_problem',
  PRICING_SIGNAL:     'pricing_signal',
  TRUST_MISMATCH:     'trust_mismatch',
  PERFORMING:         'performing',
  UNCLASSIFIED:       'unclassified',
};

// ---------------------------------------------------------------------------
// classifyArchetype
//
// Pure function — no DB calls, no side effects, no async.
// Takes a product performance profile snapshot and returns an archetype
// classification with the signals and data gaps that produced it.
//
// Gate evaluation order is strict. First matching gate wins. Do not reorder.
//
// Input:
//   sessions          {number|null}  — page sessions in the profile window
//   atcRate           {number|null}  — add-to-cart rate as decimal (e.g. 0.03 = 3%)
//   orderCount        {number}       — total qualifying orders in the window (default 0)
//   refundRate        {number|null}  — refund rate as decimal; null if orderCount < REFUND_MIN_ORDERS
//   variantSkewPct    {number|null}  — fraction of orders on the cheapest variant (0–1)
//   trafficQualified  {boolean|null} — true: qualified intent, false: low-intent, null: unknown
//   previousArchetype {string|null}  — last stored archetype (used for hysteresis)
//   config            {object}       — threshold overrides (defaults to phase2-config)
//
// Output:
//   archetype         {string}   — one of ARCHETYPES values
//   archetypeConf     {string}   — 'high' | 'low' (classification confidence)
//   archetypeSignals  {object}   — the input values that drove the result
//   dataGaps          {string[]} — missing or weak data that limited classification
// ---------------------------------------------------------------------------
function classifyArchetype({
  sessions,
  atcRate,
  orderCount     = 0,
  refundRate,
  variantSkewPct,
  trafficQualified,
  previousArchetype = null,
  config: cfg       = DEFAULT_CONFIG,
} = {}) {
  const dataGaps = [];

  function result(archetype, archetypeConf, extra = {}) {
    return {
      archetype,
      archetypeConf,
      archetypeSignals: {
        sessions,
        atcRate,
        orderCount,
        refundRate,
        variantSkewPct,
        trafficQualified,
        previousArchetype,
        ...extra,
      },
      dataGaps: [...dataGaps],
    };
  }

  // ── GATE 0: no session data — record gap and continue ───────────────────
  // Shopify Analytics scope absent or plan limitation. Gate 2 (trust_mismatch)
  // can still fire from order-derived signals; all later ATC-dependent gates
  // naturally skip because atcRate is also null in this case.
  if (sessions === null || sessions === undefined) {
    dataGaps.push('sessions_unavailable');
  }

  // ── GATE 1: traffic problem (with hysteresis) ────────────────────────────
  // Always fires if sessions < HYSTERESIS threshold — no amount of prior
  // classification holds a product this low.
  // Also fires if sessions < MIN and the product was NOT previously classified
  // as content_bottleneck — hysteresis only applies in the band [HYSTERESIS, MIN).
  const isBelowHysteresis = sessions < cfg.TRAFFIC_HYSTERESIS_SESSIONS;
  const isBelowMin        = sessions < cfg.TRAFFIC_MIN_SESSIONS;
  const holdingBottleneck = previousArchetype === ARCHETYPES.CONTENT_BOTTLENECK;

  if (sessions !== null && (isBelowHysteresis || (isBelowMin && !holdingBottleneck))) {
    dataGaps.push('insufficient_traffic');
    return result(ARCHETYPES.TRAFFIC_PROBLEM, 'high', { gate: 'GATE_1' });
  }

  // ── GATE 2: trust mismatch ───────────────────────────────────────────────
  // Product is converting (atcRate adequate or unknown) but refund rate is
  // high — description over-promises or misrepresents the product.
  // Blocked when orderCount < REFUND_MIN_ORDERS: sample too small to compute
  // a reliable refund rate, so refundRate will be null.
  // The atcRate guard (>= 0.01) prevents misclassifying a near-zero-converting
  // product as a trust problem rather than a content problem.
  const refundRateKnown = refundRate !== null && refundRate !== undefined;
  if (
    orderCount >= cfg.REFUND_MIN_ORDERS &&
    refundRateKnown &&
    refundRate > cfg.REFUND_RATE_THRESHOLD &&
    (atcRate === null || atcRate === undefined || atcRate >= 0.01)
  ) {
    // "Well above" threshold: >= 1.2× provides clear signal vs. borderline
    const conf = refundRate >= cfg.REFUND_RATE_THRESHOLD * 1.2 ? 'high' : 'low';
    return result(ARCHETYPES.TRUST_MISMATCH, conf, { gate: 'GATE_2' });
  }

  // ── Shared pre-computation for gates 3 and 4 ────────────────────────────
  const hasLowAtc = atcRate !== null && atcRate !== undefined &&
                    atcRate < cfg.ATC_RATE_BOTTLENECK_THRESHOLD;

  // ── GATE 3: pricing / variant / merchandising signal ─────────────────────
  // Low ATC combined with strong variant skew toward cheapest option indicates
  // a price-to-value problem, not a description quality problem.
  if (hasLowAtc) {
    const variantKnown = variantSkewPct !== null && variantSkewPct !== undefined;

    if (variantKnown && variantSkewPct >= cfg.VARIANT_SKEW_THRESHOLD) {
      return result(ARCHETYPES.PRICING_SIGNAL, 'high', { gate: 'GATE_3' });
    }

    // Track the gap only when variant data would have been decisive
    if (!variantKnown) {
      dataGaps.push('variant_data_insufficient');
    }
  }

  // ── GATE 4: content-layer conversion bottleneck ──────────────────────────
  // Low ATC, no variant skew signal, and traffic is either qualified or
  // unknown. Unknown traffic (null) is allowed through at reduced confidence
  // so new stores without traffic attribution still get recommendations.
  // trafficQualified === false (confirmed low-intent traffic) blocks this gate.
  if (hasLowAtc && trafficQualified !== false) {
    const conf = trafficQualified === true ? 'high' : 'low';
    return result(ARCHETYPES.CONTENT_BOTTLENECK, conf, { gate: 'GATE_4' });
  }

  // ── GATE 5: performing ───────────────────────────────────────────────────
  // Adequate ATC rate and low refund rate — product page is working.
  const hasAdequateAtc = atcRate !== null && atcRate !== undefined &&
                         atcRate >= cfg.ATC_RATE_PERFORMING_THRESHOLD;
  const lowRefund      = !refundRateKnown || refundRate < cfg.REFUND_RATE_THRESHOLD;

  if (hasAdequateAtc && lowRefund) {
    return result(ARCHETYPES.PERFORMING, 'high', { gate: 'GATE_5' });
  }

  // ── FALLTHROUGH ──────────────────────────────────────────────────────────
  // Signals exist but don't fit a clear pattern. Treated identically to
  // traffic_problem for gating purposes: no ranked recommendations.
  // Common causes: atcRate in the gray zone (>= 0.03 and < 0.05),
  // unqualified traffic with low ATC, or ambiguous refund/ATC combination.
  dataGaps.push('ambiguous_signals');
  return result(ARCHETYPES.UNCLASSIFIED, 'low', { gate: 'FALLTHROUGH' });
}

module.exports = { classifyArchetype, ARCHETYPES };
