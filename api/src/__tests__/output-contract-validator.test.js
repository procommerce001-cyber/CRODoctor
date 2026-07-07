'use strict';

// ---------------------------------------------------------------------------
// Output Contract Validator (PR 1A) — pure unit tests.
//
// Verifies the validate-only helper judges generator output SHAPE/FORMAT per
// the issue registry, never mutates input, is deterministic, and pulls in no
// DB/env/network. No Anthropic/Shopify calls.
//
// Run: node --test src/__tests__/output-contract-validator.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const { validateGeneratorOutputContract } = require('../services/cro/output-contract-validator');
const { OUTPUT_CONTRACTS, getOutputContract } = require('../services/cro/output-contracts');

// Helpers to build well-formed outputs.
const plainProse = 'This premium organic cotton tee is cut for everyday comfort and pairs with everything you already own in your closet.';
const proseOutput = (content = plainProse) => ({
  bestGuess: { content },
  variants:  [{ content }],
});
const listContent = '<ul><li>Ships in 24 hours</li><li>30-day returns</li><li>Secure checkout</li></ul>';
const listOutput = (content = listContent) => ({
  bestGuess: { content },
  variants:  [{ content }],
});

// ── valid plain-text outputs ────────────────────────────────────────────────
test('valid plain-text description output accepted', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_description', output: proseOutput() });
  assert.strictEqual(r.ok, true);
});

test('valid desire block plain text accepted', () => {
  const r = validateGeneratorOutputContract({ issueType: 'weak_desire_creation', output: proseOutput() });
  assert.strictEqual(r.ok, true);
});

test('valid short description expansion plain text accepted', () => {
  const r = validateGeneratorOutputContract({ issueType: 'description_too_short', output: proseOutput() });
  assert.strictEqual(r.ok, true);
});

test('valid risk reversal plain text accepted', () => {
  const content = 'Try it risk-free — if it is not the right fit, send it back within 30 days for a full refund.';
  const r = validateGeneratorOutputContract({ issueType: 'no_risk_reversal', output: proseOutput(content) });
  assert.strictEqual(r.ok, true);
});

// ── plain-text rejections ───────────────────────────────────────────────────
test('HTML where plain text expected is rejected (fallback)', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_description', output: proseOutput('<p>' + plainProse + '</p>') });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.severity, 'fallback');
});

test('empty / whitespace-only content rejected', () => {
  const r1 = validateGeneratorOutputContract({ issueType: 'no_description', output: proseOutput('') });
  const r2 = validateGeneratorOutputContract({ issueType: 'no_description', output: proseOutput('    \n  ') });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r2.ok, false);
});

test('too-short plain text rejected', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_description', output: proseOutput('too short') });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.severity, 'fallback');
});

test('too-long plain text rejected', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_risk_reversal', output: proseOutput('x'.repeat(400)) });
  assert.strictEqual(r.ok, false);
});

// ── shape rejections ────────────────────────────────────────────────────────
test('missing bestGuess rejected', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_description', output: { variants: [{ content: plainProse }] } });
  assert.strictEqual(r.ok, false);
});

test('missing bestGuess.content rejected', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_description', output: { bestGuess: {}, variants: [{ content: plainProse }] } });
  assert.strictEqual(r.ok, false);
});

test('missing variants rejected when required', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_description', output: { bestGuess: { content: plainProse } } });
  assert.strictEqual(r.ok, false);
});

test('variants not an array rejected', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_description', output: { bestGuess: { content: plainProse }, variants: 'nope' } });
  assert.strictEqual(r.ok, false);
});

test('empty variants array rejected', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_description', output: { bestGuess: { content: plainProse }, variants: [] } });
  assert.strictEqual(r.ok, false);
});

test('invalid variants[0].content rejected even when bestGuess is valid', () => {
  const r = validateGeneratorOutputContract({
    issueType: 'no_description',
    output: { bestGuess: { content: plainProse }, variants: [{ content: '<b>markup</b>' }] },
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /variants\[0\]/);
});

test('output that is not an object rejected', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_description', output: 'a string' });
  assert.strictEqual(r.ok, false);
});

// ── html_list (trust bullets) ───────────────────────────────────────────────
test('valid trust bullets <ul><li>...</li></ul> accepted', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_trust_bullets', output: listOutput() });
  assert.strictEqual(r.ok, true);
});

test('trust bullets null output accepted as no-fix-generated', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_trust_bullets', output: null });
  assert.strictEqual(r.ok, true);
});

test('null output for a prose contract is rejected (fallback)', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_description', output: null });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.severity, 'fallback');
});

test('trust bullets non-list HTML rejected', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_trust_bullets', output: listOutput('<div>Fast shipping and easy returns on every order today</div>') });
  assert.strictEqual(r.ok, false);
});

test('trust bullets nested/double <ul> rejected', () => {
  const bad = '<ul><li>One</li><ul><li>Nested</li></ul></ul>';
  const r = validateGeneratorOutputContract({ issueType: 'no_trust_bullets', output: listOutput(bad) });
  assert.strictEqual(r.ok, false);
});

test('trust bullets script / event handler / unsafe HTML rejected', () => {
  const r1 = validateGeneratorOutputContract({ issueType: 'no_trust_bullets', output: listOutput('<ul><li>Hi<script>alert(1)</script></li></ul>') });
  const r2 = validateGeneratorOutputContract({ issueType: 'no_trust_bullets', output: listOutput('<ul><li onclick="x()">Click</li></ul>') });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r2.ok, false);
});

test('trust bullets <ul> with attributes rejected (v1 expects bare <ul>)', () => {
  const r = validateGeneratorOutputContract({ issueType: 'no_trust_bullets', output: listOutput('<ul class="x"><li>Item one here for length</li></ul>') });
  assert.strictEqual(r.ok, false);
});

// ── unknown issueType ───────────────────────────────────────────────────────
test('unknown issueType returns ok with severity:warn', () => {
  const r = validateGeneratorOutputContract({ issueType: 'totally_unknown_issue', output: proseOutput() });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.severity, 'warn');
});

test('non-string issueType returns ok with severity:warn', () => {
  const r = validateGeneratorOutputContract({ issueType: undefined, output: proseOutput() });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.severity, 'warn');
});

// ── purity / robustness ─────────────────────────────────────────────────────
test('validator does not mutate input', () => {
  const output = proseOutput();
  const input  = { issueType: 'no_description', output, patchMode: 'insert_after_anchor', context: { a: 1 } };
  const frozenSnapshot = JSON.stringify(input);
  validateGeneratorOutputContract(input);
  assert.strictEqual(JSON.stringify(input), frozenSnapshot);
});

test('validator never throws on malformed input', () => {
  assert.doesNotThrow(() => validateGeneratorOutputContract(undefined));
  assert.doesNotThrow(() => validateGeneratorOutputContract(null));
  assert.doesNotThrow(() => validateGeneratorOutputContract({}));
  assert.doesNotThrow(() => validateGeneratorOutputContract({ issueType: 42, output: [] }));
  assert.doesNotThrow(() => validateGeneratorOutputContract({ issueType: 'no_description', output: { bestGuess: 5 } }));
});

test('validator is deterministic', () => {
  const input = { issueType: 'no_trust_bullets', output: listOutput() };
  const a = validateGeneratorOutputContract(input);
  const b = validateGeneratorOutputContract(input);
  assert.deepStrictEqual(a, b);
});

// ── registry / exports ──────────────────────────────────────────────────────
test('package exports work correctly', () => {
  assert.strictEqual(typeof validateGeneratorOutputContract, 'function');
  assert.strictEqual(typeof getOutputContract, 'function');
  assert.ok(OUTPUT_CONTRACTS && typeof OUTPUT_CONTRACTS === 'object');
  assert.ok(getOutputContract('no_description'));
  assert.strictEqual(getOutputContract('nope'), null);
  assert.strictEqual(getOutputContract(123), null);
});

test('registry covers the five v1 issue types', () => {
  for (const id of ['no_description', 'weak_desire_creation', 'description_too_short', 'no_risk_reversal', 'no_trust_bullets']) {
    assert.ok(OUTPUT_CONTRACTS[id], `missing contract for ${id}`);
  }
});

test('validator has no dependency on DB/env/network', () => {
  // Behavioral proxy: identical result regardless of env, and no async/IO.
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const r1 = validateGeneratorOutputContract({ issueType: 'no_description', output: proseOutput() });
  process.env.ANTHROPIC_API_KEY = 'dummy';
  const r2 = validateGeneratorOutputContract({ issueType: 'no_description', output: proseOutput() });
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
  assert.deepStrictEqual(r1, r2);
  assert.strictEqual(r1.ok, true);
});
