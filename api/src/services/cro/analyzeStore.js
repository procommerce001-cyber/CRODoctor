'use strict';

// ---------------------------------------------------------------------------
// analyzeStore
//
// Takes an array of Prisma products (all with variants + images).
// Returns the standardized store-level CRO action plan.
//
// Output shape:
// {
//   shop, generatedAt,
//   storeScore: { score, label, description },
//   summary: { totalProducts, activeProducts, draftProducts, totalIssues,
//              criticalBlockers, quickWins, revenueOpportunities },
//   criticalBlockers: Issue[],
//   quickWins: Issue[],
//   revenueOpportunities: Issue[],
//   priorityProducts: PriorityProduct[],
//   systemPatterns: Pattern[],
//   missingData: MissingDataItem[],
//   nextBestActions: Action[]
// }
// ---------------------------------------------------------------------------

const { analyzeProduct }              = require('./analyzeProduct');
const { scoreStore }                  = require('./scoring');
const { STORE_MISSING_DATA, IMPACT }  = require('./constants');

// ---------------------------------------------------------------------------
// detectPatterns — cross-product observations worth surfacing
// ---------------------------------------------------------------------------
function detectPatterns(products, analysisMap) {
  const patterns = [];
  const active   = products.filter(p => p.status === 'active');
  const total    = products.length;

  // All active products OOS
  const oosActive = active.filter(p => p.variants.every(v => !v.availableForSale));
  if (active.length > 0 && oosActive.length === active.length) {
    patterns.push({
      id:      'all_active_products_oos',
      title:   '100% of active products are out of stock',
      impact:  'Store is generating $0 revenue right now. This is a systemic fulfillment issue, not a per-product problem.',
      urgency: 'critical',
    });
  } else if (oosActive.length > 0) {
    patterns.push({
      id:      'most_active_products_oos',
      title:   `${oosActive.length} of ${active.length} active products are out of stock`,
      impact:  `${Math.round((oosActive.length / active.length) * 100)}% of your active catalog cannot be purchased.`,
      urgency: 'high',
    });
  }

  // No guarantees anywhere
  const noGuarantee = products.filter(p => {
    const analysis = analysisMap.get(p.id);
    return analysis && analysis.criticalBlockers.concat(analysis.quickWins, analysis.revenueOpportunities)
      .some(i => i.issueId === 'no_risk_reversal');
  });
  if (noGuarantee.length === total) {
    patterns.push({
      id:      'no_guarantee_store_wide',
      title:   'Zero products have a return guarantee in their description',
      impact:  'Store-wide trust deficit. One global theme edit or batch description update fixes this across all products simultaneously.',
      urgency: 'high',
    });
  }

  // Alt text missing everywhere
  const noAlt = products.filter(p => p.images.length > 0 && p.images.every(i => !i.altText));
  if (noAlt.length === total && total > 0) {
    patterns.push({
      id:      'missing_alt_text_store_wide',
      title:   `All ${total} products have images with no alt text`,
      impact:  'Complete absence of image SEO. A single bulk-edit session in Shopify Admin fixes all products.',
      urgency: 'medium',
    });
  }

  // Multiple draft products with the same name
  const draftTitles = products
    .filter(p => p.status === 'draft')
    .map(p => p.title);
  const duplicateDrafts = draftTitles.filter((t, i) => draftTitles.indexOf(t) !== i);
  if (duplicateDrafts.length > 0) {
    const uniqueDupes = [...new Set(duplicateDrafts)];
    patterns.push({
      id:      'duplicate_draft_products',
      title:   `Duplicate draft products detected: "${uniqueDupes.join('", "')}"`,
      impact:  'Fragmented catalog. Multiple draft listings of the same product split reviews, AOV opportunities, and SEO authority. Consolidate into one product with variants.',
      urgency: 'high',
    });
  }

  // Center-aligned descriptions
  const centerAligned = products.filter(p => p.bodyHtml && p.bodyHtml.includes('text-align: center'));
  if (centerAligned.length > 1) {
    patterns.push({
      id:      'supplier_copy_detected',
      title:   `${centerAligned.length} products have center-aligned descriptions — unedited supplier copy`,
      impact:  'Systematic trust signal failure. A single CSS rule in the theme fixes all products without editing each description.',
      urgency: 'medium',
    });
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// buildNextBestActions — top 3 concrete actions ranked by ROI
// ---------------------------------------------------------------------------
function buildNextBestActions(criticalBlockers, quickWins, revenueOpportunities, systemPatterns) {
  const actions = [];

  // Always surface the all-active-OOS pattern if present
  const oosPattern = systemPatterns.find(p => p.id === 'all_active_products_oos' || p.id === 'most_active_products_oos');
  if (oosPattern) {
    actions.push({
      rank:          1,
      title:         'Enable back-in-stock email capture on all out-of-stock products',
      why:           'Revenue is $0 on these products. This converts current visitor intent into deferred revenue. Expected: 15–25% of captures convert on restock.',
      implementationType: 'APP_CONFIG',
      effort:        'low',
      revenueImpact: 'critical — unlocks deferred revenue from active traffic',
    });
  }

  // Surface the duplicate draft pattern if present
  const dupePattern = systemPatterns.find(p => p.id === 'duplicate_draft_products');
  if (dupePattern) {
    actions.push({
      rank:          actions.length + 1,
      title:         'Consolidate duplicate draft products into one product with variants',
      why:           'Fragmented listings split SEO, reviews, and AOV opportunities. One published product with clean variants opens a new revenue channel.',
      implementationType: 'MERCHANT_ACTION',
      effort:        'low',
      revenueImpact: 'high — opens brand hero product channel',
    });
  }

  // Guarantee is the highest-impact per-minute content fix
  const guaranteeIssue = revenueOpportunities.find(i => i.issueId === 'no_risk_reversal');
  if (guaranteeIssue && actions.length < 3) {
    actions.push({
      rank:          actions.length + 1,
      title:         'Add a 30-day guarantee line to every product description',
      why:           'Removes the single largest trust barrier for cold traffic. One line of copy per product. +10–20% CVR on cold traffic.',
      implementationType: 'CONTENT_CHANGE',
      effort:        'low',
      revenueImpact: 'high — affects conversion rate of all active products',
    });
  }

  // Strong discount not featured
  const discountIssue = revenueOpportunities.find(i => i.issueId === 'strong_discount_not_featured');
  if (discountIssue && actions.length < 3) {
    actions.push({
      rank:          actions.length + 1,
      title:         'Surface savings badge on all products with 20%+ discount',
      why:           'Strong offers already exist — they are just invisible. One theme edit surfaces them across the entire catalog.',
      implementationType: 'THEME_PATCH',
      effort:        'low',
      revenueImpact: 'medium-high — activates loss aversion on all discounted products',
    });
  }

  // Fallback: add top quick win if we have fewer than 3 actions
  if (actions.length < 3 && quickWins.length > 0) {
    const topWin = quickWins[0];
    actions.push({
      rank:          actions.length + 1,
      title:         topWin.title,
      why:           topWin.whyItMatters,
      implementationType: topWin.implementationType,
      effort:        topWin.effort,
      revenueImpact: topWin.impact.join(', '),
    });
  }

  return actions;
}

// ---------------------------------------------------------------------------
// analyzeStore — main export
// ---------------------------------------------------------------------------
function analyzeStore(shop, products) {
  const analysisMap = new Map();
  const scoredProducts = [];

  // Run per-product analysis
  for (const p of products) {
    const analysis = analyzeProduct(p);
    analysisMap.set(p.id, analysis);
    scoredProducts.push({
      ...analysis,
      // carry raw product fields needed for pattern detection
      _raw: p,
    });
  }

  // Aggregate issues across all products
  // De-duplicate at the issue level for the store summaries
  // (same issueId can appear on multiple products — keep all per-product instances
  //  in the lists, but track unique issue types for summary counts)
  const allCritical = scoredProducts.flatMap(p => p.criticalBlockers);
  const allQuickWins = scoredProducts.flatMap(p => p.quickWins);
  const allRevOpp = scoredProducts.flatMap(p => p.revenueOpportunities);

  // Priority products: sorted by score ascending (lowest = most needs work)
  const priorityProducts = [...scoredProducts]
    .sort((a, b) => a.optimizationScore - b.optimizationScore)
    .map(p => ({
      productId:         p.productId,
      title:             p.title,
      status:            p.status,
      optimizationScore: p.optimizationScore,
      scoreLabel:        p.scoreLabel,
      totalIssues:       p.totalIssues,
      criticalCount:     p.criticalCount,
      topIssues:         p.topIssues.slice(0, 3).map(i => ({
        issueId:    i.issueId,
        title:      i.title,
        severity:   i.severity,
        effort:     i.effort,
      })),
    }));

  const rawProducts = products; // for pattern detection
  const systemPatterns = detectPatterns(rawProducts, analysisMap);
  const storeScore     = scoreStore(scoredProducts.map(p => ({ status: p.status, optimizationScore: p.optimizationScore })));
  const nextBestActions = buildNextBestActions(allCritical, allQuickWins, allRevOpp, systemPatterns);

  return {
    shop,
    generatedAt: new Date().toISOString(),
    storeScore,
    summary: {
      totalProducts:        products.length,
      activeProducts:       products.filter(p => p.status === 'active').length,
      draftProducts:        products.filter(p => p.status === 'draft').length,
      totalIssues:          allCritical.length + allQuickWins.length + allRevOpp.length,
      criticalBlockers:     allCritical.length,
      quickWins:            allQuickWins.length,
      revenueOpportunities: allRevOpp.length,
    },
    criticalBlockers:     allCritical,
    quickWins:            allQuickWins,
    revenueOpportunities: allRevOpp,
    priorityProducts,
    systemPatterns,
    missingData:          STORE_MISSING_DATA,
    nextBestActions,
  };
}

module.exports = { analyzeStore };
