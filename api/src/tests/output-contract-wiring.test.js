'use strict';

// ---------------------------------------------------------------------------
// output-contract-wiring.test.js — PR 1B
//
// Verifies acceptGeneratorOutput, the generation-time gate that decides whether
// a CRO generator's LLM output may become generatedFix/proposedContent/preview
// or must be dropped so the caller falls back to its template fix.
//
// Pure behavioral tests against the exported helper. No DB, no Shopify, no
// Anthropic, no getProductActions harness.
// ---------------------------------------------------------------------------

const { test }   = require('node:test');
const assert     = require('node:assert');

const { acceptGeneratorOutput } = require('../services/action-center.service');

// A structurally valid plain_text (no_description) generator output.
function validPlainTextOutput() {
  const content =
    'This premium cotton tee is cut for everyday comfort and holds its shape '
    + 'wash after wash, so you can reach for it again and again with confidence.';
  return {
    bestGuess: { content },
    variants:  [{ content }],
  };
}

// A structurally valid html_list (no_trust_bullets) generator output.
function validHtmlListOutput() {
  const content = '<ul><li>Free returns</li><li>Ships in 24h</li></ul>';
  return {
    bestGuess: { content },
    variants:  [{ content }],
  };
}

test('valid no_description output returns the same object by identity', () => {
  const output = validPlainTextOutput();
  assert.strictEqual(acceptGeneratorOutput('no_description', output), output);
});

test('malformed HTML in plain-text no_description returns null', () => {
  const content = '<p>Descriptions should be plain text, not HTML markup here.</p>';
  const output  = { bestGuess: { content }, variants: [{ content }] };
  assert.strictEqual(acceptGeneratorOutput('no_description', output), null);
});

test('too-short plain-text output returns null', () => {
  const content = 'Too short.'; // below the 60-char minimum
  const output  = { bestGuess: { content }, variants: [{ content }] };
  assert.strictEqual(acceptGeneratorOutput('no_description', output), null);
});

test('too-long plain-text output returns null', () => {
  const content = 'a'.repeat(1201); // above the 1200-char maximum
  const output  = { bestGuess: { content }, variants: [{ content }] };
  assert.strictEqual(acceptGeneratorOutput('no_description', output), null);
});

test('missing bestGuess.content returns null', () => {
  const output = { bestGuess: {}, variants: [{ content: 'x'.repeat(80) }] };
  assert.strictEqual(acceptGeneratorOutput('no_description', output), null);
});

test('missing variants returns null', () => {
  const content = 'This is a perfectly valid, sufficiently long plain-text product description string.';
  const output  = { bestGuess: { content } };
  assert.strictEqual(acceptGeneratorOutput('no_description', output), null);
});

test('empty variants array returns null', () => {
  const content = 'This is a perfectly valid, sufficiently long plain-text product description string.';
  const output  = { bestGuess: { content }, variants: [] };
  assert.strictEqual(acceptGeneratorOutput('no_description', output), null);
});

test('malformed variants[0] returns null', () => {
  const good = 'This is a perfectly valid, sufficiently long plain-text product description string.';
  const output = { bestGuess: { content: good }, variants: [{ content: '<p>html not allowed</p>' }] };
  assert.strictEqual(acceptGeneratorOutput('no_description', output), null);
});

test('null output for no_description returns null', () => {
  assert.strictEqual(acceptGeneratorOutput('no_description', null), null);
});

test('null output for no_trust_bullets returns null and does not throw', () => {
  // no_trust_bullets contract allows null-as-no-fix; the helper still returns
  // null so the caller keeps its template bullets. Must not throw.
  assert.strictEqual(acceptGeneratorOutput('no_trust_bullets', null), null);
});

test('valid no_trust_bullets html_list returns same object by identity', () => {
  const output = validHtmlListOutput();
  assert.strictEqual(acceptGeneratorOutput('no_trust_bullets', output), output);
});

test('unknown issueType returns same object by identity', () => {
  // Unknown issueType → validator returns ok/severity:'warn' → do not block.
  const output = validPlainTextOutput();
  assert.strictEqual(acceptGeneratorOutput('totally_unknown_issue', output), output);
});

test('validator throws via validatorOverride returns same object and does not throw', () => {
  const output = validPlainTextOutput();
  const throwingValidator = () => { throw new Error('boom'); };
  let result;
  assert.doesNotThrow(() => {
    result = acceptGeneratorOutput('no_description', output, throwingValidator);
  });
  assert.strictEqual(result, output);
});

test('acceptGeneratorOutput does not mutate the passed output object', () => {
  const output = validPlainTextOutput();
  const snapshot = JSON.stringify(output);
  acceptGeneratorOutput('no_description', output);
  assert.strictEqual(JSON.stringify(output), snapshot);
});
