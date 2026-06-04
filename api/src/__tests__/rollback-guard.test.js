'use strict';

// ---------------------------------------------------------------------------
// Targeted tests for safeHtmlEquivalent — the rollback manual-edit guard's
// HTML comparison. Must accept Shopify's harmless body_html whitespace
// normalization (e.g. compact "<ul><li>" reformatted to "<ul>\n<li>") while
// still blocking real content drift.
//
// Run: node --test src/__tests__/rollback-guard.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const { safeHtmlEquivalent } = require('../services/content-execution.service');

// Compact form as the app constructs and stores in resultContent.
const RESULT = '<p>Perfect for:</p>' +
  '<div data-cro-block="no_trust_bullets" data-cro-eid="abc">' +
  '<ul><li>We are selective about what we stock.</li>' +
  '<li>Questions? Our team is here to help.</li></ul></div>' +
  '<ul><li>Drains</li><li>Sinks</li></ul>';

// Shopify-normalized form: newlines inserted between block tags.
const NORMALIZED = '<p>Perfect for:</p>\n' +
  '<div data-cro-block="no_trust_bullets" data-cro-eid="abc">\n' +
  '<ul>\n<li>We are selective about what we stock.</li>\n' +
  '<li>Questions? Our team is here to help.</li>\n</ul>\n</div>\n' +
  '<ul>\n<li>Drains</li>\n<li>Sinks</li>\n</ul>';

// ── Must PASS (equivalent) ────────────────────────────────────────────────
test('exact match passes', () => {
  assert.strictEqual(safeHtmlEquivalent(RESULT, RESULT), true);
});

test('Shopify whitespace-normalized HTML passes', () => {
  assert.strictEqual(safeHtmlEquivalent(NORMALIZED, RESULT), true);
});

test('CRLF / leading-trailing whitespace differences pass', () => {
  assert.strictEqual(safeHtmlEquivalent('  ' + RESULT.replace(/></g, '>\r\n<') + '\n', RESULT), true);
});

// ── Must BLOCK (real drift) ───────────────────────────────────────────────
test('changed text fails', () => {
  const edited = NORMALIZED.replace('We are selective about what we stock.', 'We are NOT selective at all.');
  assert.strictEqual(safeHtmlEquivalent(edited, RESULT), false);
});

test('data-cro-block removed fails', () => {
  const removed = '<p>Perfect for:</p>\n<ul>\n<li>Drains</li>\n<li>Sinks</li>\n</ul>';
  assert.strictEqual(safeHtmlEquivalent(removed, RESULT), false);
});

test('data-cro-block duplicated fails', () => {
  const dup = NORMALIZED +
    '<div data-cro-block="no_trust_bullets" data-cro-eid="def"><ul><li>dup</li></ul></div>';
  assert.strictEqual(safeHtmlEquivalent(dup, RESULT), false);
});

test('unrelated paragraph appended fails', () => {
  assert.strictEqual(safeHtmlEquivalent(NORMALIZED + '<p>Buy now!</p>', RESULT), false);
});

test('paragraph removed fails', () => {
  const noPerfect = NORMALIZED.replace('<p>Perfect for:</p>\n', '');
  assert.strictEqual(safeHtmlEquivalent(noPerfect, RESULT), false);
});

test('stacked CRO block from another issue fails', () => {
  const stacked = NORMALIZED +
    '<div data-cro-block="no_risk_reversal" data-cro-eid="xyz"><p>30-day returns</p></div>';
  assert.strictEqual(safeHtmlEquivalent(stacked, RESULT), false);
});

test('changed link/attribute fails', () => {
  const withLink   = RESULT.replace('<p>Perfect for:</p>', '<p><a href="/a">Perfect for:</a></p>');
  const changedLink = NORMALIZED.replace('<p>Perfect for:</p>', '<p><a href="/b">Perfect for:</a></p>');
  assert.strictEqual(safeHtmlEquivalent(changedLink, withLink), false);
});

test('null inputs do not throw and only equal when both null-equal', () => {
  assert.strictEqual(safeHtmlEquivalent(null, RESULT), false);
  assert.strictEqual(safeHtmlEquivalent(RESULT, null), false);
});
