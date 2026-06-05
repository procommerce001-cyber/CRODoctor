'use strict';

// ---------------------------------------------------------------------------
// Regression guard for the no_trust_bullets LLM prose helper buildSupportBullets.
//
// NOTE: As of Phase 2, no_trust_bullets renders a controlled visual Trust Badge
// block (see trust-badges.test.js) and the LLM prose path is disabled
// (generateTrustBulletsWithLLM returns null). buildSupportBullets remains in the
// codebase for a possible future LLM-badge-selection phase, so these tests stay
// as a contamination guard for that dormant helper: it must never interpolate a
// polluted product.vendor / sibling brand into copy.
//
// Run: node --test src/__tests__/trust-bullets.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const { buildSupportBullets } = require('../services/cro/generators/trust-bullets-llm');

// TurboFlush with the polluted vendor field that caused the original bug.
const turboFlush = {
  title:    'TurboFlush™ - High-Pressure Drain Opening',
  vendor:   'AURA Magnetic Powerbank',   // polluted store-wide vendor
  bodyHtml: '<p>High-pressure drain opener that clears blockages fast.</p>',
  variants: [{ price: '39.99' }],
};

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
