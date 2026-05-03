'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { classifyArchetype, ARCHETYPES } = require('../services/cro/classifyArchetype');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const BASE = {
  sessions:         null,
  atcRate:          null,
  orderCount:       0,
  refundRate:       null,
  variantSkewPct:   null,
  trafficQualified: null,
  previousArchetype: null,
};

function build(overrides) {
  return { ...BASE, ...overrides };
}

// ---------------------------------------------------------------------------
// Fixture 1 — content_bottleneck (high confidence)
//
// Adequate qualified traffic, low ATC rate, no refund signal, no variant skew.
// All conditions met for a confirmed content-layer conversion problem.
// ---------------------------------------------------------------------------
describe('Fixture 1: content_bottleneck — high confidence', () => {
  const input = build({
    sessions:         500,
    atcRate:          0.012,
    orderCount:       20,
    refundRate:       0.03,
    variantSkewPct:   0.45,
    trafficQualified: true,
  });

  test('classifies as content_bottleneck', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetype, ARCHETYPES.CONTENT_BOTTLENECK);
  });

  test('archetypeConf is high when trafficQualified is true', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetypeConf, 'high');
  });

  test('no data gaps', () => {
    const r = classifyArchetype(input);
    assert.deepEqual(r.dataGaps, []);
  });
});

// ---------------------------------------------------------------------------
// Fixture 2 — traffic_problem
//
// Sessions below TRAFFIC_HYSTERESIS_SESSIONS (150). Always classifies as
// traffic_problem regardless of previous archetype.
// ---------------------------------------------------------------------------
describe('Fixture 2: traffic_problem', () => {
  const input = build({
    sessions:   120,
    atcRate:    0.02,
    orderCount: 5,
  });

  test('classifies as traffic_problem', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetype, ARCHETYPES.TRAFFIC_PROBLEM);
  });

  test('dataGaps includes insufficient_traffic', () => {
    const r = classifyArchetype(input);
    assert.ok(r.dataGaps.includes('insufficient_traffic'));
  });
});

// ---------------------------------------------------------------------------
// Fixture 3 — hysteresis: content_bottleneck held at 180 sessions
//
// Sessions (180) is below TRAFFIC_MIN_SESSIONS (200) but above
// TRAFFIC_HYSTERESIS_SESSIONS (150). Because previousArchetype is
// content_bottleneck, GATE 1 does not fire. The product retains its
// content_bottleneck classification.
//
// Added to the spec fixture: atcRate + supporting fields are required for
// the function to reach GATE 4 and produce a classification. See Section 4.
// ---------------------------------------------------------------------------
describe('Fixture 3: hysteresis — content_bottleneck held at 180 sessions', () => {
  const input = build({
    sessions:          180,
    atcRate:           0.015,
    orderCount:        10,
    refundRate:        0.03,
    variantSkewPct:    null,
    trafficQualified:  null,
    previousArchetype: 'content_bottleneck',
  });

  test('classifies as content_bottleneck (hysteresis holds)', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetype, ARCHETYPES.CONTENT_BOTTLENECK);
  });

  test('archetypeConf is low when trafficQualified is null', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetypeConf, 'low');
  });

  test('GATE 1 does not fire when sessions is in hysteresis band and prev was content_bottleneck', () => {
    // Sanity: same sessions with NO prior classification → traffic_problem
    const noHysteresis = { ...input, previousArchetype: null };
    assert.equal(classifyArchetype(noHysteresis).archetype, ARCHETYPES.TRAFFIC_PROBLEM);
  });
});

// ---------------------------------------------------------------------------
// Fixture 4 — hysteresis: traffic_problem triggered below 150 sessions
//
// Sessions (140) is below TRAFFIC_HYSTERESIS_SESSIONS (150). Even though
// previousArchetype is content_bottleneck, the hard floor overrides it.
// ---------------------------------------------------------------------------
describe('Fixture 4: hysteresis — traffic_problem triggered below hysteresis floor', () => {
  const input = build({
    sessions:          140,
    atcRate:           0.015,
    orderCount:        5,
    previousArchetype: 'content_bottleneck',
  });

  test('classifies as traffic_problem (hard floor overrides hysteresis)', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetype, ARCHETYPES.TRAFFIC_PROBLEM);
  });

  test('dataGaps includes insufficient_traffic', () => {
    const r = classifyArchetype(input);
    assert.ok(r.dataGaps.includes('insufficient_traffic'));
  });
});

// ---------------------------------------------------------------------------
// Fixture 5 — pricing_signal
//
// Low ATC rate combined with strong variant skew toward cheapest option (85%).
// Indicates a price-to-value mismatch, not a description quality problem.
// ---------------------------------------------------------------------------
describe('Fixture 5: pricing_signal', () => {
  const input = build({
    sessions:         600,
    atcRate:          0.018,
    orderCount:       30,
    refundRate:       0.05,
    variantSkewPct:   0.85,
    trafficQualified: true,
  });

  test('classifies as pricing_signal', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetype, ARCHETYPES.PRICING_SIGNAL);
  });

  test('archetypeConf is high', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetypeConf, 'high');
  });

  test('does not classify as content_bottleneck despite low ATC', () => {
    const r = classifyArchetype(input);
    assert.notEqual(r.archetype, ARCHETYPES.CONTENT_BOTTLENECK);
  });
});

// ---------------------------------------------------------------------------
// Fixture 6 — trust_mismatch
//
// Adequate sessions and ATC rate (page is converting), but high refund rate
// (22%). The product description is over-promising.
// ---------------------------------------------------------------------------
describe('Fixture 6: trust_mismatch', () => {
  const input = build({
    sessions:         800,
    atcRate:          0.05,
    orderCount:       25,
    refundRate:       0.22,
    trafficQualified: true,
  });

  test('classifies as trust_mismatch', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetype, ARCHETYPES.TRUST_MISMATCH);
  });

  test('fires before content_bottleneck and pricing gates', () => {
    // If trust_mismatch gate was skipped, atcRate 0.05 would reach performing
    const r = classifyArchetype(input);
    assert.notEqual(r.archetype, ARCHETYPES.PERFORMING);
  });
});

// ---------------------------------------------------------------------------
// Fixture 7 — trust_mismatch BLOCKED by weak refund volume
//
// refundRate is extreme (40%) but orderCount (3) is below REFUND_MIN_ORDERS (5).
// GATE 2 is explicitly blocked. atcRate (0.04) falls in the gray zone between
// ATC_RATE_BOTTLENECK_THRESHOLD (0.03) and ATC_RATE_PERFORMING_THRESHOLD (0.05)
// so neither content_bottleneck nor performing fires. Result: unclassified.
//
// The gray-zone fallthrough is correct and intended — see Section 4.
// ---------------------------------------------------------------------------
describe('Fixture 7: trust_mismatch blocked by weak refund volume', () => {
  const input = build({
    sessions:   400,
    atcRate:    0.04,
    orderCount: 3,
    refundRate: 0.40,
  });

  test('does NOT classify as trust_mismatch (orderCount too low)', () => {
    const r = classifyArchetype(input);
    assert.notEqual(r.archetype, ARCHETYPES.TRUST_MISMATCH);
  });

  test('classifies as unclassified (gray-zone ATC)', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetype, ARCHETYPES.UNCLASSIFIED);
  });

  test('dataGaps includes ambiguous_signals', () => {
    const r = classifyArchetype(input);
    assert.ok(r.dataGaps.includes('ambiguous_signals'));
  });
});

// ---------------------------------------------------------------------------
// Fixture 8 — performing
//
// Sessions adequate, ATC rate above performing threshold (6%), refund rate low.
// No intervention warranted.
// ---------------------------------------------------------------------------
describe('Fixture 8: performing', () => {
  const input = build({
    sessions:         900,
    atcRate:          0.06,
    orderCount:       40,
    refundRate:       0.05,
    trafficQualified: true,
  });

  test('classifies as performing', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetype, ARCHETYPES.PERFORMING);
  });

  test('archetypeConf is high', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetypeConf, 'high');
  });

  test('no data gaps', () => {
    const r = classifyArchetype(input);
    assert.deepEqual(r.dataGaps, []);
  });
});

// ---------------------------------------------------------------------------
// Fixture 9 — unclassified: no session data
//
// sessions is null — Shopify Analytics scope absent or product has no views.
// GATE 0 fires immediately. dataGaps must contain 'sessions_unavailable'.
// ---------------------------------------------------------------------------
describe('Fixture 9: unclassified — no session data', () => {
  const input = build({
    sessions: null,
  });

  test('classifies as unclassified', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetype, ARCHETYPES.UNCLASSIFIED);
  });

  test('archetypeConf is low', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetypeConf, 'low');
  });

  test('dataGaps contains sessions_unavailable', () => {
    const r = classifyArchetype(input);
    assert.ok(r.dataGaps.includes('sessions_unavailable'));
  });
});

// ---------------------------------------------------------------------------
// Fixture 10 — content_bottleneck: unknown traffic source (low confidence)
//
// Low ATC rate and adequate sessions, but trafficQualified is null (traffic
// source data unavailable). GATE 4 fires with archetypeConf: 'low'.
// ---------------------------------------------------------------------------
describe('Fixture 10: content_bottleneck — unknown traffic source', () => {
  const input = build({
    sessions:         400,
    atcRate:          0.015,
    orderCount:       10,
    refundRate:       0.05,
    trafficQualified: null,
  });

  test('classifies as content_bottleneck', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetype, ARCHETYPES.CONTENT_BOTTLENECK);
  });

  test('archetypeConf is low when trafficQualified is null', () => {
    const r = classifyArchetype(input);
    assert.equal(r.archetypeConf, 'low');
  });

  test('confirmed unqualified traffic (false) blocks content_bottleneck', () => {
    // When traffic is KNOWN to be low-intent, GATE 4 must not fire
    const unqualified = { ...input, trafficQualified: false };
    const r = classifyArchetype(unqualified);
    assert.notEqual(r.archetype, ARCHETYPES.CONTENT_BOTTLENECK);
  });
});

// ---------------------------------------------------------------------------
// Additional boundary cases
// ---------------------------------------------------------------------------
describe('Boundary: config overrides', () => {
  test('custom thresholds are respected', () => {
    // Override to a much higher ATC threshold — same input now reads as bottleneck
    const r = classifyArchetype(build({
      sessions:         500,
      atcRate:          0.04,
      trafficQualified: true,
      config: { ...require('../services/cro/phase2-config'), ATC_RATE_BOTTLENECK_THRESHOLD: 0.05 },
    }));
    assert.equal(r.archetype, ARCHETYPES.CONTENT_BOTTLENECK);
  });
});

describe('Boundary: GATE 2 atcRate guard', () => {
  test('trust_mismatch blocked when atcRate is near-zero (< 0.01)', () => {
    // A page that barely converts at all is not a "trust mismatch" —
    // it is not converting, not convincing-and-then-disappointing.
    const r = classifyArchetype(build({
      sessions:   500,
      atcRate:    0.005,
      orderCount: 10,
      refundRate: 0.30,
    }));
    assert.notEqual(r.archetype, ARCHETYPES.TRUST_MISMATCH);
  });
});

describe('Boundary: output contract', () => {
  test('result always has all four required keys', () => {
    const r = classifyArchetype(build({ sessions: 300, atcRate: 0.01 }));
    assert.ok('archetype'        in r);
    assert.ok('archetypeConf'    in r);
    assert.ok('archetypeSignals' in r);
    assert.ok('dataGaps'         in r);
  });

  test('dataGaps is always an array', () => {
    const r = classifyArchetype(build({}));
    assert.ok(Array.isArray(r.dataGaps));
  });

  test('archetypeConf is always high or low', () => {
    for (const sessions of [null, 50, 180, 500, 900]) {
      const r = classifyArchetype(build({ sessions, atcRate: 0.02 }));
      assert.ok(['high', 'low'].includes(r.archetypeConf),
        `Expected high|low, got "${r.archetypeConf}" for sessions=${sessions}`);
    }
  });
});
