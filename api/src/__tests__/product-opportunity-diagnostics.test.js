'use strict';

// ---------------------------------------------------------------------------
// PR A — ProductOpportunityScore internal diagnostics behind a flag.
// Pure unit tests for the flag gate + adapter + diagnostics builder.
// No DB, no Shopify, no Anthropic, no network, no express.
//
// Run: node --test src/__tests__/product-opportunity-diagnostics.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const {
  FLAG,
  isDiagnosticsEnabled,
  toOpportunityInput,
  buildOpportunityDiagnostics,
} = require('../services/product-opportunity-input.adapter');

// A realistic-ish raw product + LLM-free actions + performance profile.
function rawCtx(over = {}) {
  return {
    rawProduct: {
      id: 'prod_1',
      status: 'active',
      updatedAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      variants: [{ availableForSale: true }],
    },
    actions: [{ issueId: 'no_trust_bullets', severity: 'high', riskLevel: 'low' }],
    profile: { sessions: 800, atcRate: 0.02, refundRate: 0, dataGaps: [], archetype: 'standard' },
    ...over,
  };
}

// ── Flag gate ───────────────────────────────────────────────────────────────

test('flag OFF by default: diagnostics disabled when env unset', () => {
  assert.strictEqual(isDiagnosticsEnabled({}), false);
});

test('flag disabled for any value other than the exact string "true"', () => {
  for (const v of ['false', 'TRUE', '1', 'yes', '', undefined]) {
    assert.strictEqual(isDiagnosticsEnabled({ [FLAG]: v }), false, `value ${JSON.stringify(v)}`);
  }
});

test('flag enabled only when env value is exactly "true"', () => {
  assert.strictEqual(isDiagnosticsEnabled({ [FLAG]: 'true' }), true);
});

test('isDiagnosticsEnabled() with no arg does not throw (reads process.env)', () => {
  assert.doesNotThrow(() => isDiagnosticsEnabled());
});

// ── Adapter honesty: never invents baseline or leakStage ─────────────────────

test('adapter omits store baseline (no runtime source) and does not invent it', () => {
  const input = toOpportunityInput(rawCtx());
  assert.strictEqual(input.storeBaseline, undefined);
});

test('adapter maps eligibleIssues WITHOUT a fabricated leakStage', () => {
  const input = toOpportunityInput(rawCtx());
  assert.strictEqual(input.eligibleIssues.length, 1);
  assert.strictEqual(input.eligibleIssues[0].issueId, 'no_trust_bullets');
  assert.ok(!('leakStage' in input.eligibleIssues[0]), 'leakStage must not be synthesized');
});

test('adapter passes null product signals through instead of faking them', () => {
  const input = toOpportunityInput(rawCtx({
    profile: { sessions: null, atcRate: null, refundRate: null, dataGaps: ['sessions'] },
  }));
  assert.strictEqual(input.snapshot.productSessions, null);
  assert.strictEqual(input.profile.sessions, null);
  assert.deepStrictEqual(input.profile.dataGaps, ['sessions']);
});

test('adapter is null-safe and never throws on empty/garbage context', () => {
  assert.doesNotThrow(() => toOpportunityInput());
  assert.doesNotThrow(() => toOpportunityInput({}));
  assert.doesNotThrow(() => toOpportunityInput({ rawProduct: null, actions: null, profile: null }));
});

test('adapter does not mutate its input context', () => {
  const ctx = rawCtx();
  const snapshot = JSON.stringify(ctx);
  toOpportunityInput(ctx);
  assert.strictEqual(JSON.stringify(ctx), snapshot, 'adapter mutated its input');
});

// ── Diagnostics builder: shape, ranking, honesty ─────────────────────────────

test('flag ON: builder returns ranked diagnostics with the expected fields', () => {
  const out = buildOpportunityDiagnostics([
    rawCtx({ rawProduct: { id: 'low',  status: 'active', variants: [{ availableForSale: true }] },
             profile: { sessions: 60 } }),
    rawCtx({ rawProduct: { id: 'high', status: 'active', variants: [{ availableForSale: true }],
                           updatedAt: new Date(Date.now() - 30 * 86400000).toISOString() },
             profile: { sessions: 1500, atcRate: 0.02 } }),
  ]);

  assert.strictEqual(out.enabled, true);
  assert.strictEqual(out.count, 2);
  assert.ok(Array.isArray(out.products));

  // Ranked descending by opportunityScore (uses rankProductOpportunities).
  assert.ok(out.products[0].opportunityScore >= out.products[1].opportunityScore);

  // Each product exposes the internal diagnostic fields from the plan.
  for (const p of out.products) {
    for (const key of [
      'productId', 'opportunityScore', 'band', 'primaryLeak', 'excludedReason',
      'dataConfidence', 'recommendedFocus', 'subScores', 'estimatedRevenueUpside',
      'explanation', 'notes',
    ]) {
      assert.ok(key in p, `missing field ${key}`);
    }
  }
});

test('flag ON: builder honestly reports the two runtime data gaps', () => {
  const out = buildOpportunityDiagnostics([rawCtx()]);
  assert.strictEqual(out.dataGaps.noStoreBaseline, true);
  // Issues exist but none carry leakStage → gap flagged true.
  assert.strictEqual(out.dataGaps.noLeakStageMapping, true);
  assert.ok(/not.*merchant-facing/i.test(out.note));
});

test('missing data does not crash and does not produce fake confident ranking', () => {
  const out = buildOpportunityDiagnostics([
    { rawProduct: { id: 'a', status: 'active', variants: [] }, actions: [], profile: null },
    { rawProduct: { id: 'b' } },
  ]);
  assert.strictEqual(out.count, 2);
  for (const p of out.products) {
    // With no sessions/baseline, scores must not be confidently high.
    assert.strictEqual(p.opportunityScore, 0);
    assert.ok(['insufficient', 'weak'].includes(p.dataConfidence));
    assert.ok(p.notes.includes('no_store_baseline'));
  }
});

test('builder is null-safe on empty / non-array input', () => {
  assert.deepStrictEqual(buildOpportunityDiagnostics([]).products, []);
  assert.deepStrictEqual(buildOpportunityDiagnostics(null).products, []);
  assert.strictEqual(buildOpportunityDiagnostics(undefined).count, 0);
});

test('builder does not mutate its input contexts', () => {
  const contexts = [rawCtx(), rawCtx({ rawProduct: { id: 'prod_2', status: 'active', variants: [] } })];
  const snapshot = JSON.stringify(contexts);
  buildOpportunityDiagnostics(contexts);
  assert.strictEqual(JSON.stringify(contexts), snapshot, 'builder mutated its input');
});
