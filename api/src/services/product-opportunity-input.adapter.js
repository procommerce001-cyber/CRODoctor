'use strict';

// ---------------------------------------------------------------------------
// product-opportunity-input.adapter.js
//
// Pure adapter + diagnostics builder for ProductOpportunityScore (PR A —
// internal, flag-gated diagnostics only). This is the "dark diagnostics"
// glue described in docs/product-opportunity-score-wiring-plan.md (Option A).
//
// Responsibilities:
//   - decide whether diagnostics are enabled (env flag, default OFF)
//   - map already-fetched runtime data (raw product + LLM-free actions +
//     performance profile) into the ProductOpportunityScore input shape
//   - build a ranked, internal-oriented diagnostics payload that HONESTLY
//     surfaces the two known runtime data gaps instead of papering over them.
//
// Guarantees (mirrors product-opportunity.service.js):
//   - NO I/O: no Prisma, no Shopify, no network, no side effects.
//   - Deterministic and null-safe: every field is optional.
//   - Never mutates its inputs.
//   - Never invents a store baseline and never invents a leakStage mapping.
//     When those are absent, the limitation is preserved and reported.
// ---------------------------------------------------------------------------

const { rankProductOpportunities } = require('./product-opportunity.service');

// Feature flag — opt-in, default OFF. Matches the existing env-flag convention
// used by RATE_LIMIT_ENABLED / CRO_EXCLUDE_TEST_ORDERS.
const FLAG = 'PRODUCT_OPPORTUNITY_DIAGNOSTICS';

function isDiagnosticsEnabled(env = process.env) {
  return !!env && env[FLAG] === 'true';
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ---------------------------------------------------------------------------
// toScoringBaseline(storeBaseline) → ProductOpportunityScore storeBaseline
// ({ storeCvr, storeRpv, storeAtcRate, storeAov }) or null. Pure.
//
// Maps the Store Baseline Engine contract onto the scoring contract:
//   storeCvr     ← metrics.storeConversionRate  (paired Σorders / Σsessions, profile window)
//   storeRpv     ← metrics.revenuePerSession    (null unless same-window revenue exists)
//   storeAtcRate ← distribution.medianAtcRate   (per-product atc / sessions — same
//                  denominator as the scoring layer's product atcRate)
//   storeAov     ← metrics.averageOrderValue    (dedicated AOV pair)
// Returns null unless reliability is 'usable' or 'good' (a 'weak' baseline lacks
// either a denominator or orders, e.g. storeCvr = 0 for a zero-order store), or
// when no metric is usable — scoring then behaves exactly as before.
// ---------------------------------------------------------------------------
const SCORABLE_BASELINE_LEVELS = new Set(['usable', 'good']);

function toScoringBaseline(storeBaseline) {
  if (!storeBaseline || typeof storeBaseline !== 'object') return null;
  const level = storeBaseline.reliability && storeBaseline.reliability.level;
  if (!SCORABLE_BASELINE_LEVELS.has(level)) return null;
  const metrics = storeBaseline.metrics || {};
  const distribution = storeBaseline.distribution || {};
  const mapped = {
    storeCvr:     num(metrics.storeConversionRate),
    storeRpv:     num(metrics.revenuePerSession),
    storeAtcRate: num(distribution.medianAtcRate),
    storeAov:     num(metrics.averageOrderValue),
  };
  return Object.values(mapped).some((x) => x != null) ? mapped : null;
}

// ---------------------------------------------------------------------------
// alignProfileWindows(contexts) → contexts whose profile is from the newest
// capture (same capturedAt + windowDays); any other profile is replaced by null
// and flagged staleProfile, so a product's old 28-day window is never compared
// with — or folded into — the current store baseline. Pure: returns copies.
// ---------------------------------------------------------------------------
function profileCaptureTime(profile) {
  if (!profile || profile.capturedAt == null) return null;
  const t = new Date(profile.capturedAt).getTime();
  return Number.isFinite(t) ? t : null;
}

function alignProfileWindows(contexts) {
  const list = Array.isArray(contexts) ? contexts : [];
  let latest = null;
  let latestDays = null;
  for (const c of list) {
    const t = profileCaptureTime(c && c.profile);
    if (t != null && (latest == null || t > latest)) { latest = t; latestDays = c.profile.windowDays; }
  }
  return list.map((c) => {
    if (!c || !c.profile) return c;
    const current = latest != null && profileCaptureTime(c.profile) === latest &&
      c.profile.windowDays === latestDays;
    return current ? c : { ...c, profile: null, staleProfile: true };
  });
}

// ---------------------------------------------------------------------------
// toOpportunityInput(ctx, scoringBaseline?) → ProductOpportunityScore input
// (pure, null-safe).
//
// ctx = {
//   rawProduct: Prisma product row (with variants[], status, updatedAt),
//   actions:    LLM-free action items from listProductRecommendations (no leakStage),
//   profile:    latest ProductPerformanceProfile row (sessions/atcRate often null),
//   aovRevenue, aovOrders: optional same-window AOV pair (latest standalone
//               ProductMetricsSnapshot) — used ONLY for product AOV,
// }
// scoringBaseline: output of toScoringBaseline, or null/undefined.
//
// Honesty rules:
//   - storeBaseline is set only when a real baseline was mapped; else omitted.
//   - eligibleIssues carry NO leakStage — real issues are not tagged with one.
//   - snapshot fields are only set when a real value exists; nulls stay null.
//   - Funnel orders come from the profile (same rolling window as sessions/atc).
//     Cumulative snapshot revenue is NEVER passed as funnel revenue, so revenue
//     per session (and any $ upside) stays null rather than mixing windows.
// ---------------------------------------------------------------------------
function toOpportunityInput(ctx = {}, scoringBaseline = null) {
  const rawProduct = (ctx && ctx.rawProduct) || {};
  const actions = Array.isArray(ctx && ctx.actions) ? ctx.actions : [];
  const profile = (ctx && ctx.profile) || null;

  const productId = rawProduct.id ?? null;

  const variants = Array.isArray(rawProduct.variants)
    ? rawProduct.variants.map((v) => ({ availableForSale: v && v.availableForSale }))
    : [];

  // Profile-derived signals. These are frequently null in runtime today
  // (product-level analytics not yet populated) — we pass them through as-is.
  const sessions = num(profile && profile.sessions);
  const atcCount = num(profile && profile.atcCount);
  const atcRate  = num(profile && profile.atcRate);

  // eligibleIssues: honest map — issueId + riskLevel only. No leakStage exists
  // on real issues, so interventionFit will stay at its neutral value. We do
  // NOT synthesize a leakStage.
  const eligibleIssues = actions
    .filter((a) => a && a.issueId)
    .map((a) => ({ issueId: a.issueId, riskLevel: a.riskLevel ?? null }));

  const input = {
    productId,
    product: {
      id: productId,
      status: rawProduct.status ?? null,
      updatedAt: rawProduct.updatedAt ?? null,
    },
    variants,
    eligibleIssues,
    // snapshot: only what we actually have. Funnel orders share the profile's
    // window; revenue enters only as the dedicated AOV pair (see honesty rules).
    snapshot: {
      productSessions: sessions,
      productAtcCount: atcCount,
      orderCount: num(profile && profile.orderCount),
      aovRevenue: num(ctx && ctx.aovRevenue),
      aovOrders: num(ctx && ctx.aovOrders),
    },
    profile: {
      sessions,
      atcRate,
      refundRate: num(profile && profile.refundRate),
      dataGaps: Array.isArray(profile && profile.dataGaps) ? profile.dataGaps : [],
      archetype: (profile && profile.archetype) ?? null,
    },
    confoundFlags: [],
  };
  if (scoringBaseline) input.storeBaseline = { ...scoringBaseline };
  if (ctx && ctx.staleProfile) input.staleProfile = true;

  return input;
}

// Per-product honesty notes: why a score is low/excluded, and which gaps apply.
function diagnosticNotes(input, result) {
  const notes = [];
  // Global-but-restated-per-product: no baseline means leakage/upside are blind.
  if (!input.storeBaseline) notes.push('no_store_baseline');
  if (input.staleProfile) notes.push('stale_profile');
  // No leakStage on any eligible issue → interventionFit cannot be matched.
  const hasIssues = Array.isArray(input.eligibleIssues) && input.eligibleIssues.length > 0;
  const anyLeakStage = hasIssues && input.eligibleIssues.some((i) => i && i.leakStage);
  if (hasIssues && !anyLeakStage) notes.push('no_leakstage_on_eligible_issues');
  if (result && result.primaryLeak === 'insufficient_data') notes.push('insufficient_sessions');
  if (result && result.excludedReason) notes.push('excluded');
  return notes;
}

// ---------------------------------------------------------------------------
// buildOpportunityDiagnostics(contexts, options?) → internal diagnostics payload (pure).
//
// contexts: array of ctx objects (see toOpportunityInput).
// options.storeBaseline: optional Store Baseline Engine output (buildStoreBaseline);
//   mapped via toScoringBaseline and applied to every product.
// Uses rankProductOpportunities so ordering matches the service's own ranking.
// This is diagnostics only — it does NOT feed any merchant-facing ranking.
// ---------------------------------------------------------------------------
function buildOpportunityDiagnostics(contexts = [], options = {}) {
  const list = Array.isArray(contexts) ? contexts : [];
  const scoringBaseline = toScoringBaseline(options && options.storeBaseline);
  const inputs = list.map((c) => toOpportunityInput(c, scoringBaseline));

  // Correlate ranked results back to their input by productId for note-building.
  const inputById = new Map();
  for (const inp of inputs) {
    if (inp.productId != null && !inputById.has(inp.productId)) inputById.set(inp.productId, inp);
  }

  const ranked = rankProductOpportunities(inputs);

  const products = ranked.map((result) => {
    const input = inputById.get(result.productId) || {};
    return { ...result, notes: diagnosticNotes(input, result) };
  });

  // Global data-gap flags — the honest headline of this diagnostics pass.
  const anyIssues = inputs.some(
    (i) => Array.isArray(i.eligibleIssues) && i.eligibleIssues.length > 0
  );
  const anyLeakStage = inputs.some(
    (i) => Array.isArray(i.eligibleIssues) && i.eligibleIssues.some((x) => x && x.leakStage)
  );

  return {
    enabled: true,
    flag: FLAG,
    dataGaps: {
      // True when no usable store baseline reached scoring (absent/insufficient).
      noStoreBaseline: !scoringBaseline,
      // Real issues are not tagged with leakStage, so interventionFit is blind.
      noLeakStageMapping: anyIssues ? !anyLeakStage : true,
      // No revenue in the same window as sessions → revenue-per-session and
      // estimated $ upside stay null by design (never mixed with cumulative data).
      noSameWindowRevenue: !inputs.some((i) => i.snapshot && num(i.snapshot.revenue) != null),
      // Reliability of the store baseline offered to scoring (null when absent).
      baselineReliability: (options && options.storeBaseline && options.storeBaseline.reliability &&
        options.storeBaseline.reliability.level) || null,
      // Products whose latest profile was not from the newest capture window.
      staleProfiles: inputs.filter((i) => i.staleProfile).length,
    },
    note:
      'Internal diagnostics only. Scores are NOT used for any merchant-facing ' +
      'ranking. Issue leakStage and same-window revenue are not yet available in ' +
      'runtime; products without product-level sessions read as insufficient.',
    count: products.length,
    products,
  };
}

module.exports = {
  FLAG,
  isDiagnosticsEnabled,
  toScoringBaseline,
  alignProfileWindows,
  toOpportunityInput,
  diagnosticNotes,
  buildOpportunityDiagnostics,
};
