'use strict';

// ---------------------------------------------------------------------------
// Targeted placement tests for context-aware CRO block anchors.
//
// Exercises the real pipeline via buildResultContent (detectPatchMode →
// findAnchor → applyPatch). Asserts that standalone blocks
// (no_risk_reversal, no_trust_bullets) land as top-level siblings and never
// inside an existing list/section, while weak_desire_creation is unchanged.
//
// Run: node --test src/__tests__/placement-anchor.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const { buildResultContent } = require('../services/content-execution.service');

// Unique insertion marker. Contains no list/paragraph tags so the list-balance
// check below reflects only the ORIGINAL html up to the insertion point.
const MARK = '<div data-cro-block="test">__CRO_MARK__</div>';

function placeAt(issueId, html) {
  const out = buildResultContent(issueId, html, MARK);
  const idx = out.indexOf(MARK); // start of the inserted block
  assert.ok(idx !== -1, 'marker should be inserted');
  return { out, idx, before: out.slice(0, idx) };
}

// True when the offset sits inside an open <ul>/<ol>/<li> (i.e. inside a list).
function insideList(before) {
  const count = re => (before.match(re) || []).length;
  const ulOpen  = count(/<ul\b/gi),  ulClose = count(/<\/ul>/gi);
  const olOpen  = count(/<ol\b/gi),  olClose = count(/<\/ol>/gi);
  const liOpen  = count(/<li\b/gi),  liClose = count(/<\/li>/gi);
  return ulOpen > ulClose || olOpen > olClose || liOpen > liClose;
}

// Rough balance check: every opened block container is closed (no broken HTML
// straddling the insertion point).
function listTagsBalanced(html) {
  const count = re => (html.match(re) || []).length;
  return count(/<ul\b/gi) === count(/<\/ul>/gi)
      && count(/<ol\b/gi) === count(/<\/ol>/gi)
      && count(/<li\b/gi) === count(/<\/li>/gi);
}

// A product body shaped like the real Elevate360 description: heading, intro
// paragraphs, a complete benefits <ul> that closes around the middle (~60%),
// then further sections — so the first list ends inside the 40%–70% band, the
// exact scenario where the old heuristic dropped the block inside an <li>.
const BENEFITS_BODY =
  '<h2>Elevate360 Rotating Kitchen Tower</h2>' +
  '<p>The Elevate360 keeps your counter organised and within reach. ' +
  'It rotates a full 360 degrees so everything is one spin away.</p>' +
  '<p>Built from premium stainless steel that resists rust and looks great in any kitchen for years to come.</p>' +
  '<h2>Why you will love it</h2>' +
  '<ul>' +
  '<li><p>Holds everything from spices to tall oil bottles</p></li>' +
  '<li><p>360 degree rotation makes cooking easier and faster every day</p></li>' +
  '<li><p>Elevates the kitchen aesthetic and looks stylish in any home</p></li>' +
  '<li><p>Reduces stress with a tidy, organised cooking space</p></li>' +
  '</ul>' +
  '<p>Thousands of happy cooks have already upgraded their daily kitchen workflow with it.</p>' +
  '<h2>What is in the box</h2>' +
  '<p>Every order includes the rotating tower, four removable trays, and a quick-start guide.</p>' +
  '<ul>' +
  '<li><p>One Elevate360 rotating base unit</p></li>' +
  '<li><p>Four dishwasher-safe storage trays</p></li>' +
  '<li><p>Printed quick-start and care guide</p></li>' +
  '</ul>' +
  '<p>Backed by responsive support if you ever have a question about your order.</p>' +
  '<h2>Specs</h2>' +
  '<p>Diameter 30cm. Height 35cm. Dishwasher-safe trays included for easy cleaning every time.</p>';

test('no_risk_reversal: lands AFTER the complete benefits </ul>, not inside any <li>', () => {
  const { out, before } = placeAt('no_risk_reversal', BENEFITS_BODY);
  assert.ok(!insideList(before), 'block must not be inside the benefits list');
  // The text immediately before the marker should be the list close, not a bullet.
  assert.match(before.slice(-40), /<\/ul>\s*$/, 'should anchor right after </ul>');
  assert.ok(listTagsBalanced(out), 'output list tags stay balanced');
});

test('no_risk_reversal: long paragraphs, no list → after a complete mid paragraph, not at bottom', () => {
  const paras = Array.from({ length: 8 }, (_, i) =>
    `<p>Paragraph ${i} explaining a meaningful product benefit in enough words to count as real context for the buyer.</p>`,
  ).join('');
  const { out, before } = placeAt('no_risk_reversal', paras);
  const pct = before.length / out.length;
  assert.ok(!insideList(before), 'no lists involved');
  assert.match(before, /<\/p>\s*$/, 'anchors after a </p>');
  assert.ok(pct >= 0.30 && pct <= 0.75, `mid placement, got ${(pct * 100).toFixed(1)}%`);
});

test('no_risk_reversal: nested list → block never inserts inside the nested <ul>/<li>', () => {
  const nested =
    '<h2>Overview</h2>' +
    '<p>This product solves a real problem and is explained right here up front for the shopper.</p>' +
    '<ul><li>Top feature<ul><li>nested detail one</li><li>nested detail two</li></ul></li>' +
    '<li>Another top feature with its own explanation text here</li></ul>' +
    '<p>Closing reassurance paragraph that wraps up the product story for the buyer.</p>';
  const { out, before } = placeAt('no_risk_reversal', nested);
  assert.ok(!insideList(before), 'must not be inside any (nested) list');
  assert.ok(listTagsBalanced(out), 'list tags stay balanced');
});

test('no_trust_bullets: inserts BEFORE the whole feature list, not inside a <li>', () => {
  const { out, before } = placeAt('no_trust_bullets', BENEFITS_BODY);
  assert.ok(!insideList(before), 'must not be inside the list');
  // Everything before the marker should contain zero <ul> opens (placed before the list).
  assert.strictEqual((before.match(/<ul\b/gi) || []).length, 0, 'placed before the <ul>');
  assert.ok(listTagsBalanced(out), 'output stays balanced');
});

test('no_trust_bullets: no list → after the first top-level paragraph', () => {
  const body =
    '<p>The opening paragraph introduces the product with enough words to establish context.</p>' +
    '<p>A second paragraph continues the description for the shopper.</p>';
  const { before } = placeAt('no_trust_bullets', body);
  assert.ok(!insideList(before), 'no lists');
  assert.match(before, /<\/p>\s*$/, 'anchors after a </p>');
  // Should be after the FIRST paragraph (not the bottom).
  assert.strictEqual((before.match(/<\/p>/gi) || []).length, 1, 'after first </p>');
});

test('weak_desire_creation: unchanged — after first </p>, before the feature list', () => {
  // weak_desire_creation wraps its insert in <p>…</p>, so `before` ends at the
  // wrapper's opening <p>; assert on structure rather than the exact trailing tag.
  const { before } = placeAt('weak_desire_creation', BENEFITS_BODY);
  assert.ok(!insideList(before), 'not inside a list');
  assert.strictEqual((before.match(/<\/p>/gi) || []).length, 1, 'after the first </p>');
  assert.strictEqual((before.match(/<ul\b/gi) || []).length, 0, 'before the feature list');
});

test('malformed-but-anchorable HTML → safe fallback, valid output, not inside list', () => {
  // Unclosed <ul> but a real top-level </p> exists → safe fallback anchors there.
  const malformed = '<p>An opening paragraph with enough descriptive text to give the buyer real context.</p><ul><li>dangling item';
  const { out, before } = placeAt('no_risk_reversal', malformed);
  assert.ok(out.includes('__CRO_MARK__'), 'marker present');
  assert.ok(!insideList(before), 'never inside the unclosed list');
  assert.match(before, /<\/p>\s*$/, 'anchored at the top-level </p>');
});

test('anchorless non-trivial HTML → refuses gracefully (no broken output)', () => {
  // No closing block tags at all + >=50 text chars → detectPatchMode hard-stops
  // rather than emitting broken HTML. Pre-existing safe contract, preserved.
  const noAnchors = 'Plain text with no closing block tags at all but plenty of characters to exceed the fifty char guard.';
  assert.throws(() => buildResultContent('no_risk_reversal', noAnchors, MARK), /no anchor found/);
});

test('deterministic: repeated buildResultContent calls produce identical output', () => {
  for (const issueId of ['no_risk_reversal', 'no_trust_bullets', 'weak_desire_creation']) {
    const a = buildResultContent(issueId, BENEFITS_BODY, MARK);
    const b = buildResultContent(issueId, BENEFITS_BODY, MARK);
    assert.strictEqual(a, b, `${issueId} output must be deterministic`);
  }
});
