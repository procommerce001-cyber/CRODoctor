'use strict';

// ---------------------------------------------------------------------------
// copy-plan.js
//
// Barrier-first copy planning layer — Phase B2 Part B.
// Scope: weak_desire_creation only. Transient — never persisted.
//
// buildCopyPlan(product, profile) → CopyPlan | null
//
// CopyPlan fields:
//   barrier          — primary buying barrier: trust|risk|value|fit|urgency
//   proofStyle       — evidence type that defeats this barrier
//   riskReversalStyle — copy approach for handling perceived risk
//   emotionalFrame   — tone register: belonging|relief|aspiration|recognition|loss
//   toneKey          — writing voice: social|empathetic|confident
//   structureKey     — narrative arc passed to desire-block.js (A|B|C|D)
//   priceTier        — low|mid|high (derived from lowest variant price)
//   trafficQuality   — intent|cold|mixed|unknown (derived from profile)
//   archetype        — ProductPerformanceProfile.archetype, or null
//
// Returns null on any error — all callers must fall back to existing behavior.
// ---------------------------------------------------------------------------

const LOW_PRICE_MAX      = 30;   // below this → low tier (impulse)
const HIGH_PRICE_MIN     = 150;  // at or above this → high tier (considered)
const MIN_TRAFFIC_ORDERS = 5;    // below this → traffic quality unknown
const INTENT_THRESHOLD   = 0.60; // organic + direct fraction → intent traffic
const COLD_THRESHOLD     = 0.60; // paid + social fraction → cold traffic

// ---------------------------------------------------------------------------
// derivePriceTier — pure, from product variants
// ---------------------------------------------------------------------------
function derivePriceTier(minPrice) {
  if (!minPrice || minPrice <= 0) return 'mid';
  if (minPrice < LOW_PRICE_MAX)   return 'low';
  if (minPrice >= HIGH_PRICE_MIN) return 'high';
  return 'mid';
}

// ---------------------------------------------------------------------------
// deriveTrafficQuality — pure, from ProductPerformanceProfile fields
// Returns 'unknown' when profile is absent or sample is too small.
// ---------------------------------------------------------------------------
function deriveTrafficQuality(profile) {
  if (!profile)                                              return 'unknown';
  if ((profile.trafficOrdersN ?? 0) < MIN_TRAFFIC_ORDERS)  return 'unknown';
  const intent = (profile.trafficOrganic ?? 0) + (profile.trafficDirect ?? 0);
  const cold   = (profile.trafficPaid    ?? 0) + (profile.trafficSocial ?? 0);
  if (intent >= INTENT_THRESHOLD) return 'intent';
  if (cold   >= COLD_THRESHOLD)   return 'cold';
  return 'mixed';
}

// ---------------------------------------------------------------------------
// deriveBarrier — approved minimal inference rules from Phase B2 design doc.
// Pure — no I/O.
//
// atcRate: ProductPerformanceProfile.atcRate (null when no analytics data).
// Low-price products fire 'fit' only when ATC rate is < 0.01 or unknown;
// a product with a healthy ATC rate has no funnel-drop to address and
// falls through to the default 'value' barrier.
// ---------------------------------------------------------------------------
function deriveBarrier(priceTier, trafficQuality, archetype, atcRate) {
  if (priceTier === 'high' && trafficQuality === 'cold')                      return 'risk';
  if (priceTier === 'high' && trafficQuality === 'intent')                    return 'value';
  if (priceTier === 'mid'  && trafficQuality === 'cold')                      return 'trust';
  if (priceTier === 'mid'  && trafficQuality === 'intent')                    return 'value';
  if (priceTier === 'low'  && !(atcRate >= 0.01))                             return 'fit';
  if (archetype === 'growth' && trafficQuality === 'mixed')                   return 'fit';
  return 'value';
}

// ---------------------------------------------------------------------------
// PLAN_MAP — full persuasion parameters keyed by barrier.
//
// structureKey maps to narrative arc in desire-block.js:
//   A: anchor → pivot → resolution → closer   (aspiration-led)
//   B: tension → anchor → pivot → resolution  (problem/risk-led, names fear first)
//   C: anchor → tension → pivot → resolution  (situate reader, then reveal pain)
//   D: pivot → anchor → resolution → closer   (outcome-first; reserved for future use)
// ---------------------------------------------------------------------------
const PLAN_MAP = {
  trust: {
    proofStyle:        'social',
    riskReversalStyle: 'none',
    emotionalFrame:    'belonging',
    toneKey:           'social',
    structureKey:      'B', // surface tension first builds recognition before the pivot
  },
  risk: {
    proofStyle:        'money_back',
    riskReversalStyle: 'money_back',
    emotionalFrame:    'relief',
    toneKey:           'empathetic',
    structureKey:      'B', // name the fear before defusing it
  },
  value: {
    proofStyle:        'results',
    riskReversalStyle: 'none',
    emotionalFrame:    'aspiration',
    toneKey:           'confident',
    structureKey:      'A', // aspiration-led: desire precedes features
  },
  fit: {
    proofStyle:        'use_case',
    riskReversalStyle: 'none',
    emotionalFrame:    'recognition',
    toneKey:           'empathetic',
    structureKey:      'C', // anchor reader's situation, then reveal tension
  },
  urgency: {
    proofStyle:        'scarcity',
    riskReversalStyle: 'none',
    emotionalFrame:    'loss',
    toneKey:           'confident',
    structureKey:      'A', // aspiration with momentum from closer
  },
};

// ---------------------------------------------------------------------------
// buildCopyPlan — main export.
//
// product — rawProduct or croProduct (needs variants[].price + bodyHtml)
// profile — ProductPerformanceProfile row or null
//
// Returns a CopyPlan object, or null if inputs are insufficient or an error
// is thrown. Callers treat null as "use existing generation unchanged."
// ---------------------------------------------------------------------------
function buildCopyPlan(product, profile) {
  try {
    const prices = (product.variants || [])
      .map(v => parseFloat(String(v.price)))
      .filter(p => !isNaN(p) && p > 0);
    const minPrice       = prices.length > 0 ? Math.min(...prices) : 0;
    const priceTier      = derivePriceTier(minPrice);
    const trafficQuality = deriveTrafficQuality(profile);
    const archetype      = profile?.archetype ?? null;
    const atcRate        = profile?.atcRate   ?? null;
    const barrier        = deriveBarrier(priceTier, trafficQuality, archetype, atcRate);
    const planDefaults   = PLAN_MAP[barrier] ?? PLAN_MAP.value;

    return {
      barrier,
      ...planDefaults,
      priceTier,
      trafficQuality,
      archetype,
    };
  } catch (_) {
    return null;
  }
}

module.exports = { buildCopyPlan };
