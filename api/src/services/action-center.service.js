'use strict';

// ---------------------------------------------------------------------------
// action-center.service.js
//
// Projection + persistence layer over the CRO engine.
// Responsibilities:
//   - Classify issues into actionable fix records
//   - Persist reviewer decisions (approve / reject / defer) via ActionItem model
//   - Merge stored review state into live engine output
//   - Group issues into store-level queue buckets
//   - Never write to Shopify. Never patch theme code.
// ---------------------------------------------------------------------------

const { analyzeProduct } = require('./cro/analyzeProduct');
const { toCroProduct }   = require('./cro/formatters');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected', 'deferred']);

const APPLY_TYPE_MAP = {
  CONTENT_CHANGE:  'content_change',
  THEME_PATCH:     'theme_change',
  APP_CONFIG:      'manual',
  MERCHANT_ACTION: 'manual',
};

// ---------------------------------------------------------------------------
// classifyFix — derive applyType, canAutoApply, humanReviewRequired
// ---------------------------------------------------------------------------
function classifyFix(issue) {
  const applyType = APPLY_TYPE_MAP[issue.implementationType] || 'manual';

  const hasGeneratedFix = !!(
    issue.generatedFix?.bestGuess?.content
  );

  // canAutoApply: content_change with a ready generated fix
  const canAutoApply = applyType === 'content_change' && hasGeneratedFix;

  // humanReviewRequired: always true until execution layer adds validation
  const humanReviewRequired = true;

  return { applyType, canAutoApply, humanReviewRequired };
}

// ---------------------------------------------------------------------------
// toActionItem — convert a CRO issue to an Action Center item
// reviewStatus defaults to 'pending'; caller merges persisted state over this.
// ---------------------------------------------------------------------------
function toActionItem(issue) {
  const { applyType, canAutoApply, humanReviewRequired } = classifyFix(issue);

  return {
    issueId:              issue.issueId,
    title:                issue.title,
    severity:             issue.severity,
    surface:              issue.surface  || 'pdp',
    category:             issue.category,
    effort:               issue.effort,
    scoreImpact:          issue.scoreImpact ?? null,
    evidence:             issue.evidence   || [],
    recommendedFix:       issue.recommendedFix  ?? null,
    generatedFix:         issue.generatedFix    ?? null,
    // default — overridden by mergeReviewState() if a DB record exists
    reviewStatus:         'pending',
    selectedVariantIndex: null,
    canAutoApply,
    applyType,
    humanReviewRequired,
  };
}

// ---------------------------------------------------------------------------
// isActionable — only issues with a fix path are surfaced in the Action Center
// ---------------------------------------------------------------------------
function isActionable(issue) {
  return !!(issue.generatedFix || issue.recommendedFix || issue.exactFix);
}

// ---------------------------------------------------------------------------
// mergeReviewState
// Overlays persisted DB records onto a list of action items.
// Items with no DB record keep reviewStatus: 'pending'.
//
// stateMap: Map<issueId, { reviewStatus, selectedVariantIndex }>
// ---------------------------------------------------------------------------
function mergeReviewState(actionItems, stateMap) {
  return actionItems.map(item => {
    const stored = stateMap.get(item.issueId);
    if (!stored) return item;
    return {
      ...item,
      reviewStatus:         stored.reviewStatus,
      selectedVariantIndex: stored.selectedVariantIndex ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// loadReviewStateMap
// Fetches all ActionItem rows for a given (storeId, productId) from DB.
// Returns a Map<issueId, ActionItem> for O(1) lookup during merge.
// ---------------------------------------------------------------------------
async function loadReviewStateMap(prisma, storeId, productId) {
  const rows = await prisma.actionItem.findMany({
    where: { storeId, productId },
    select: { issueId: true, reviewStatus: true, selectedVariantIndex: true },
  });

  return new Map(rows.map(r => [r.issueId, r]));
}

// ---------------------------------------------------------------------------
// saveReviewState
// Upserts one ActionItem row. Validates status before writing.
// Returns the persisted record (public-safe shape).
// ---------------------------------------------------------------------------
async function saveReviewState(prisma, { storeId, productId, issueId, reviewStatus, selectedVariantIndex }) {
  if (!VALID_REVIEW_STATUSES.has(reviewStatus)) {
    throw new Error(`Invalid reviewStatus "${reviewStatus}". Must be one of: ${[...VALID_REVIEW_STATUSES].join(', ')}`);
  }

  const record = await prisma.actionItem.upsert({
    where: {
      storeId_productId_issueId: { storeId, productId, issueId },
    },
    update: {
      reviewStatus,
      selectedVariantIndex: selectedVariantIndex ?? null,
    },
    create: {
      storeId,
      productId,
      issueId,
      reviewStatus,
      selectedVariantIndex: selectedVariantIndex ?? null,
    },
  });

  return {
    id:                  record.id,
    productId:           record.productId,
    issueId:             record.issueId,
    reviewStatus:        record.reviewStatus,
    selectedVariantIndex: record.selectedVariantIndex,
    updatedAt:           record.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// getProductActions
// Runs the CRO engine on one product + merges persisted review state.
// Requires prisma + storeId to load state; both are optional for backwards
// compat (callers that don't pass them get reviewStatus: 'pending' on all).
// ---------------------------------------------------------------------------
async function getProductActions(rawProduct, { prisma, storeId } = {}) {
  const croProduct = toCroProduct(rawProduct);
  const analysis   = analyzeProduct(croProduct);

  const allIssues = [
    ...analysis.criticalBlockers,
    ...analysis.revenueOpportunities,
    ...analysis.quickWins,
  ];

  // De-duplicate across buckets
  const seen = new Set();
  const deduped = allIssues.filter(i => {
    if (seen.has(i.issueId)) return false;
    seen.add(i.issueId);
    return true;
  });

  let actionableItems = deduped.filter(isActionable).map(toActionItem);

  // Sort: critical → high → medium → low, effort asc within severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const effortOrder   = { low: 0, medium: 1, high: 2 };
  actionableItems.sort((a, b) => {
    const sA = severityOrder[a.severity] ?? 9;
    const sB = severityOrder[b.severity] ?? 9;
    if (sA !== sB) return sA - sB;
    return (effortOrder[a.effort] ?? 9) - (effortOrder[b.effort] ?? 9);
  });

  // Merge persisted state if DB is available
  if (prisma && storeId) {
    const stateMap   = await loadReviewStateMap(prisma, storeId, rawProduct.id);
    actionableItems  = mergeReviewState(actionableItems, stateMap);
  }

  return {
    productId:         analysis.productId,
    shopifyProductId:  analysis.shopifyProductId,
    title:             analysis.title,
    status:            analysis.status,
    optimizationScore: analysis.optimizationScore,
    scoreLabel:        analysis.scoreLabel,
    summary:           analysis.summary,
    totalIssues:       analysis.totalIssues,
    actionableCount:   actionableItems.length,
    actions:           actionableItems,
    missingData:       analysis.missingData,
  };
}

// ---------------------------------------------------------------------------
// getReviewStateForProduct
// Returns the raw persisted state for a product — used by GET /review-state.
// Does NOT re-run the engine. Pure DB read.
// ---------------------------------------------------------------------------
async function getReviewStateForProduct(prisma, storeId, productId) {
  const rows = await prisma.actionItem.findMany({
    where:   { storeId, productId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true, issueId: true, reviewStatus: true,
      selectedVariantIndex: true, updatedAt: true,
    },
  });

  return {
    productId,
    storeId,
    items: rows,
    total: rows.length,
  };
}

// ---------------------------------------------------------------------------
// QUEUE BUCKET CLASSIFIERS
// ---------------------------------------------------------------------------

const QUEUE_BUCKETS = {
  highest_revenue_opportunities: item =>
    item.severity === 'critical' || item.severity === 'high',

  fastest_wins: item =>
    item.effort === 'low',

  content_changes_ready: item =>
    item.applyType === 'content_change' && item.canAutoApply,

  manual_only: item =>
    item.applyType === 'manual',

  theme_changes: item =>
    item.applyType === 'theme_change',
};

// ---------------------------------------------------------------------------
// getStoreQueue
// Runs engine across all products, merges review state, returns queue.
// ---------------------------------------------------------------------------
async function getStoreQueue(shop, rawProducts, { prisma, storeId } = {}) {
  const productResults = (
    await Promise.all(
      rawProducts.map(async p => {
        try {
          return await getProductActions(p, { prisma, storeId });
        } catch (_) {
          return null;
        }
      })
    )
  ).filter(Boolean);

  const allItems = productResults.flatMap(pr =>
    pr.actions.map(item => ({
      ...item,
      _productId:    pr.productId,
      _productTitle: pr.title,
      _productScore: pr.optimizationScore,
    }))
  );

  const buckets = {};
  for (const [key, filterFn] of Object.entries(QUEUE_BUCKETS)) {
    buckets[key] = allItems
      .filter(filterFn)
      .map(item => ({
        issueId:      item.issueId,
        title:        item.title,
        severity:     item.severity,
        effort:       item.effort,
        applyType:    item.applyType,
        canAutoApply: item.canAutoApply,
        scoreImpact:  item.scoreImpact,
        reviewStatus: item.reviewStatus,
        productId:    item._productId,
        productTitle: item._productTitle,
        productScore: item._productScore,
      }));
  }

  const totalPending   = allItems.filter(i => i.reviewStatus === 'pending').length;
  const autoApplicable = allItems.filter(i => i.canAutoApply).length;
  const requiresHuman  = allItems.filter(i => i.humanReviewRequired && !i.canAutoApply).length;

  return {
    shop,
    generatedAt: new Date().toISOString(),
    summary: {
      totalProducts:       rawProducts.length,
      totalPendingActions: totalPending,
      autoApplicable,
      requiresHumanReview: requiresHuman,
      byBucket: Object.fromEntries(
        Object.entries(buckets).map(([k, v]) => [k, v.length])
      ),
    },
    queue: buckets,
    productScores: productResults
      .map(pr => ({
        productId:         pr.productId,
        title:             pr.title,
        status:            pr.status,
        optimizationScore: pr.optimizationScore,
        scoreLabel:        pr.scoreLabel,
        actionableCount:   pr.actionableCount,
      }))
      .sort((a, b) => a.optimizationScore - b.optimizationScore),
  };
}

module.exports = {
  getProductActions,
  getStoreQueue,
  saveReviewState,
  getReviewStateForProduct,
};
