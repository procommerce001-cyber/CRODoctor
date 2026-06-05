'use strict';

// ---------------------------------------------------------------------------
// Phase 2 Trust Badges tests — controlled visual badge block for no_trust_bullets.
//
// Verifies the rule now outputs a deterministic visual badge block (not prose),
// using only approved safe-default labels, with no policy/commercial claims and
// no cross-product contamination, and that the Safety Validator enforces the
// badge allowlist.
//
// Run: node --test src/__tests__/trust-badges.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const { RULES } = require('../services/cro/rules');
const { generateTrustBadges, ALLOWED_BETA_BADGE_LABELS } = require('../services/cro/trust-badges');
const { validateContentSafety } = require('../services/content-safety-validator');

const trustRule = RULES.find(r => r.id === 'no_trust_bullets');

// TurboFlush with the polluted vendor field that caused the original prose bug.
const turboFlush = {
  id:       'p_turbo',
  title:    'TurboFlush™ - High-Pressure Drain Opening',
  vendor:   'AURA Magnetic Powerbank',
  bodyHtml: '<p>High-pressure drain opener that clears blockages fast.</p>',
  variants: [{ price: '39.99' }],
};
const siblings = [
  { id: 'p_turbo', title: 'TurboFlush™ - High-Pressure Drain Opening' },
  { id: 'p_aura',  title: 'AURA Magnetic Wireless PowerBank (10,000mAh)' },
];

function ruleContent() {
  const fix = trustRule.build(turboFlush).generatedFix;
  return { full: fix.bestGuess.content, variants: fix.variants.map(v => v.content) };
}

const DISALLOWED = [
  /free\s+shipping/i, /fast\s+shipping/i, /free\s+returns?/i, /easy\s+returns?/i,
  /30[\s-]day/i, /\bwarranty\b/i, /money[- ]back/i, /satisfaction\s+guarantee/i,
  /risk[- ]free/i, /guaranteed\s+delivery/i, /\breturns?\b/i,
];

// 1. Visual badge HTML, not prose bullets.
test('no_trust_bullets generates a visual badge block, not prose bullets', () => {
  const { full } = ruleContent();
  assert.ok(/data-cro-trust-badges/.test(full),  'has the trust-badges wrapper');
  assert.ok(/class="cro-trust-badge"/.test(full), 'has badge cards');
  assert.ok(/<svg/.test(full),                    'has inline icons');
  assert.ok(!/^<ul>/.test(full.trim()),           'is not a bare <ul> prose list');
});

// 2. Only allowed safe badge labels appear.
test('output contains only approved safe badge labels', () => {
  const { full } = ruleContent();
  const labels = [...full.matchAll(/>([^<>]+)<\/span>/g)].map(m => m[1].trim()).filter(Boolean);
  assert.ok(labels.length >= 3, 'at least 3 badge labels');
  labels.forEach(l => assert.ok(ALLOWED_BETA_BADGE_LABELS.includes(l), `label "${l}" must be approved`));
});

// 3. No unsupported policy/commercial claims.
test('output contains no shipping/returns/warranty/money-back/guarantee claims', () => {
  const { full, variants } = ruleContent();
  const all = [full, ...variants].join(' ');
  DISALLOWED.forEach(re => assert.ok(!re.test(all), `must not contain ${re}`));
});

// 4. Exactly one badge block (wrapper) per generated output.
test('output has exactly one trust-badges block', () => {
  const { full } = ruleContent();
  assert.strictEqual((full.match(/data-cro-trust-badges/g) || []).length, 1);
});

// 5. No cross-product contamination (badges never use vendor/title).
test('output has no AURA / Magnetic Powerbank contamination on TurboFlush', () => {
  const { full, variants } = ruleContent();
  const all = [full, ...variants].join(' ');
  assert.ok(!/AURA/i.test(all),              'no AURA');
  assert.ok(!/Magnetic Powerbank/i.test(all), 'no Magnetic Powerbank');
  assert.ok(!/TurboFlush/i.test(all),        'badges do not interpolate the product title either');
});

// HTML safety: no scripts / handlers / external assets.
test('output is inline-safe (no script/handlers/external assets)', () => {
  const { full } = ruleContent();
  assert.ok(!/<script/i.test(full),     'no script tag');
  assert.ok(!/on\w+\s*=/i.test(full),   'no event handlers');
  assert.ok(!/https?:\/\//i.test(full), 'no external URLs');
  assert.ok(!/<style/i.test(full),      'no style tag');
});

// 6. Safety Validator passes the safe badge output.
test('Safety Validator passes the generated safe badge block', async () => {
  const { full } = ruleContent();
  const res = await validateContentSafety({
    store: { id: 's1' }, product: turboFlush, issueId: 'no_trust_bullets',
    proposedContent: full, currentBodyHtml: turboFlush.bodyHtml, siblingProducts: siblings,
  });
  assert.strictEqual(res.safe, true, res.reason || '');
});

// 7. Safety Validator blocks an injected unsupported policy badge.
test('Safety Validator blocks an injected policy badge label', async () => {
  const injected =
    '<div class="cro-trust-badges" data-cro-trust-badges="1">' +
    '<span class="cro-trust-badge"><span aria-hidden="true"><svg></svg></span><span>Secure Checkout</span></span>' +
    '<span class="cro-trust-badge"><span aria-hidden="true"><svg></svg></span><span>Free Shipping</span></span>' +
    '</div>';
  const res = await validateContentSafety({
    store: { id: 's1' }, product: turboFlush, issueId: 'no_trust_bullets',
    proposedContent: injected, currentBodyHtml: turboFlush.bodyHtml, siblingProducts: siblings,
  });
  assert.strictEqual(res.safe, false, 'must block unapproved badge label');
});

test('Safety Validator blocks an injected money-back badge', async () => {
  const injected =
    '<div class="cro-trust-badges" data-cro-trust-badges="1">' +
    '<span class="cro-trust-badge"><span aria-hidden="true"><svg></svg></span><span>Money-Back Guarantee</span></span>' +
    '</div>';
  const res = await validateContentSafety({
    store: { id: 's1' }, product: turboFlush, issueId: 'no_trust_bullets',
    proposedContent: injected, currentBodyHtml: turboFlush.bodyHtml, siblingProducts: siblings,
  });
  assert.strictEqual(res.safe, false, 'must block money-back claim');
});

// generateTrustBadges direct shape check.
test('generateTrustBadges returns the standard {bestGuess, variants} shape', () => {
  const fix = generateTrustBadges(turboFlush);
  assert.ok(fix.bestGuess && typeof fix.bestGuess.content === 'string');
  assert.ok(Array.isArray(fix.variants) && fix.variants.length >= 1);
});
