'use strict';

// ---------------------------------------------------------------------------
// CRO Issue Classifier
//
// Converts a CRO issue ID into a structured change descriptor:
//   changeType   : THEME_PATCH | CONTENT_CHANGE | APP_CONFIG
//   generator    : which code generator to invoke (null if not automatable)
//   automatable  : whether the system can execute this without external apps
//   themeFiles   : which theme asset keys are typically affected
//   dataNeeded   : what inputs the generator will require
//
// Change types:
//   THEME_PATCH    — modifies Liquid/CSS/JS files in the theme
//   CONTENT_CHANGE — modifies product/page content via Shopify Products API
//   APP_CONFIG     — requires a third-party Shopify app; system can only guide
// ---------------------------------------------------------------------------

const CLASSIFICATION_MAP = {

  // ── THEME_PATCH — automatable ────────────────────────────────────────────

  trust_badges: {
    changeType: 'THEME_PATCH',
    generator: 'trust-badges',
    automatable: true,
    themeFiles: [
      'snippets/cro-trust-badges.liquid',  // created
      'assets/cro-trust-badges.css',       // created
      // injection target — detected at runtime:
      'sections/main-product.liquid',      // most common (Dawn, Sense, Craft)
      'templates/product.liquid',          // older themes
    ],
    dataNeeded: ['trustBadges[]', 'themeStructure'],
    risk: 'low',
    description: 'Inject trust badge row below the Add to Cart button',
  },

  sticky_atc: {
    changeType: 'THEME_PATCH',
    generator: 'sticky-atc',
    automatable: true,
    themeFiles: [
      'snippets/cro-sticky-atc.liquid',   // created
      'assets/cro-sticky-atc.css',        // created
      'assets/cro-sticky-atc.js',         // created
      'layout/theme.liquid',              // injection point (before </body>)
    ],
    dataNeeded: ['productTitle', 'themeStructure'],
    risk: 'medium',
    description: 'Add a sticky Add to Cart bar that appears on scroll, disappears near native ATC',
  },

  shipping_bar: {
    changeType: 'THEME_PATCH',
    generator: 'shipping-bar',
    automatable: true,
    themeFiles: [
      'snippets/cro-shipping-bar.liquid', // created
      'assets/cro-shipping-bar.css',      // created
      'assets/cro-shipping-bar.js',       // created
      // injection target — detected at runtime:
      'sections/main-cart-items.liquid',  // page cart (Dawn)
      'sections/cart-drawer.liquid',      // slide cart (Dawn)
    ],
    dataNeeded: ['freeShippingThreshold', 'currencyCode', 'themeStructure'],
    risk: 'medium',
    description: 'Animated progress bar in cart showing distance to free shipping',
  },

  // ── CONTENT_CHANGE — automatable ─────────────────────────────────────────

  missing_alt_text: {
    changeType: 'CONTENT_CHANGE',
    generator: 'alt-text',
    automatable: true,
    themeFiles: [],
    dataNeeded: ['product', 'images[]'],
    risk: 'low',
    description: 'Write and apply alt text to all product images via Products API',
  },

  description_center_aligned: {
    changeType: 'CONTENT_CHANGE',
    generator: 'description-fix',
    automatable: true,
    themeFiles: [],
    dataNeeded: ['product', 'bodyHtml'],
    risk: 'low',
    description: 'Strip text-align:center from product description HTML',
  },

  no_guarantee_in_description: {
    changeType: 'CONTENT_CHANGE',
    generator: 'guarantee-append',
    automatable: true,
    themeFiles: [],
    dataNeeded: ['product', 'bodyHtml', 'guaranteeCopy'],
    risk: 'low',
    description: 'Append a guarantee line to the product description',
  },

  no_description: {
    changeType: 'CONTENT_CHANGE',
    generator: null,          // requires human copywriter input
    automatable: false,
    themeFiles: [],
    dataNeeded: ['product', 'images[]'],
    risk: 'low',
    description: 'Product has no description — requires copywriter input before automation',
    manualSteps: [
      'Write a 300+ word benefits-first description',
      'Include: benefit bullets, storytelling paragraph, guarantee line',
      'Then re-run the execution pipeline for this product',
    ],
  },

  // ── APP_CONFIG — not automatable ─────────────────────────────────────────

  all_variants_oos: {
    changeType: 'APP_CONFIG',
    generator: null,
    automatable: false,
    themeFiles: [],
    dataNeeded: [],
    risk: 'none',
    description: 'Requires Back In Stock app — cannot be auto-deployed',
    manualSteps: [
      'Install "Back In Stock – Restock Alerts" from Shopify App Store',
      'Configure email template with product-specific copy',
      'Enable for all OOS products',
    ],
  },

  no_social_proof: {
    changeType: 'APP_CONFIG',
    generator: null,
    automatable: false,
    themeFiles: [],
    dataNeeded: [],
    risk: 'none',
    description: 'Requires Judge.me or Okendo — cannot be auto-deployed',
    manualSteps: [
      'Install Judge.me from Shopify App Store (free tier)',
      'Configure post-purchase review email: send 7 days after fulfillment',
      'Enable star rating widget below product title',
    ],
  },

  no_urgency: {
    changeType: 'APP_CONFIG',
    generator: null,
    automatable: false,
    themeFiles: [],
    dataNeeded: [],
    risk: 'none',
    description: 'Urgency signals require a real-time app with inventory hooks',
    manualSteps: [
      'Install "Urgency Bear" or "Hurrify" from Shopify App Store',
      'Configure shipping cutoff timer and stock counter',
    ],
  },

  no_bundle_pricing: {
    changeType: 'CONTENT_CHANGE',
    generator: null,
    automatable: false,
    themeFiles: [],
    dataNeeded: [],
    risk: 'none',
    description: 'Bundle variant creation — requires merchant pricing decision before automation',
    manualSteps: [
      'Decide on bundle price (e.g. 2x at 10% off)',
      'Add "2-Pack" variant to the product in Shopify Admin',
      'Or install a bundle app (Frequently Bought Together)',
    ],
  },
};

// ---------------------------------------------------------------------------
// classify(issueId) — returns the full classification descriptor
// ---------------------------------------------------------------------------
function classify(issueId) {
  return CLASSIFICATION_MAP[issueId] || {
    changeType: 'APP_CONFIG',
    generator: null,
    automatable: false,
    themeFiles: [],
    dataNeeded: [],
    risk: 'unknown',
    description: `No classification defined for issue: ${issueId}`,
    manualSteps: ['Review issue manually'],
  };
}

// ---------------------------------------------------------------------------
// getAutomatableIssues(issues[]) — filter to only issues we can execute
// ---------------------------------------------------------------------------
function getAutomatableIssues(issues) {
  return issues.filter(i => {
    const cls = classify(i.issueId);
    return cls.automatable === true;
  });
}

module.exports = { classify, getAutomatableIssues };
