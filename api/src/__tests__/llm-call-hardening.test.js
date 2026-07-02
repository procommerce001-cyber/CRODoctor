'use strict';

// ---------------------------------------------------------------------------
// LLM call hardening (PR-1) — retry-helper unification + system messages.
//
// These are structural/static tests: they assert the generator SOURCE routes
// through callAnthropicWithRetry and sends a top-level `system` field, plus a
// pure test of the shared system message content. No Anthropic/network calls.
//
// Run: node --test src/__tests__/llm-call-hardening.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const GEN_DIR = path.join(__dirname, '..', 'services', 'cro', 'generators');
const read = (f) => fs.readFileSync(path.join(GEN_DIR, f), 'utf8');

const ALL_GENERATORS = [
  'description-llm.js',
  'desire-block-llm.js',
  'short-description-llm.js',
  'risk-reversal-llm.js',
  'trust-bullets-llm.js',
];
// The three that previously used raw fetch and must no longer.
const REFACTORED = ['description-llm.js', 'desire-block-llm.js', 'short-description-llm.js'];

const { CRO_SYSTEM_MESSAGE } = require('../services/cro/generators/system-message');

// 1 — every active generator routes through the shared retry helper
test('all generators use callAnthropicWithRetry', () => {
  for (const f of ALL_GENERATORS) {
    const src = read(f);
    assert.match(src, /callAnthropicWithRetry\(/, `${f} should call the retry helper`);
    assert.match(src, /require\('\.\/anthropic-fetch'\)/, `${f} should require the helper`);
  }
});

// 2 — the three refactored generators no longer contain raw fetch/abort plumbing
test('refactored generators contain no raw fetch / AbortController', () => {
  for (const f of REFACTORED) {
    const src = read(f);
    assert.doesNotMatch(src, /fetch\(\s*ANTHROPIC_API_URL/, `${f} still has raw fetch`);
    assert.doesNotMatch(src, /ANTHROPIC_API_URL/,           `${f} still references ANTHROPIC_API_URL`);
    assert.doesNotMatch(src, /new AbortController/,         `${f} still creates an AbortController`);
    assert.doesNotMatch(src, /clearTimeout\(/,              `${f} still has a dangling clearTimeout`);
  }
});

// 3 — every generator sends the shared system message in the request body
test('all generators include a system field with the shared message', () => {
  for (const f of ALL_GENERATORS) {
    const src = read(f);
    assert.match(src, /system:\s*CRO_SYSTEM_MESSAGE/, `${f} should send system: CRO_SYSTEM_MESSAGE`);
    assert.match(src, /require\('\.\/system-message'\)/, `${f} should require the system message`);
  }
});

// 4 — the system message encodes the key merchant-safety prohibitions
test('system message contains required safety prohibitions', () => {
  const m = CRO_SYSTEM_MESSAGE.toLowerCase();
  assert.match(m, /output only the requested block/i, 'must constrain output to the block');
  assert.match(m, /competitor/i,                      'must prohibit competitor mentions');
  assert.match(m, /do not invent[^.]*guarantee/i,     'must prohibit invented guarantees');
  assert.match(m, /reviews/i,                         'must prohibit invented reviews');
  assert.match(m, /conversion lift|revenue lift|results/i, 'must prohibit unsupported result claims');
  assert.match(m, /plain text or html/i,              'must reference the requested output format');
  // And must NOT itself over-claim.
  assert.doesNotMatch(m, /guaranteed results|proven lift/i, 'system message must not over-claim');
});

// 5 — system message is a non-empty, stable string
test('system message is a stable non-empty string', () => {
  assert.strictEqual(typeof CRO_SYSTEM_MESSAGE, 'string');
  assert.ok(CRO_SYSTEM_MESSAGE.length > 80);
});

// 6 — request-body field ORDER is safe (system present alongside messages, not
//     replacing them) — messages array is preserved in every generator.
test('generators preserve the user messages array', () => {
  for (const f of ALL_GENERATORS) {
    const src = read(f);
    assert.match(src, /messages:\s*\[\{\s*role:\s*'user'/, `${f} should keep the user message`);
  }
});
