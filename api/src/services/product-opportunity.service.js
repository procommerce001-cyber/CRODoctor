'use strict';

// ---------------------------------------------------------------------------
// product-opportunity.service.js  —  ProductOpportunityScore v1
//
// Pure, deterministic, no-schema product-selection intelligence. Given
// already-fetched product metrics (snapshot, performance profile, store
// baseline, eligible CRO issues), it ranks how much CRO opportunity a product
// represents — so CRODoctor optimizes the highest-impact product first instead
// of the most "severe" catalog issue.
//
// This module performs NO I/O: no Prisma, no Shopify, no network, no env, no
// side effects. Every input is a plain object; every output is deterministic
// and bounded. It is NOT wired into Action Center / Dashboard / routes yet —
// this is the scoring brain only.
//
// Score = 100 * ( 0.30*revenueUpside + 0.25*leakage + 0.20*traffic
//                 + 0.15*dataQuality + 0.10*interventionFit )
// final = clamp(0,100, score * (1 - riskPenalty)); hard exclusions force 0.
// ---------------------------------------------------------------------------

// ── tiny pure utilities ─────────────────────────────────────────────────────
const clamp = (lo, hi, n) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo);
const clamp01 = (n) => clamp(0, 1, n);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pos = (v) => { const n = num(v); return n != null && n > 0 ? n : null; };
const round2 = (n) => Math.round(n * 100) / 100;

// Saturating normalization: 0 at value 0, → 1 as value → ∞, half at `half`.
// Keeps huge-traffic products from dominating linearly.
function saturate(value, half) {
  const v = num(value);
  if (v == null || v <= 0) return 0;
  return clamp01(v / (v + half));
}

// ── v1 reference constants (deterministic, explainable) ──────────────────────
// Traffic reference: ~half score at 200 sessions/window. Tunable later.
const TRAFFIC_HALF = 200;
// Revenue-upside reference: ~half score at $500 recoverable/window.
const UPSIDE_HALF = 500;
// Minimum sessions before a product is measurable enough to actively optimize.
const MIN_TRAFFIC_SESSIONS = 50;
// Minimum orders for a product CVR to be trustworthy.
const MIN_ORDERS_FOR_CVR = 3;
// A funnel step must be at least this far below baseline (relative) to be a leak.
const LEAK_REL_GAP = 0.30;
// AOV must be this far below baseline to flag good_conversion_low_aov.
const AOV_REL_GAP = 0.30;
// Severe confound flag substrings (align with decisionV2 confoundFlags vocabulary).
const SEVERE_CONFOUNDS = ['store_revenue_spike', 'overlapping_execution', 'product_traffic_spike'];

// ---------------------------------------------------------------------------
// Funnel context — derive ratios from snapshot + baseline, null-safe.
// ---------------------------------------------------------------------------
function funnelContext(input) {
  const snap = (input && input.snapshot) || {};
  const profile = (input && input.profile) || {};
  const baseline = (input && input.storeBaseline) || {};

  const sessions = pos(snap.productSessions) ?? pos(profile.sessions);
  const atc      = num(snap.productAtcCount);
  const orders   = num(snap.orderCount);
  const revenue  = num(snap.revenue);
  const units    = num(snap.unitsSold);

  // Product-level ratios (only when denominators are meaningful).
  const atcRate = sessions ? clamp01((atc ?? 0) / sessions)
                : (num(profile.atcRate) != null ? clamp01(profile.atcRate) : null);
  const productCvr = sessions && orders != null ? (orders / sessions) : null;
  const atcToPurchase = pos(atc) && orders != null ? clamp01(orders / atc) : null;
  const productRpv = sessions && revenue != null ? (revenue / sessions) : null;
  const productAov = pos(orders) && revenue != null ? (revenue / orders) : null;

  // Store baseline — prefer explicit storeBaseline, else derive from snapshot store totals.
  const storeCvr = num(baseline.storeCvr)
    ?? (pos(snap.storeSessions) && num(snap.storeOrderCount) != null ? snap.storeOrderCount / snap.storeSessions : null);
  const storeRpv = num(baseline.storeRpv)
    ?? (pos(snap.storeSessions) && num(snap.storeRevenue) != null ? Number(snap.storeRevenue) / snap.storeSessions : null);
  const storeAtcRate = num(baseline.storeAtcRate);
  const storeAov = num(baseline.storeAov)
    ?? (pos(snap.storeOrderCount) && num(snap.storeRevenue) != null ? Number(snap.storeRevenue) / snap.storeOrderCount : null);

  return {
    sessions, atc, orders, revenue, units,
    atcRate, productCvr, atcToPurchase, productRpv, productAov,
    storeCvr, storeRpv, storeAtcRate, storeAov,
  };
}

// True when we simply don't have enough to judge a leak or score honestly.
function hasInsufficientData(f) {
  if (f.sessions == null || f.sessions < MIN_TRAFFIC_SESSIONS) return true;
  // Need at least one funnel signal beyond raw sessions.
  if (f.atcRate == null && f.productCvr == null && f.productRpv == null) return true;
  return false;
}

// ---------------------------------------------------------------------------
// detectPrimaryLeak(input) → leak label (pure, explainable thresholds).
// ---------------------------------------------------------------------------
function detectPrimaryLeak(input) {
  const f = funnelContext(input);
  if (hasInsufficientData(f)) return 'insufficient_data';

  const below = (val, base, gap = LEAK_REL_GAP) =>
    val != null && base != null && base > 0 && val < base * (1 - gap);

  // 1) view→ATC leak: traffic arrives, few add to cart.
  if (below(f.atcRate, f.storeAtcRate)) return 'low_view_to_atc';

  // Does the product convert at/above the store's CVR? When it does, a weak RPV
  // is an order-value problem, not a conversion problem — so we branch
  // differently. When CVR is unknown we treat it as "not clearly healthy".
  const convertsWell = f.productCvr != null && f.storeCvr != null &&
    f.productCvr >= f.storeCvr * (1 - LEAK_REL_GAP);

  if (convertsWell) {
    // 2a) Healthy conversion but low order value → cross-sell / bundle.
    if (below(f.productAov, f.storeAov, AOV_REL_GAP)) return 'good_conversion_low_aov';
    // 2b) Healthy conversion, low revenue per view not explained by AOV → offer/value.
    if (below(f.productRpv, f.storeRpv)) return 'low_revenue_per_view';
    return 'no_clear_leak';
  }

  // 3) Product underconverts (or CVR unknown): find where it drops.
  // 3a) Add-to-cart happens but purchase doesn't (need a real ATC sample).
  if (f.atcToPurchase != null && f.atcToPurchase < (1 - LEAK_REL_GAP) &&
      pos(f.atc) && f.atc >= MIN_ORDERS_FOR_CVR) {
    // High add-to-cart interest but weak close vs generic ATC→purchase drop.
    if (f.atcRate != null && f.storeAtcRate != null && f.atcRate >= f.storeAtcRate) {
      return 'high_interest_low_purchase';
    }
    return 'low_atc_to_purchase';
  }
  // 3b) Weak revenue per view as the visible symptom.
  if (below(f.productRpv, f.storeRpv)) return 'low_revenue_per_view';

  return 'no_clear_leak';
}

// Which leak stage a given eligible issue addresses (best-effort, null-safe).
const LEAK_TO_STAGE = {
  low_view_to_atc:          'view_to_atc',
  low_revenue_per_view:     'view_to_atc',
  low_atc_to_purchase:      'atc_to_purchase',
  high_interest_low_purchase:'atc_to_purchase',
  good_conversion_low_aov:  'aov',
};

// ---------------------------------------------------------------------------
// Sub-scores (each returns 0..1)
// ---------------------------------------------------------------------------
function trafficScore(f) {
  return saturate(f.sessions, TRAFFIC_HALF);
}

function revenueUpsideScore(f) {
  // Recoverable revenue = (baseline RPV − product RPV) over current traffic.
  if (f.productRpv == null || f.storeRpv == null || f.sessions == null) return 0;
  const gap = f.storeRpv - f.productRpv;
  if (gap <= 0) return 0;
  const recoverable = gap * f.sessions;
  return saturate(recoverable, UPSIDE_HALF);
}

function leakageScore(f, leak) {
  if (leak === 'insufficient_data' || leak === 'no_clear_leak') return 0;
  // Strength = how far below baseline the relevant step is, normalized.
  const rel = (val, base) => (val != null && base != null && base > 0)
    ? clamp01((base - val) / base) : 0;
  switch (leak) {
    case 'low_view_to_atc':           return clamp01(0.4 + rel(f.atcRate, f.storeAtcRate));
    case 'low_atc_to_purchase':       return clamp01(0.4 + (f.atcToPurchase != null ? (1 - f.atcToPurchase) : 0.3));
    case 'high_interest_low_purchase':return clamp01(0.5 + (f.atcToPurchase != null ? (1 - f.atcToPurchase) : 0.3));
    case 'low_revenue_per_view':      return clamp01(0.4 + rel(f.productRpv, f.storeRpv));
    case 'good_conversion_low_aov':   return clamp01(0.3 + rel(f.productAov, f.storeAov));
    default:                          return 0.3;
  }
}

function dataQualityScore(input, f) {
  const profile = (input && input.profile) || {};
  const confounds = Array.isArray(input && input.confoundFlags) ? input.confoundFlags : [];
  let q = 0;
  // Sessions sufficiency (up to 0.45).
  q += 0.45 * saturate(f.sessions, TRAFFIC_HALF);
  // Orders sufficiency (up to 0.35).
  q += 0.35 * saturate(f.orders, MIN_ORDERS_FOR_CVR * 4);
  // Analytics presence: real product sessions vs orders-only (0.20).
  const hasAnalytics = pos(f.sessions) != null && (f.atcRate != null || f.productCvr != null);
  q += hasAnalytics ? 0.20 : 0;
  // Penalties.
  if (Array.isArray(profile.dataGaps) && profile.dataGaps.length > 0) q -= 0.10 * Math.min(2, profile.dataGaps.length);
  if (confounds.length > 0) q -= 0.10 * Math.min(2, confounds.length);
  return clamp01(q);
}

function interventionFitScore(input, leak) {
  const issues = Array.isArray(input && input.eligibleIssues) ? input.eligibleIssues : [];
  if (issues.length === 0) return 0;
  if (leak === 'insufficient_data' || leak === 'no_clear_leak') return 0.5; // issues exist, no leak to match
  const wantStage = LEAK_TO_STAGE[leak] ?? null;
  const matched = wantStage && issues.some(i => i && i.leakStage === wantStage);
  return matched ? 1 : 0.5;
}

// ---------------------------------------------------------------------------
// Risk penalty (0..1) + hard exclusions.
// ---------------------------------------------------------------------------
function evaluateRisk(input, f) {
  const product   = (input && input.product) || {};
  const variants  = Array.isArray(input && input.variants) ? input.variants : null;
  const confounds = Array.isArray(input && input.confoundFlags) ? input.confoundFlags : [];

  // ── Hard exclusions (force score 0, band not_yet) ──
  // Out of stock: variants present and none available.
  if (variants && variants.length > 0 && variants.every(v => v && v.availableForSale === false)) {
    return { penalty: 1, excludedReason: 'Product is out of stock.' };
  }
  const status = typeof product.status === 'string' ? product.status.toLowerCase() : null;
  if (status === 'draft' || status === 'archived') {
    return { penalty: 1, excludedReason: `Product is ${status} (not live).` };
  }
  if (input && input.midMeasurement === true) {
    return { penalty: 1, excludedReason: 'Another change is mid-measurement on this product.' };
  }
  if (confounds.some(c => SEVERE_CONFOUNDS.includes(c))) {
    return { penalty: 1, excludedReason: 'External factors are distorting this product’s numbers.' };
  }
  if (f.sessions == null || f.sessions < MIN_TRAFFIC_SESSIONS) {
    return { penalty: 1, excludedReason: 'Not enough traffic to measure a change yet.' };
  }

  // ── Soft penalties (scale the score down, not out) ──
  let penalty = 0;
  // Recent merchant edit → cooldown risk.
  if (product.updatedAt) {
    const ageMs = Date.now() - new Date(product.updatedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 2 * 24 * 60 * 60 * 1000) penalty = Math.max(penalty, 0.5);
  }
  // Elevated refunds → unstable commercial signal.
  const refundRate = num((input && input.profile) ? input.profile.refundRate : null);
  if (refundRate != null && refundRate > 0.15) penalty = Math.max(penalty, 0.3);
  // Any non-severe confound still discounts.
  if (confounds.length > 0) penalty = Math.max(penalty, 0.3);

  return { penalty: clamp01(penalty), excludedReason: null };
}

// ---------------------------------------------------------------------------
// Band + data-confidence + estimated upside + merchant-friendly explanation.
// ---------------------------------------------------------------------------
function bandFor(score) {
  if (score >= 80) return 'top';
  if (score >= 60) return 'good';
  if (score >= 40) return 'monitor';
  return 'not_yet';
}

function dataConfidenceFor(dq, excluded, leak) {
  if (excluded || leak === 'insufficient_data') return 'insufficient';
  if (dq < 0.4) return 'weak';
  if (dq < 0.7) return 'usable';
  return 'good';
}

function estimatedUpside(f) {
  if (f.productRpv == null || f.storeRpv == null || f.sessions == null) return null;
  const gap = f.storeRpv - f.productRpv;
  if (gap <= 0) return null;
  return round2(gap * f.sessions);
}

// Merchant-friendly (not yet customer-facing). Confident, honest, never academic.
const LEAK_EXPLANATION = {
  low_view_to_atc:           'High traffic but few visitors add to cart — a hesitation problem worth fixing first.',
  low_atc_to_purchase:       'Visitors add to cart but stop before buying — worth reducing checkout friction.',
  high_interest_low_purchase:'Strong add-to-cart interest but weak purchase follow-through — reassurance could close more sales.',
  low_revenue_per_view:      'Traffic converts but earns less per visit than the store average — an offer/value clarity opportunity.',
  good_conversion_low_aov:   'Converts well but with a low order value — a cross-sell or bundle could lift revenue.',
  insufficient_data:         'Still collecting enough data to judge this product.',
  no_clear_leak:             'This product is already performing in line with the store — monitor for now.',
};

function explanationFor(leak, band, upside) {
  const base = LEAK_EXPLANATION[leak] ?? LEAK_EXPLANATION.no_clear_leak;
  if (band === 'top' && upside) return `${base} Estimated upside ~$${upside} if conversion reaches the store baseline.`;
  return base;
}

// ---------------------------------------------------------------------------
// computeProductOpportunity(input) → full result. Pure, null-safe, bounded.
// ---------------------------------------------------------------------------
function computeProductOpportunity(input) {
  const productId = (input && input.productId) ?? ((input && input.product) ? input.product.id : null) ?? null;
  const f = funnelContext(input || {});
  const leak = detectPrimaryLeak(input || {});
  const risk = evaluateRisk(input || {}, f);

  const sub = {
    traffic:         round2(trafficScore(f)),
    revenueUpside:   round2(revenueUpsideScore(f)),
    leakage:         round2(leakageScore(f, leak)),
    dataQuality:     round2(dataQualityScore(input || {}, f)),
    interventionFit: round2(interventionFitScore(input || {}, leak)),
  };

  const raw = 100 * (
    0.30 * sub.revenueUpside +
    0.25 * sub.leakage +
    0.20 * sub.traffic +
    0.15 * sub.dataQuality +
    0.10 * sub.interventionFit
  );

  const excluded = risk.excludedReason != null;
  const opportunityScore = excluded ? 0 : Math.round(clamp(0, 100, raw * (1 - risk.penalty)));
  const band = excluded ? 'not_yet' : bandFor(opportunityScore);
  const dataConfidence = dataConfidenceFor(sub.dataQuality, excluded, leak);
  const estimatedRevenueUpside = excluded ? null : estimatedUpside(f);

  return {
    productId,
    opportunityScore,
    band,
    subScores: sub,
    estimatedRevenueUpside,
    primaryLeak: leak,
    riskPenalty: round2(risk.penalty),
    excludedReason: risk.excludedReason,
    dataConfidence,
    recommendedFocus: LEAK_TO_STAGE[leak] ?? null,
    explanation: excluded
      ? (risk.excludedReason)
      : explanationFor(leak, band, estimatedRevenueUpside),
  };
}

// ---------------------------------------------------------------------------
// rankProductOpportunities(inputs) → results sorted desc by score.
// Pure: never mutates the input array. Deterministic tie-break by input order.
// ---------------------------------------------------------------------------
function rankProductOpportunities(inputs) {
  const list = Array.isArray(inputs) ? inputs : [];
  return list
    .map((input, idx) => ({ idx, result: computeProductOpportunity(input) }))
    .sort((a, b) =>
      (b.result.opportunityScore - a.result.opportunityScore) || (a.idx - b.idx))
    .map(x => x.result);
}

module.exports = {
  computeProductOpportunity,
  detectPrimaryLeak,
  rankProductOpportunities,
};
