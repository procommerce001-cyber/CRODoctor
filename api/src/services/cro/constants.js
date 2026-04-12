'use strict';

// ---------------------------------------------------------------------------
// CRO Engine Constants
// Single source of truth for all enum-like values used across the engine.
// ---------------------------------------------------------------------------

const CATEGORIES = {
  TRUST:            'trust',
  VALUE_CLARITY:    'valueClarity',
  FRICTION:         'friction',
  URGENCY:          'urgency',
  EMOTIONAL:        'emotionalSelling',
  AOV:              'aov',
  CONSISTENCY:      'consistency',
  CONVERSION:       'conversion',   // desire creation, outcome language, emotional engagement
};

// Severity drives scoring deductions and issue ordering.
// critical → the product cannot generate revenue in its current state
// high     → meaningful CVR loss, fixable without redesign
// medium   → noticeable opportunity, low-risk fix
// low      → polish / SEO / marginal lift
const SEVERITY = {
  CRITICAL: 'critical',   // -25 pts each
  HIGH:     'high',       // -12 pts each
  MEDIUM:   'medium',     // -5 pts each
  LOW:      'low',        // -2 pts each
};

const SEVERITY_DEDUCTIONS = {
  critical: 25,
  high:     12,
  medium:    5,
  low:       2,
};

// Revenue dimensions each issue affects
const IMPACT = {
  CONVERSION: 'conversion',
  AOV:        'aov',
  TRUST:      'trust',
  RETENTION:  'retention',
  SEO:        'seo',
};

// How hard is the fix to implement
const EFFORT = {
  LOW:    'low',    // merchant can do it in Shopify Admin, < 30 min
  MEDIUM: 'medium', // needs a Shopify app or theme section edit, < 2 hrs
  HIGH:   'high',   // requires developer or substantial content creation
};

// How confident is the engine that this is a real problem
// (limited by what we can detect from Shopify product data alone)
const CONFIDENCE = {
  HIGH:   'high',   // deterministic from data
  MEDIUM: 'medium', // inferred with reasonable certainty
  LOW:    'low',    // assumption — needs live page audit to confirm
};

// What kind of change is needed to fix this
const IMPLEMENTATION_TYPE = {
  THEME_PATCH:     'THEME_PATCH',      // Liquid/CSS/JS modification
  CONTENT_CHANGE:  'CONTENT_CHANGE',   // Product data update via API
  APP_CONFIG:      'APP_CONFIG',       // Requires third-party Shopify app
  MERCHANT_ACTION: 'MERCHANT_ACTION',  // Shopify Admin action only
};

// Score bands — what a score means in plain English
const SCORE_BANDS = [
  { min: 80, max: 100, label: 'Strong',   description: 'Well optimized. Minor improvements available.' },
  { min: 60, max:  79, label: 'Good',     description: 'Solid foundation. Clear revenue opportunities.' },
  { min: 40, max:  59, label: 'Needs Work', description: 'Significant gaps. Multiple fixable issues.' },
  { min: 20, max:  39, label: 'Weak',     description: 'Major problems. Revenue impact is high.' },
  { min:  0, max:  19, label: 'Critical', description: 'Cannot generate meaningful revenue in current state.' },
];

function scoreBand(score) {
  return SCORE_BANDS.find(b => score >= b.min && score <= b.max) || SCORE_BANDS[SCORE_BANDS.length - 1];
}

// Data points the engine cannot determine from Shopify product/order data alone.
// Returned in missingData[] to be honest about engine limitations.
const STORE_MISSING_DATA = [
  { key: 'reviews_app_installed',    reason: 'Cannot detect third-party review app status from product data' },
  { key: 'cart_type',                reason: 'Cannot determine if store uses slide cart or page cart without live theme inspection' },
  { key: 'checkout_friction',        reason: 'Checkout configuration not accessible via product sync' },
  { key: 'actual_conversion_rate',   reason: 'Requires analytics integration (Google Analytics, Shopify Analytics)' },
  { key: 'add_to_cart_rate',         reason: 'Requires analytics integration' },
  { key: 'cart_abandonment_rate',    reason: 'Requires analytics integration' },
  { key: 'traffic_source_mix',       reason: 'Requires analytics integration — cold vs warm traffic ratio unknown' },
  { key: 'mobile_vs_desktop_split',  reason: 'Requires analytics integration' },
  { key: 'urgency_app_installed',    reason: 'Cannot detect urgency/scarcity app from product data' },
];

const PRODUCT_MISSING_DATA = [
  { key: 'review_count',         reason: 'Review apps are external — review data is not in Shopify product sync' },
  { key: 'atc_rate',             reason: 'Requires analytics — cannot determine from product data alone' },
  { key: 'page_scroll_depth',    reason: 'Requires session recording tool (Hotjar, Lucky Orange)' },
  { key: 'live_page_layout',     reason: 'Cannot inspect theme layout without a live theme audit' },
];

// Shared map from engine implementationType values to Action Center applyType strings.
// Single source of truth — imported by action-center.service and content-execution.service.
const APPLY_TYPE_MAP = {
  CONTENT_CHANGE:  'content_change',
  THEME_PATCH:     'theme_change',
  APP_CONFIG:      'manual',
  MERCHANT_ACTION: 'manual',
};

module.exports = {
  CATEGORIES,
  SEVERITY,
  SEVERITY_DEDUCTIONS,
  IMPACT,
  EFFORT,
  CONFIDENCE,
  IMPLEMENTATION_TYPE,
  APPLY_TYPE_MAP,
  SCORE_BANDS,
  STORE_MISSING_DATA,
  PRODUCT_MISSING_DATA,
  scoreBand,
};
