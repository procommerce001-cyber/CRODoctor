'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  validateContentSafety,
  checkHtmlSafety,
  checkDuplicateCROBlock,
  checkCrossProductContamination,
  checkUnsupportedClaims,
  checkLanguageConsistency,
} = require('../services/content-safety-validator');

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TURBOFLUSH_PRODUCT = {
  id:    'cmnsyorjn006v1446ra5ymbr7',
  title: 'TurboFlush™ - High-Pressure Drain Opening',
};

const AURA_SIBLING = {
  id:    'cmnsyokn300011446pt4c7d8j',
  title: 'AURA Magnetic Wireless PowerBank (10,000mAh)',
};

const BAMBOO_SIBLING = {
  id:    'cmnsyop30004d1446ovkdkq6w',
  title: 'Foldable Bamboo Sofa Tray',
};

const SWIMCARRIER_SIBLING = {
  id:    'cmpcwjefo000g6xc5n69k019x',
  title: 'SwimCarrier™ - Adjustable Swim Baby Carrier',
};

const TURBOFLUSH_BODY = `<h2>Meet the TurboFlush</h2>
<p>Clogged drains are annoying. And when everything backs up? It becomes a real problem.</p>
<p>Turbo Flush fixes all of that in seconds.</p>`;

const CLEAN_RISK_REVERSAL = `<p><strong>Not what you expected? Reach out — we'll help make it right.</strong></p>
<ul>
<li>If it's not what you hoped for, just reach out to our team — we'll work out the right next step together.</li>
<li>We take every order seriously. If something isn't right, getting in touch is easy — we'll do our best to sort it.</li>
</ul>`;

// ---------------------------------------------------------------------------
// HTML safety
// ---------------------------------------------------------------------------

describe('checkHtmlSafety', () => {
  test('allows clean HTML (p, strong, ul, li)', () => {
    const result = checkHtmlSafety(CLEAN_RISK_REVERSAL);
    assert.equal(result.safe, true);
  });

  test('blocks script tag', () => {
    const result = checkHtmlSafety('<p>Good copy</p><script>alert(1)</script>');
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsafe_html');
  });

  test('blocks iframe', () => {
    const result = checkHtmlSafety('<p>Text</p><iframe src="evil.com"></iframe>');
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsafe_html');
  });

  test('blocks onclick event handler', () => {
    const result = checkHtmlSafety('<p onclick="steal()">Click me</p>');
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsafe_html');
  });

  test('blocks onload event handler', () => {
    const result = checkHtmlSafety('<div onload="xss()">content</div>');
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsafe_html');
  });

  test('blocks javascript: protocol', () => {
    const result = checkHtmlSafety('<a href="javascript:void(0)">link</a>');
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsafe_html');
  });

  test('blocks form tag', () => {
    const result = checkHtmlSafety('<form action="steal.php"><input name="cc"></form>');
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsafe_html');
  });

  test('allows div, span, br', () => {
    const result = checkHtmlSafety('<div><span>Text</span><br/></div>');
    assert.equal(result.safe, true);
  });
});

// ---------------------------------------------------------------------------
// Duplicate CRO block
// ---------------------------------------------------------------------------

describe('checkDuplicateCROBlock', () => {
  test('blocks when data-cro-block for same issueId already in body', () => {
    const body = `${TURBOFLUSH_BODY}<div data-cro-block="no_risk_reversal" data-cro-eid="abc">existing</div>`;
    const result = checkDuplicateCROBlock('no_risk_reversal', CLEAN_RISK_REVERSAL, body);
    assert.equal(result.safe, false);
    assert.equal(result.code, 'duplicate_cro_block');
  });

  test('allows when data-cro-block is for a different issueId', () => {
    const body = `${TURBOFLUSH_BODY}<div data-cro-block="no_trust_bullets" data-cro-eid="abc">existing</div>`;
    const result = checkDuplicateCROBlock('no_risk_reversal', CLEAN_RISK_REVERSAL, body);
    assert.equal(result.safe, true);
  });

  test('blocks when exact proposed text already present in body', () => {
    const proposed = 'We take every order seriously. If something is not right, reach out.';
    const body     = `${TURBOFLUSH_BODY}<p>${proposed}</p>`;
    const result   = checkDuplicateCROBlock('no_risk_reversal', proposed, body);
    assert.equal(result.safe, false);
    assert.equal(result.code, 'duplicate_cro_block');
  });

  test('allows when proposed text is not in body', () => {
    const result = checkDuplicateCROBlock('no_risk_reversal', CLEAN_RISK_REVERSAL, TURBOFLUSH_BODY);
    assert.equal(result.safe, true);
  });

  test('allows when currentBodyHtml is null', () => {
    const result = checkDuplicateCROBlock('no_risk_reversal', CLEAN_RISK_REVERSAL, null);
    assert.equal(result.safe, true);
  });
});

// ---------------------------------------------------------------------------
// Cross-product contamination
// ---------------------------------------------------------------------------

describe('checkCrossProductContamination', () => {
  const siblings = [AURA_SIBLING, BAMBOO_SIBLING, SWIMCARRIER_SIBLING];

  test('blocks TurboFlush content mentioning AURA Magnetic Powerbank (2 distinctive words)', () => {
    const contaminated = `<p>If you're not seeing the improvement, get in touch with the AURA Magnetic Powerbank team.</p>`;
    const result = checkCrossProductContamination(TURBOFLUSH_PRODUCT, contaminated, siblings);
    assert.equal(result.safe, false);
    assert.equal(result.code, 'cross_product_contamination');
  });

  test('blocks content mentioning Foldable Bamboo sibling (2 distinctive words)', () => {
    const contaminated = `<p>This foldable bamboo design is great for your sofa.</p>`;
    const result = checkCrossProductContamination(TURBOFLUSH_PRODUCT, contaminated, siblings);
    assert.equal(result.safe, false);
    assert.equal(result.code, 'cross_product_contamination');
  });

  test('allows neutral content using "our team", "we", "us"', () => {
    const result = checkCrossProductContamination(TURBOFLUSH_PRODUCT, CLEAN_RISK_REVERSAL, siblings);
    assert.equal(result.safe, true);
  });

  test('allows content with only 1 distinctive sibling word (below threshold)', () => {
    // "aura" matches AURA sibling but only 1 distinctive word — should not block
    const borderline = `<p>The aura of clean pipes is its own reward. Reach out to our team.</p>`;
    const result = checkCrossProductContamination(TURBOFLUSH_PRODUCT, borderline, siblings);
    assert.equal(result.safe, true);
  });

  test('does not block common stopwords: back, support, health, magnetic, wireless', () => {
    const commonWords = `<p>Improve your back support. Smart, wireless and safe for your health.</p>`;
    const result = checkCrossProductContamination(TURBOFLUSH_PRODUCT, commonWords, siblings);
    assert.equal(result.safe, true);
  });

  test('does not flag a product against its own title words', () => {
    // TurboFlush content mentioning "turboflush" should NOT flag as cross-product
    const ownContent = `<p>If TurboFlush doesn't clear your drain, reach out to our team.</p>`;
    const allSiblings = [TURBOFLUSH_PRODUCT, AURA_SIBLING, BAMBOO_SIBLING];
    const result = checkCrossProductContamination(TURBOFLUSH_PRODUCT, ownContent, allSiblings);
    assert.equal(result.safe, true);
  });

  test('allows empty sibling list', () => {
    const result = checkCrossProductContamination(TURBOFLUSH_PRODUCT, CLEAN_RISK_REVERSAL, []);
    assert.equal(result.safe, true);
  });
});

// ---------------------------------------------------------------------------
// Unsupported commercial claims
// ---------------------------------------------------------------------------

describe('checkUnsupportedClaims', () => {
  test('blocks money-back guarantee claim', () => {
    const result = checkUnsupportedClaims(
      '<p>Not satisfied? Get a full money-back guarantee.</p>',
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsupported_claim');
  });

  test('blocks 30-day refund claim', () => {
    const result = checkUnsupportedClaims(
      '<p>30-day refund — no questions asked.</p>',
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsupported_claim');
  });

  test('blocks 30-day return claim', () => {
    const result = checkUnsupportedClaims(
      '<p>Try it with our 30-day return policy.</p>',
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsupported_claim');
  });

  test('blocks risk-free claim', () => {
    const result = checkUnsupportedClaims(
      '<p>Order risk-free today.</p>',
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsupported_claim');
  });

  test('blocks guaranteed results claim', () => {
    const result = checkUnsupportedClaims(
      '<p>Guaranteed results or your money back.</p>',
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsupported_claim');
  });

  test('allows soft guarantee language: reach out, our team, we will help', () => {
    const result = checkUnsupportedClaims(CLEAN_RISK_REVERSAL, TURBOFLUSH_BODY);
    assert.equal(result.safe, true);
  });

  test('allows: "if something is not right, contact us"', () => {
    const result = checkUnsupportedClaims(
      '<p>If something is not right, contact us and we will sort it out.</p>',
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, true);
  });

  test('allows money-back claim when same policy already exists on product page', () => {
    const bodyWithPolicy = `${TURBOFLUSH_BODY}<p>30-day money-back guarantee included.</p>`;
    const result = checkUnsupportedClaims(
      '<p>Buy with confidence — money-back if not satisfied.</p>',
      bodyWithPolicy,
    );
    assert.equal(result.safe, true);
  });

  // Verb-form refund promises — must block
  test('blocks "refund your investment entirely"', () => {
    const result = checkUnsupportedClaims(
      "<p>If it doesn't work for your space, we'll refund your investment entirely.</p>",
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsupported_claim');
  });

  test('blocks "refund your purchase"', () => {
    const result = checkUnsupportedClaims(
      "<p>If you're not happy, we'll refund your purchase.</p>",
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsupported_claim');
  });

  test('blocks "refund you in full"', () => {
    const result = checkUnsupportedClaims(
      "<p>We'll refund you in full.</p>",
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsupported_claim');
  });

  test('blocks "completely refund your order"', () => {
    const result = checkUnsupportedClaims(
      "<p>We'll completely refund your order.</p>",
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsupported_claim');
  });

  test('blocks "fully refund your payment"', () => {
    const result = checkUnsupportedClaims(
      "<p>If something goes wrong, we'll fully refund your payment.</p>",
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsupported_claim');
  });

  // Safe support language — must allow
  test('allows "reach out and our team will help"', () => {
    const result = checkUnsupportedClaims(
      '<p>If something is not right, reach out and our team will help.</p>',
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, true);
  });

  test('allows "contact us and we will make it right"', () => {
    const result = checkUnsupportedClaims(
      "<p>If you need help, contact us and we'll make it right.</p>",
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, true);
  });

  test('allows "our team is here to help if the product does not meet expectations"', () => {
    const result = checkUnsupportedClaims(
      '<p>Our team is here to help if the product does not meet your expectations.</p>',
      TURBOFLUSH_BODY,
    );
    assert.equal(result.safe, true);
  });
});

// ---------------------------------------------------------------------------
// Language consistency
// ---------------------------------------------------------------------------

describe('checkLanguageConsistency', () => {
  const hebrewBody    = '<p>מוצר מעולה לניקוי ביוב וצינורות. עובד מצוין ומהיר.</p>';
  const latinContent  = '<p>Not what you expected? Reach out to our team.</p>';
  const hebrewContent = '<p>אם לא מרוצה, צור קשר עם הצוות שלנו.</p>';

  test('blocks Latin content for Hebrew product page', () => {
    const result = checkLanguageConsistency(latinContent, hebrewBody);
    assert.equal(result.safe, false);
    assert.equal(result.code, 'language_mismatch');
  });

  test('blocks Hebrew content for Latin product page', () => {
    const result = checkLanguageConsistency(hebrewContent, TURBOFLUSH_BODY);
    assert.equal(result.safe, false);
    assert.equal(result.code, 'language_mismatch');
  });

  test('allows Latin content for Latin product page', () => {
    const result = checkLanguageConsistency(CLEAN_RISK_REVERSAL, TURBOFLUSH_BODY);
    assert.equal(result.safe, true);
  });

  test('allows when currentBodyHtml is null', () => {
    const result = checkLanguageConsistency(CLEAN_RISK_REVERSAL, null);
    assert.equal(result.safe, true);
  });

  test('allows when content is too short to judge', () => {
    const result = checkLanguageConsistency('<p>Hi</p>', hebrewBody);
    assert.equal(result.safe, true);
  });
});

// ---------------------------------------------------------------------------
// validateContentSafety — integration (no DB, uses siblingProducts)
// ---------------------------------------------------------------------------

describe('validateContentSafety (integration)', () => {
  const store   = { id: 'store-1' };
  const product = TURBOFLUSH_PRODUCT;
  const siblings = [AURA_SIBLING, BAMBOO_SIBLING, SWIMCARRIER_SIBLING];

  test('allows clean reviewed content for TurboFlush no_risk_reversal', async () => {
    const result = await validateContentSafety({
      store, product,
      issueId:         'no_risk_reversal',
      proposedContent: CLEAN_RISK_REVERSAL,
      currentBodyHtml: TURBOFLUSH_BODY,
      siblingProducts: siblings,
    });
    assert.equal(result.safe, true);
  });

  test('blocks AURA Magnetic Powerbank contamination', async () => {
    const contaminated = `<p><strong>Not seeing the improvement you expected? We want to hear from you.</strong></p>
<ul>
<li>If you're not seeing the improvement you expected, get in touch with the AURA Magnetic Powerbank team — we want to understand what happened and help.</li>
<li>We want this product to work for you.</li>
</ul>`;
    const result = await validateContentSafety({
      store, product,
      issueId:         'no_risk_reversal',
      proposedContent: contaminated,
      currentBodyHtml: TURBOFLUSH_BODY,
      siblingProducts: siblings,
    });
    assert.equal(result.safe, false);
    assert.equal(result.code, 'cross_product_contamination');
  });

  test('blocks unsafe HTML', async () => {
    const result = await validateContentSafety({
      store, product,
      issueId:         'no_risk_reversal',
      proposedContent: '<script>alert(1)</script><p>Good copy</p>',
      currentBodyHtml: TURBOFLUSH_BODY,
      siblingProducts: siblings,
    });
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsafe_html');
  });

  test('blocks duplicate CRO block when marker already in body', async () => {
    const bodyWithMarker = `${TURBOFLUSH_BODY}<div data-cro-block="no_risk_reversal">existing</div>`;
    const result = await validateContentSafety({
      store, product,
      issueId:         'no_risk_reversal',
      proposedContent: CLEAN_RISK_REVERSAL,
      currentBodyHtml: bodyWithMarker,
      siblingProducts: siblings,
    });
    assert.equal(result.safe, false);
    assert.equal(result.code, 'duplicate_cro_block');
  });

  test('blocks money-back claim without policy evidence', async () => {
    const result = await validateContentSafety({
      store, product,
      issueId:         'no_risk_reversal',
      proposedContent: '<p>Order with confidence — full money-back guaranteed.</p>',
      currentBodyHtml: TURBOFLUSH_BODY,
      siblingProducts: siblings,
    });
    assert.equal(result.safe, false);
    assert.equal(result.code, 'unsupported_claim');
  });

  test('returns safe:true and never throws when proposedContent is clean', async () => {
    await assert.doesNotReject(() =>
      validateContentSafety({
        store, product,
        issueId:         'no_trust_bullets',
        proposedContent: '<ul><li>We know this product well.</li><li>Our team is here if you need us.</li></ul>',
        currentBodyHtml: TURBOFLUSH_BODY,
        siblingProducts: siblings,
      })
    );
  });
});
