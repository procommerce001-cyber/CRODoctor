'use strict';

// ---------------------------------------------------------------------------
// Generator: Trust Badges Below Add-to-Cart
//
// Creates two files:
//   snippets/cro-trust-badges.liquid   — the badge row HTML
//   assets/cro-trust-badges.css        — scoped styles
//
// Then finds the injection point in the product section and inserts:
//   {% render 'cro-trust-badges' %}
//
// Injection strategy (ordered by precedence):
//   1. After {% endform %} inside a product section
//   2. After </form> in the product template
//   3. After .product-form__buttons (Dawn-specific)
// ---------------------------------------------------------------------------

const SNIPPET_KEY = 'snippets/cro-trust-badges.liquid';
const CSS_KEY     = 'assets/cro-trust-badges.css';

// Candidate product section keys, checked in order
const SECTION_CANDIDATES = [
  'sections/main-product.liquid',     // Dawn, Sense, Craft, Refresh
  'sections/product-template.liquid', // Debut, Brooklyn
  'templates/product.liquid',         // older/custom themes
];

// ---------------------------------------------------------------------------
// generateSnippet — the Liquid badge row
// ---------------------------------------------------------------------------
function generateSnippet(badges) {
  const defaultBadges = badges || [
    { icon: 'shield',   label: '30-Day Returns',   sub: 'No questions asked'  },
    { icon: 'truck',    label: 'Fast Dispatch',     sub: 'Orders dispatched daily' },
    { icon: 'lock',     label: 'Secure Checkout',   sub: '256-bit encrypted'  },
  ];

  const svgMap = {
    shield: `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    truck:  `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>`,
    lock:   `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  };

  const badgeHtml = defaultBadges.map(b => `
    <div class="cro-trust-badge">
      <div class="cro-trust-badge__icon">${svgMap[b.icon] || svgMap.shield}</div>
      <div class="cro-trust-badge__text">
        <span class="cro-trust-badge__label">${b.label}</span>
        <span class="cro-trust-badge__sub">${b.sub}</span>
      </div>
    </div>`).join('');

  return `{%- comment -%} CRODoctor: Trust Badges — do not edit manually {%- endcomment -%}
{{ 'cro-trust-badges.css' | asset_url | stylesheet_tag }}
<div class="cro-trust-badges" role="list" aria-label="Purchase guarantees">
${badgeHtml}
</div>`;
}

// ---------------------------------------------------------------------------
// generateCSS — scoped styles, no global overrides
// ---------------------------------------------------------------------------
function generateCSS() {
  return `/* CRODoctor: Trust Badges */
.cro-trust-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
  padding: 16px 0 8px;
  border-top: 1px solid rgba(0,0,0,0.08);
  margin-top: 8px;
  justify-content: center;
}
.cro-trust-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 130px;
  flex: 1 1 130px;
  max-width: 160px;
}
.cro-trust-badge__icon {
  flex-shrink: 0;
  color: #4a4a4a;
  opacity: 0.75;
}
.cro-trust-badge__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.cro-trust-badge__label {
  font-size: 12px;
  font-weight: 600;
  color: #1a1a1a;
  line-height: 1.2;
}
.cro-trust-badge__sub {
  font-size: 11px;
  color: #777;
  line-height: 1.2;
}
@media (max-width: 480px) {
  .cro-trust-badges {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
  .cro-trust-badge {
    max-width: 100%;
  }
}`;
}

// ---------------------------------------------------------------------------
// findInjectionPoint — locate where to insert the snippet render tag
// Returns { found, insertAfter: string | null, strategy: string }
// ---------------------------------------------------------------------------
function findInjectionPoint(liquidContent) {
  const strategies = [
    {
      name: 'after_endform',
      // {% endform %} or {%- endform -%} or {%- endform %}
      pattern: /(\{%-?\s*endform\s*-?%\})/,
    },
    {
      name: 'after_closing_form_tag',
      pattern: /(<\/form>)/i,
    },
    {
      name: 'after_product_form_buttons',
      // Dawn/Sense: <div class="product-form__buttons">...</div>
      pattern: /(class="[^"]*product-form__buttons[^"]*"[\s\S]*?<\/div>)/,
    },
    {
      name: 'after_buy_buttons',
      pattern: /(class="[^"]*product__buy-buttons[^"]*"[\s\S]*?<\/div>)/,
    },
  ];

  for (const s of strategies) {
    const match = liquidContent.match(s.pattern);
    if (match) {
      return {
        found: true,
        strategy: s.name,
        matchedText: match[0],
        // We'll insert AFTER this matched text
        insertAfterText: match[0],
      };
    }
  }

  return { found: false, strategy: null };
}

// ---------------------------------------------------------------------------
// patchSectionContent — insert the render tag at the injection point
// ---------------------------------------------------------------------------
function patchSectionContent(originalContent, injectionResult) {
  if (!injectionResult.found) return null;

  const renderTag = "\n{% render 'cro-trust-badges' %}\n";
  const insertAfter = injectionResult.insertAfterText;

  // Only inject once — check if already present
  if (originalContent.includes("render 'cro-trust-badges'")) {
    return { content: originalContent, alreadyPatched: true };
  }

  // Replace the FIRST occurrence of the injection point
  const patched = originalContent.replace(insertAfter, insertAfter + renderTag);
  return { content: patched, alreadyPatched: false };
}

// ---------------------------------------------------------------------------
// generate — main entry point called by the pipeline
// Returns a patch descriptor: { files: [...], sectionKey, injectionStrategy }
// ---------------------------------------------------------------------------
async function generate(store, shopifyAdminService, options = {}) {
  const { getAsset, listAssets } = shopifyAdminService;
  const badges = options.badges || null;

  // Find which section file exists in this theme
  const assetList = await listAssets(store, options.draftThemeId);
  const assetKeys = new Set(assetList.map(a => a.key));

  let targetSectionKey = null;
  let originalSectionContent = null;

  for (const candidate of SECTION_CANDIDATES) {
    if (assetKeys.has(candidate)) {
      const asset = await getAsset(store, options.draftThemeId, candidate);
      targetSectionKey = candidate;
      originalSectionContent = asset.value;
      break;
    }
  }

  if (!targetSectionKey) {
    return {
      success: false,
      error: 'Could not find a product section file. Theme structure is non-standard.',
      supportedSections: SECTION_CANDIDATES,
    };
  }

  const injection = findInjectionPoint(originalSectionContent);
  if (!injection.found) {
    return {
      success: false,
      error: `Could not find ATC form injection point in ${targetSectionKey}. Manual placement required.`,
      targetSection: targetSectionKey,
      strategy: 'manual_required',
    };
  }

  const patchResult = patchSectionContent(originalSectionContent, injection);

  return {
    success: true,
    sectionKey: targetSectionKey,
    injectionStrategy: injection.strategy,
    alreadyPatched: patchResult.alreadyPatched,
    files: [
      {
        key: SNIPPET_KEY,
        value: generateSnippet(badges),
        action: 'create',
      },
      {
        key: CSS_KEY,
        value: generateCSS(),
        action: 'create',
      },
      {
        key: targetSectionKey,
        value: patchResult.content,
        action: 'modify',
        originalContent: originalSectionContent,
      },
    ],
    // Keys to snapshot before applying
    snapshotKeys: [SNIPPET_KEY, CSS_KEY, targetSectionKey],
  };
}

module.exports = { generate, generateSnippet, generateCSS, findInjectionPoint };
