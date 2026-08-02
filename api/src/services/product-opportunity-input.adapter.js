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
// toOpportunityInput(ctx) → ProductOpportunityScore input (pure, null-safe).
//
// ctx = {
//   rawProduct: Prisma product row (with variants[], status, updatedAt),
//   actions:    LLM-free action items from listProductRecommendations (no leakStage),
//   profile:    latest ProductPerformanceProfile row (sessions/atcRate often null),
// }
//
// Honesty rules:
//   - storeBaseline is intentionally OMITTED — no runtime source computes it.
//   - eligibleIssues carry NO leakStage — real issues are not tagged with one.
//   - snapshot fields are only set when a real value exists; nulls stay null.
// ---------------------------------------------------------------------------
function toOpportunityInput(ctx = {}) {
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
    // snapshot: only what we actually have. No orders/revenue source at this
    // layer today, so those stay absent rather than being faked.
    snapshot: {
      productSessions: sessions,
      productAtcCount: atcCount,
    },
    profile: {
      sessions,
      atcRate,
      refundRate: num(profile && profile.refundRate),
      dataGaps: Array.isArray(profile && profile.dataGaps) ? profile.dataGaps : [],
      archetype: (profile && profile.archetype) ?? null,
    },
    // storeBaseline intentionally omitted — see honesty rules above.
    confoundFlags: [],
  };

  return input;
}

// Per-product honesty notes: why a score is low/excluded, and which gaps apply.
function diagnosticNotes(input, result) {
  const notes = [];
  // Global-but-restated-per-product: no baseline means leakage/upside are blind.
  if (!input.storeBaseline) notes.push('no_store_baseline');
  // No leakStage on any eligible issue → interventionFit cannot be matched.
  const hasIssues = Array.isArray(input.eligibleIssues) && input.eligibleIssues.length > 0;
  const anyLeakStage = hasIssues && input.eligibleIssues.some((i) => i && i.leakStage);
  if (hasIssues && !anyLeakStage) notes.push('no_leakstage_on_eligible_issues');
  if (result && result.primaryLeak === 'insufficient_data') notes.push('insufficient_sessions');
  if (result && result.excludedReason) notes.push('excluded');
  return notes;
}

// ---------------------------------------------------------------------------
// buildOpportunityDiagnostics(contexts) → internal diagnostics payload (pure).
//
// contexts: array of ctx objects (see toOpportunityInput).
// Uses rankProductOpportunities so ordering matches the service's own ranking.
// This is diagnostics only — it does NOT feed any merchant-facing ranking.
// ---------------------------------------------------------------------------
function buildOpportunityDiagnostics(contexts = []) {
  const list = Array.isArray(contexts) ? contexts : [];
  const inputs = list.map(toOpportunityInput);

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
      // No runtime code computes a store baseline (storeCvr/storeRpv/storeAov).
      noStoreBaseline: true,
      // Real issues are not tagged with leakStage, so interventionFit is blind.
      noLeakStageMapping: anyIssues ? !anyLeakStage : true,
    },
    note:
      'Internal diagnostics only. Scores are NOT used for any merchant-facing ' +
      'ranking. Store baseline and issue leakStage are not yet available in ' +
      'runtime, so many products will read as insufficient/no_clear_leak.',
    count: products.length,
    products,
  };
}

module.exports = {
  FLAG,
  isDiagnosticsEnabled,
  toOpportunityInput,
  diagnosticNotes,
  buildOpportunityDiagnostics,
};
