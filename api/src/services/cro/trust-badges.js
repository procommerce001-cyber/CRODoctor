'use strict';

// ---------------------------------------------------------------------------
// trust-badges.js  —  Phase 2 (beta) controlled Trust Badge library
//
// Replaces the prose `no_trust_bullets` output with a clean, deterministic
// visual badge block rendered into product bodyHtml. Beta scope: SAFE DEFAULT
// badges only (Class A). All policy/commercial badges (shipping, returns,
// warranty, money-back, guarantee, delivery-time) are intentionally NOT in the
// beta library — they require policy evidence + merchant approval (later phase).
//
// Visible labels come ONLY from the templates below — never from free text /
// LLM output. No product.vendor / product.title interpolation, so cross-product
// contamination is structurally impossible.
//
// Output contract matches generateTrustBullets: { bestGuess:{content}, variants }
// where content is a bare HTML block (no_trust_bullets wrapContent is pass-through;
// the data-cro-block="no_trust_bullets" wrapper is added by the apply pipeline).
// ---------------------------------------------------------------------------

// Minimal inline line-icons. fill:none + stroke:currentColor so they inherit the
// theme's text color and never ship raster/external assets. Decorative only.
const ICONS = {
  // NOTE: SVG attribute is intentionally lowercase `viewbox` (not camelCase
  // `viewBox`). Shopify's body_html sanitizer lowercases attribute names on save;
  // emitting lowercase keeps stored resultContent byte-aligned with the live/local
  // body so the rollback guard's equivalence check holds. Browsers re-map
  // `viewbox`→`viewBox` for inline SVG during HTML parsing, so rendering is
  // unaffected. (Companion: safeHtmlEquivalent also normalizes viewBox/viewbox for
  // executions applied before this change.)
  lock:  '<svg viewbox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  card:  '<svg viewbox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/></svg>',
  chat:  '<svg viewbox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l.9-5A8 8 0 1 1 21 12z"/></svg>',
  check: '<svg viewbox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  star:  '<svg viewbox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.7 5.5 6 .9-4.4 4.2 1 6L12 17.8 6.7 19.6l1-6L3.3 9.4l6-.9z"/></svg>',
};

// ── Controlled badge library (Phase 2: safe defaults only) ──────────────────
const BADGE_LIBRARY = {
  secure_checkout:    { badgeId: 'secure_checkout',    label: 'Secure Checkout',     iconKey: 'lock',  riskLevel: 'low',    claimType: 'A', allowedInBeta: true, requiresMerchantApproval: false, requiredEvidence: 'shopify_checkout' },
  safe_payment:       { badgeId: 'safe_payment',       label: 'Safe Payment',        iconKey: 'card',  riskLevel: 'low',    claimType: 'A', allowedInBeta: true, requiresMerchantApproval: false, requiredEvidence: 'standard_checkout' },
  easy_help:          { badgeId: 'easy_help',          label: "We're Here to Help",  iconKey: 'chat',  riskLevel: 'low',    claimType: 'A', allowedInBeta: true, requiresMerchantApproval: false, requiredEvidence: 'generic_support' },
  quality_checked:    { badgeId: 'quality_checked',    label: 'Quality Checked',     iconKey: 'check', riskLevel: 'low',    claimType: 'A', allowedInBeta: true, requiresMerchantApproval: false, requiredEvidence: 'generic_curation' },
  carefully_selected: { badgeId: 'carefully_selected', label: 'Carefully Selected',  iconKey: 'star',  riskLevel: 'low',    claimType: 'A', allowedInBeta: true, requiresMerchantApproval: false, requiredEvidence: 'generic_curation' },
};

// Default 3-badge set (all Class A, no evidence/approval needed).
const BETA_DEFAULT_BADGE_IDS = ['secure_checkout', 'safe_payment', 'easy_help'];
// Concise alternate variant — still 3 safe defaults, swaps in a curation badge.
const BETA_VARIANT_BADGE_IDS = ['secure_checkout', 'easy_help', 'quality_checked'];

// Allowed visible labels (Phase 2). Used by the Safety Validator allowlist.
const ALLOWED_BETA_BADGE_LABELS = Object.values(BADGE_LIBRARY)
  .filter(b => b.allowedInBeta)
  .map(b => b.label);

// ---------------------------------------------------------------------------
// renderBadge / renderBadgeBlock — deterministic, inline-safe HTML.
// No <script>, no event handlers, no external assets, no <style> tag.
// Inline styles only, neutral, inherit theme font/color via currentColor.
// ---------------------------------------------------------------------------
function renderBadge(badge) {
  const icon = ICONS[badge.iconKey] || ICONS.check;
  return (
    '<span class="cro-trust-badge" ' +
    'style="display:inline-flex;align-items:center;gap:8px;padding:10px 14px;' +
    'border:1px solid rgba(127,127,127,0.25);border-radius:8px;font-size:14px;' +
    'line-height:1.2;white-space:nowrap;">' +
      '<span aria-hidden="true" style="display:inline-flex;flex-shrink:0;">' + icon + '</span>' +
      '<span>' + badge.label + '</span>' +
    '</span>'
  );
}

function renderBadgeBlock(badgeIds) {
  const badges = badgeIds
    .map(id => BADGE_LIBRARY[id])
    .filter(b => b && b.allowedInBeta)
    .slice(0, 4); // safety cap — never more than 4 badges
  const cards = badges.map(renderBadge).join('');
  return (
    '<div class="cro-trust-badges" data-cro-trust-badges="1" role="list" ' +
    'aria-label="Store trust signals" ' +
    'style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin:16px 0;">' +
    cards +
    '</div>'
  );
}

// ---------------------------------------------------------------------------
// generateTrustBadges — drop-in replacement for generateTrustBullets.
// product is accepted for signature compatibility but intentionally unused:
// Phase 2 badges are store-level safe defaults, never product/vendor-derived.
// ---------------------------------------------------------------------------
function generateTrustBadges(/* product */) {
  const full    = renderBadgeBlock(BETA_DEFAULT_BADGE_IDS);
  const concise = renderBadgeBlock(BETA_VARIANT_BADGE_IDS);
  return {
    bestGuess: { content: full },
    variants:  [{ content: full }, { content: concise }],
  };
}

// ---------------------------------------------------------------------------
// extractBadgeLabels — pull the visible label text from a rendered badge block.
// Matches <span>TEXT</span> where TEXT contains no markup (icon spans wrap an
// <svg>, so they are excluded). Used by the Safety Validator allowlist check.
// ---------------------------------------------------------------------------
function extractBadgeLabels(html) {
  const labels = [];
  const re = />([^<>]+)<\/span>/g;
  let m;
  while ((m = re.exec(html || '')) !== null) {
    const t = m[1].trim();
    if (t.length > 0) labels.push(t);
  }
  return labels;
}

module.exports = {
  BADGE_LIBRARY,
  BETA_DEFAULT_BADGE_IDS,
  ALLOWED_BETA_BADGE_LABELS,
  generateTrustBadges,
  renderBadgeBlock,
  extractBadgeLabels,
};
