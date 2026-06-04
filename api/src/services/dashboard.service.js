'use strict';

// ---------------------------------------------------------------------------
// dashboard.service.js
//
// Composition layer for the main dashboard screen.
// Does NOT contain business logic — delegates entirely to existing services.
// ---------------------------------------------------------------------------

const { getProductActions, listProductRecommendations } = require('./action-center.service');
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
        action.proposedContent !== null             &&
        !action.priorContentPresent;

      let reason = null;
      if (!eligible) {
        if (action.applyType !== 'content_change')   reason = 'not a content_change action';
        else if (!action.canAutoApply)               reason = 'canAutoApply is false';
        else if (action.riskLevel !== 'low')         reason = `riskLevel is ${action.riskLevel}`;
        else if (action.reviewStatus !== 'approved') reason = `reviewStatus is ${action.reviewStatus}`;
        else if (action.priorContentPresent)         reason = `prior ${action.issueId} content still present in page — cleanup required before re-applying`;
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
    prisma.contentExecution.count({ where: { storeId: store.id, status: 'applied' } }).catch(() => 0),
    prisma.contentExecution.count({ where: { storeId: store.id, status: 'applied', afterReadyAt: { gt: new Date() } } }).catch(() => 0),
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

// ---------------------------------------------------------------------------
// getDashboardRecommendationsPayload
//
// Lightweight, LLM-FREE discovery list for "View more recommendations".
// Loads ALL recommendations across the catalog using listProductRecommendations
// (rule detection + review-state only — no content generation), so it returns
// quickly where the full review-selection path times out. Read-only.
//
// Returns recommendations grouped by status the UI can render directly:
//   ready_to_apply | needs_review | manual_setup | measuring | blocked
// Content is NOT generated here — it is fetched lazily via content-preview when
// the merchant clicks Preview/Review. Apply/Rollback behaviour is unchanged.
// ---------------------------------------------------------------------------
const RECOMMENDATIONS_TTL_MS = 5_000;
const _recCache = new Map(); // Map<shop, { payload, expiresAt }>

async function getDashboardRecommendationsPayload(prisma, shop) {
  const cached = _recCache.get(shop);
  if (cached && Date.now() <= cached.expiresAt) return cached.payload;

  const store = await prisma.store.findUnique({ where: { shopDomain: shop }, select: { id: true } });
  if (!store) return { success: false, reason: 'store not found' };

  const rawProducts = await prisma.product.findMany({
    where:   { storeId: store.id },
    orderBy: { createdAt: 'desc' },
    take:    100,
    include: PRODUCT_INCLUDE,
  });

  const productIds  = rawProducts.map(p => p.id);
  const appliedRows = productIds.length
    ? await prisma.contentExecution.findMany({
        where:  { productId: { in: productIds }, status: 'applied' },
        select: { id: true, productId: true, issueId: true, previousContent: true, afterReadyAt: true },
      })
    : [];
  // Map (productId:issueId) → the active applied execution (one per pair via the
  // partial unique index). Carries the executionId + rollback inputs the UI needs.
  const appliedByKey = new Map(appliedRows.map(r => [`${r.productId}:${r.issueId}`, r]));
  const appliedSet   = new Set(appliedByKey.keys());

  // Set of applied execution ids that already have a rolled_back row referencing
  // them — those are no longer reversible. One read-only query, no LLM.
  const reversedRows = appliedRows.length
    ? await prisma.contentExecution.findMany({
        where:  { status: 'rolled_back', referenceExecutionId: { in: appliedRows.map(r => r.id) } },
        select: { referenceExecutionId: true },
      })
    : [];
  const reversedSet = new Set(reversedRows.map(r => r.referenceExecutionId));

  const items = [];
  for (const raw of rawProducts) {
    let result;
    try {
      result = await listProductRecommendations(raw, { prisma, storeId: store.id });
    } catch (_) {
      continue; // non-fatal: skip a product that fails to analyze
    }

    for (const action of result.actions) {
      const appliedExec  = appliedByKey.get(`${raw.id}:${action.issueId}`) ?? null;
      const applied      = appliedSet.has(`${raw.id}:${action.issueId}`);
      const manualSetup  = action.applyType !== 'content_change';
      const previewable  = action.canAutoApply === true && !manualSetup;
      const selectable   =
        previewable &&
        action.riskLevel    === 'low' &&
        action.reviewStatus === 'approved' &&
        !applied;

      let status;
      let reason = null;
      if (applied)            { status = 'measuring'; }
      else if (manualSetup)   { status = 'manual_setup';  reason = 'Manual setup — open the product to configure.'; }
      else if (selectable)    { status = 'ready_to_apply'; }
      else if (previewable)   { status = 'needs_review';  reason = action.reviewStatus !== 'approved' ? 'Preview and review before applying.' : null; }
      else                    { status = 'blocked';       reason = action.canAutoApply ? `riskLevel is ${action.riskLevel}` : 'Confidence too low for one-click apply.'; }

      // Rollback metadata — only meaningful for measuring (applied) content_change
      // rows. rollbackAvailable mirrors the main feed's Undo affordance: an active
      // applied execution that has not already been rolled back. The rollback
      // endpoint still enforces the full safety guard at click time.
      const executionId      = appliedExec ? appliedExec.id : null;
      const rollbackAvailable =
        status === 'measuring' &&
        !manualSetup &&
        !!executionId &&
        !reversedSet.has(executionId);

      items.push({
        productId:        raw.id,
        productTitle:     result.title ?? raw.title ?? null,
        issueId:          action.issueId,
        title:            action.title ?? action.issueId,
        category:         action.category ?? null,
        severity:         action.severity ?? null,
        score:            action.scoreImpact ?? null,
        applyType:        action.applyType ?? null,
        canAutoApply:     action.canAutoApply === true,
        riskLevel:        action.riskLevel ?? null,
        reviewStatus:     action.reviewStatus ?? 'pending',
        manualSetup,
        previewable,
        selectable,
        status,
        reason,
        executionId,
        afterReadyAt:     appliedExec && appliedExec.afterReadyAt ? appliedExec.afterReadyAt.toISOString() : null,
        rollbackAvailable,
      });
    }
  }

  // Stable order: ready first, then needs_review, manual, measuring, blocked;
  // within each, by severity then score.
  const statusOrder = { ready_to_apply: 0, needs_review: 1, manual_setup: 2, measuring: 3, blocked: 4 };
  const sevOrder    = { critical: 0, high: 1, medium: 2, low: 3 };
  items.sort((a, b) => {
    const so = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
    if (so !== 0) return so;
    const sv = (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9);
    if (sv !== 0) return sv;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  const payload = {
    success:  true,
    shop,
    summary: {
      total:        items.length,
      readyToApply: items.filter(i => i.status === 'ready_to_apply').length,
      needsReview:  items.filter(i => i.status === 'needs_review').length,
      manualSetup:  items.filter(i => i.status === 'manual_setup').length,
      measuring:    items.filter(i => i.status === 'measuring').length,
      blocked:      items.filter(i => i.status === 'blocked').length,
    },
    items,
  };

  _recCache.set(shop, { payload, expiresAt: Date.now() + RECOMMENDATIONS_TTL_MS });
  return payload;
}

module.exports = { getDashboardSelectionPayload, getDashboardRecommendationsPayload };
