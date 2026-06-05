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

// ── SVG viewBox/viewbox attribute-case (Shopify lowercases on save) ─────────
// Mirrors the trust-badges case: stored resultContent may carry camelCase
// `viewBox` while Shopify's live/local body carries lowercase `viewbox`.
const SVG_CAMEL =
  '<div data-cro-block="no_trust_bullets"><span class="cro-trust-badge">' +
  '<span aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20"><path d="M20 6 9 17l-5-5"/></svg></span>' +
  '<span>Secure Checkout</span></span></div>';
const SVG_LOWER = SVG_CAMEL.replace('viewBox=', 'viewbox=');

test('SVG viewBox vs viewbox is treated as equivalent (attribute-name case only)', () => {
  assert.strictEqual(safeHtmlEquivalent(SVG_LOWER, SVG_CAMEL), true);
});

test('SVG viewBox normalization combined with Shopify whitespace still equivalent', () => {
  const lowerSpaced = SVG_LOWER.replace(/></g, '>\n<');
  assert.strictEqual(safeHtmlEquivalent(lowerSpaced, SVG_CAMEL), true);
});

test('changed SVG path content still fails (normalization does not mask icon change)', () => {
  const changedPath = SVG_LOWER.replace('M20 6 9 17l-5-5', 'M1 1 2 2l-3-3');
  assert.strictEqual(safeHtmlEquivalent(changedPath, SVG_CAMEL), false);
});

test('changed badge label still fails despite viewBox normalization', () => {
  const changedLabel = SVG_LOWER.replace('Secure Checkout', 'Free Shipping');
  assert.strictEqual(safeHtmlEquivalent(changedLabel, SVG_CAMEL), false);
});

test('changed inline style still fails', () => {
  const a = '<div style="display:flex;gap:8px">x</div>';
  const b = '<div style="display:flex;gap:99px">x</div>';
  assert.strictEqual(safeHtmlEquivalent(a, b), false);
});

// Shopify also expands self-closing SVG children (<path/> -> <path></path>).
test('self-closing vs expanded SVG element is treated as equivalent', () => {
  const selfClosed = '<svg viewbox="0 0 24 24"><rect x="1" y="2" rx="2"/><path d="M1 2"/></svg>';
  const expanded   = '<svg viewbox="0 0 24 24"><rect x="1" y="2" rx="2"></rect><path d="M1 2"></path></svg>';
  assert.strictEqual(safeHtmlEquivalent(selfClosed, expanded), true);
});

test('combined Shopify SVG normalization (viewBox case + self-closing expansion) is equivalent', () => {
  const ours     = '<svg viewBox="0 0 24 24"><path d="M1 2"/></svg>';   // what we write
  const shopify  = '<svg viewbox="0 0 24 24"><path d="M1 2"></path></svg>'; // what Shopify stores
  assert.strictEqual(safeHtmlEquivalent(ours, shopify), true);
});

test('removed SVG element still fails despite self-closing normalization', () => {
  const a = '<svg viewbox="0 0 24 24"><rect x="1"/><path d="M1 2"/></svg>';
  const b = '<svg viewbox="0 0 24 24"><path d="M1 2"></path></svg>';
  assert.strictEqual(safeHtmlEquivalent(a, b), false);
});

test('changed svg attribute VALUE still fails (only the name case is normalized)', () => {
  const changedVal = SVG_LOWER.replace('viewbox="0 0 24 24"', 'viewbox="0 0 99 99"');
  assert.strictEqual(safeHtmlEquivalent(changedVal, SVG_CAMEL), false);
});
