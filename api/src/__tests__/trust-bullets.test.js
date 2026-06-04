'use strict';

// ---------------------------------------------------------------------------
// Targeted tests for no_trust_bullets copy safety (generateTrustBullets).
//
// Regression guard for cross-product contamination: product.vendor is polluted
// store-wide in some stores (every product carries one sibling's brand, e.g.
// "AURA Magnetic Powerbank"). The rule must NOT interpolate vendor/brand/team
// names into trust copy. It must use neutral support language and may reference
// only the CURRENT product's own title.
//
// Drives the real rule via RULES.find('no_trust_bullets').build(product).
//
// Run: node --test src/__tests__/trust-bullets.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const { RULES } = require('../services/cro/rules');
const { buildSupportBullets } = require('../services/cro/generators/trust-bullets-llm');

const trustRule = RULES.find(r => r.id === 'no_trust_bullets');

function buildContent(product) {
  const fix = trustRule.build(product).generatedFix;
  return {
    full:    fix.bestGuess.content,
    variants: fix.variants.map(v => v.content),
  };
}

// TurboFlush with the polluted vendor field that caused the original bug.
const turboFlush = {
  title:    'TurboFlush™ - High-Pressure Drain Opening',
  vendor:   'AURA Magnetic Powerbank',   // polluted store-wide vendor
  bodyHtml: '<p>High-pressure drain opener that clears blockages fast.</p>',
  variants: [{ price: '39.99' }],
};

test('TurboFlush trust bullets do not leak the polluted vendor / sibling product name', () => {
  const { full, variants } = buildContent(turboFlush);
  const all = [full, ...variants].join(' ');
  assert.ok(!/AURA/i.test(all),                'must not contain "AURA"');
  assert.ok(!/Magnetic Powerbank/i.test(all),  'must not contain "Magnetic Powerbank"');
  assert.ok(!/AURA Magnetic Powerbank/i.test(all), 'must not contain the sibling product name');
  assert.ok(!/the\s+.*\bteam\b/i.test(all) || /our team/i.test(all),
    'must not interpolate "the <vendor> team"');
});

test('trust bullets use neutral support language', () => {
  const { full } = buildContent(turboFlush);
  assert.ok(/our team|contact us|get in touch|we[''’]/i.test(full),
    'should use neutral seller/support language ("our team" / "get in touch" / "we")');
  // Never the vendor-team interpolation pattern
  assert.ok(!/The AURA Magnetic Powerbank team/i.test(full));
});

test('trust bullets remain product-relevant (current product title only)', () => {
  const { full } = buildContent(turboFlush);
  assert.ok(/TurboFlush/i.test(full), 'should reference the current product');
});

test('trust bullets do not invent legal / policy claims', () => {
  const { full, variants } = buildContent(turboFlush);
  const all = [full, ...variants].join(' ');
  assert.ok(!/free returns?/i.test(all),            'no free returns claim');
  assert.ok(!/money[- ]back/i.test(all),            'no money-back claim');
  assert.ok(!/\d+[\s-]day[\s-](guarantee|return|refund|warranty|trial)/i.test(all), 'no N-day guarantee');
  assert.ok(!/warranty/i.test(all),                 'no warranty claim');
  assert.ok(!/guaranteed[\s-](delivery|results?)/i.test(all), 'no guaranteed delivery/results');
  assert.ok(!/risk[- ]free/i.test(all),             'no risk-free claim');
});

test('clean vendor still produces clean copy (no regression for legitimate stores)', () => {
  const projector = {
    title:    'Magcubic HY350MAX Projector',
    vendor:   'Magcubic',
    bodyHtml: '<p>Portable 8K projector for home cinema.</p>',
    variants: [{ price: '190' }],
  };
  const { full } = buildContent(projector);
  assert.ok(/Magcubic HY350MAX Projector/i.test(full), 'references current product');
  assert.ok(/our team|get in touch|contact us/i.test(full), 'neutral support language present');
});

test('product with no title falls back to fully neutral copy', () => {
  const noTitle = { title: '', vendor: 'AURA Magnetic Powerbank', bodyHtml: '<p>x</p>', variants: [{ price: '10' }] };
  const { full } = buildContent(noTitle);
  assert.ok(!/AURA/i.test(full), 'no vendor leakage even without a title');
  assert.ok(/our team|get in touch/i.test(full), 'neutral support language present');
});

// ---------------------------------------------------------------------------
// LLM path: buildSupportBullets builds the template bullets 2 & 3 that are
// appended to the LLM-generated bullet 1. This is the ACTUAL served path when
// ANTHROPIC_API_KEY is present, and previously carried the same vendor leak.
// ---------------------------------------------------------------------------
test('LLM-path support bullets (buildSupportBullets) do not leak polluted vendor', () => {
  const { b2, b3 } = buildSupportBullets(turboFlush);
  const all = [b2, b3].filter(Boolean).join(' ');
  assert.ok(!/AURA/i.test(all),               'b2/b3 must not contain "AURA"');
  assert.ok(!/Magnetic Powerbank/i.test(all), 'b2/b3 must not contain "Magnetic Powerbank"');
  assert.ok(!/The AURA Magnetic Powerbank team/i.test(all), 'no vendor-team interpolation');
  assert.ok(/our team/i.test(b2),             'b2 uses neutral "our team" language');
  assert.ok(/TurboFlush/i.test(b2),           'b2 references the current product only');
});

test('LLM-path support bullets do not invent policy claims', () => {
  const { b2, b3 } = buildSupportBullets(turboFlush);
  const all = [b2, b3].filter(Boolean).join(' ');
  assert.ok(!/money[- ]back|free returns?|\d+[\s-]day[\s-](guarantee|return|refund|warranty)|warranty|guaranteed[\s-](delivery|results?)|risk[- ]free/i.test(all),
    'no invented legal/policy claims');
});
