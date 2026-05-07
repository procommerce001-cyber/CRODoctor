'use strict';

// ---------------------------------------------------------------------------
// dashboard.service.js
//
// Composition layer for the main dashboard screen.
// Does NOT contain business logic — delegates entirely to existing services.
// ---------------------------------------------------------------------------

const { getProductActions }  = require('./action-center.service');
const { getStoreResultsSummary, getStoreExecutionFeed } = require('./metrics.service');
const { PRODUCT_INCLUDE }    = require('../lib/product-include');

// ---------------------------------------------------------------------------
// Simple in-memory cache — key: shop, TTL: 5 seconds
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5_000;
const _cache       = new Map(); // Map<shop, { payload, expiresAt }>

function getCached(shop) {
  const entry = _cache.get(shop);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.payload;
}

function setCached(shop, payload) {
  _cache.set(shop, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// withTimeout — resolves promise or returns fallback after ms
// ---------------------------------------------------------------------------
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

// ---------------------------------------------------------------------------
// Empty fallback structures
// ---------------------------------------------------------------------------
const EMPTY_REVIEW = {
  summary: {
    requestedProductCount: 0,
    actionCount:           0,
    readyToApplyCount:     0,
    alreadyAppliedCount:   0,
    blockedCount:          0,
  },
  filters: {
    severity:     ['critical', 'high', 'medium', 'low'],
    riskLevel:    ['low', 'medium', 'high'],
    reviewStatus: ['approved', 'pending', 'rejected'],
  },
  groups: { readyToApply: [], alreadyApplied: [], blocked: [] },
};

const EMPTY_OVERVIEW = {
  overview:       { totalAppliedExecutions: 0, measuredExecutions: 0, waitingExecutions: 0, revenueUpCount: 0, revenueDownCount: 0, unitsSoldUpCount: 0, ordersUpCount: 0 },
  topWins:        [],
  recentActivity: [],
};

// ---------------------------------------------------------------------------
// Sorting helper
// ---------------------------------------------------------------------------
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function sortItems(items) {
  return items.sort((a, b) => {
    const scoreDiff = (a.score ?? 0) - (b.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
  });
}

// ---------------------------------------------------------------------------
// getReviewSelectionPayload
//
// Extracts the review-summary grouping logic so it can be reused outside the
// action-center route. Identical behaviour to GET /action-center/review-summary.
// ---------------------------------------------------------------------------
async function getReviewSelectionPayload(prisma, storeId) {
  const rawProducts = await prisma.product.findMany({
    where:   { storeId },
    orderBy: { createdAt: 'desc' },
    take:    50,
    include: PRODUCT_INCLUDE,
  });

  const productIds  = rawProducts.map(p => p.id);
  const appliedRows = await prisma.contentExecution.findMany({
    where:  { productId: { in: productIds }, status: 'applied' },
    select: { productId: true, issueId: true },
  });
  const appliedSet = new Set(appliedRows.map(r => `${r.productId}:${r.issueId}`));

  const readyToApply   = [];
  const alreadyApplied = [];
  const blocked        = [];

  for (const raw of rawProducts) {
    const actionResult = await getProductActions(raw, { prisma, storeId });

    for (const action of actionResult.actions) {
      const eligible =
        action.applyType       === 'content_change' &&
        action.canAutoApply    === true             &&
        action.riskLevel       === 'low'            &&
        action.reviewStatus    === 'approved'       &&
        action.proposedContent !== null;

      let reason = null;
      if (!eligible) {
        if (action.applyType !== 'content_change')   reason = 'not a content_change action';
        else if (!action.canAutoApply)               reason = 'canAutoApply is false';
        else if (action.riskLevel !== 'low')         reason = `riskLevel is ${action.riskLevel}`;
        else if (action.reviewStatus !== 'approved') reason = `reviewStatus is ${action.reviewStatus}`;
        else                                         reason = 'no proposedContent';
      }

      const wasApplied   = appliedSet.has(`${raw.id}:${action.issueId}`);
      const inReadyGroup = eligible && !wasApplied;

      const item = {
        productId:     raw.id,
        productTitle:  raw.title ?? null,
        issueId:       action.issueId,
        title:         action.title,
        selectionKey:  `${raw.id}::${action.issueId}`,
        selectable:    inReadyGroup,
        severity:      action.severity,
        score:         action.scoreImpact,
        riskLevel:     action.riskLevel,
        reviewStatus:  action.reviewStatus,
        eligible:      inReadyGroup,
        canAutoApply:  action.canAutoApply,
        wouldApply:    inReadyGroup,
        reason:        wasApplied ? 'already applied' : reason,
        executionType: action.executionType,
        applyType:     action.applyType,
      };

      if (wasApplied)        alreadyApplied.push(item);
      else if (inReadyGroup) readyToApply.push(item);
      else                   blocked.push(item);
    }
  }

  sortItems(readyToApply);
  sortItems(alreadyApplied);
  sortItems(blocked);

  return {
    summary: {
      requestedProductCount: rawProducts.length,
      actionCount:           readyToApply.length + alreadyApplied.length + blocked.length,
      readyToApplyCount:     readyToApply.length,
      alreadyAppliedCount:   alreadyApplied.length,
      blockedCount:          blocked.length,
    },
    filters: {
      severity:     ['critical', 'high', 'medium', 'low'],
      riskLevel:    ['low', 'medium', 'high'],
      reviewStatus: ['approved', 'pending', 'rejected'],
    },
    groups: { readyToApply, alreadyApplied, blocked },
  };
}

// ---------------------------------------------------------------------------
// getDashboardSelectionPayload
//
// Single payload for the main dashboard screen.
// Composes store overview (metrics) + review selection groups in parallel.
// Cached per shop for 5 seconds. Times out after 2 seconds per branch with
// safe empty fallbacks — never throws to the caller.
// ---------------------------------------------------------------------------
async function getDashboardSelectionPayload(prisma, shop) {
  // 1. Cache check
  const cached = getCached(shop);
  if (cached) return cached;

  // 2. Store lookup
  const store = await prisma.store.findUnique({
    where:  { shopDomain: shop },
    select: { id: true },
  });
  if (!store) return { success: false, reason: 'store not found' };

  // 3. Parallel fetch with per-branch timeouts + safe fallbacks.
  //    Two fast count queries run alongside the expensive enriched calls so that
  //    totalAppliedExecutions and waitingExecutions are never incorrectly zero
  //    even when the enriched summary times out.
  const [summaryResult, feedResult, review, appliedCount, waitingCount] = await Promise.all([
    withTimeout(
      getStoreResultsSummary(prisma, shop).catch(() => null),
      8000,
      null
    ),
    withTimeout(
      getStoreExecutionFeed(prisma, shop).catch(() => null),
      8000,
      null
    ),
    withTimeout(
      getReviewSelectionPayload(prisma, store.id).catch(() => EMPTY_REVIEW),
      8000,
      EMPTY_REVIEW
    ),
    prisma.contentExecution.count({ where: { storeId: store.id, status: 'applied' } }),
    prisma.contentExecution.count({ where: { storeId: store.id, status: 'applied', afterReadyAt: { gt: new Date() } } }),
  ]);

  const baseOverview = summaryResult?.summary ?? EMPTY_OVERVIEW.overview;
  const overview = {
    ...baseOverview,
    totalAppliedExecutions: Math.max(baseOverview.totalAppliedExecutions, appliedCount),
    waitingExecutions:      Math.max(baseOverview.waitingExecutions,      waitingCount),
  };

  const payload = {
    success:        true,
    shop,
    overview,
    review,
    topWins:        summaryResult?.topWins?.slice(0, 5) ?? [],
    recentActivity: (feedResult?.items ?? []).slice(0, 10),
  };

  // 4. Cache the fresh payload
  setCached(shop, payload);

  return payload;
}

module.exports = { getDashboardSelectionPayload };
