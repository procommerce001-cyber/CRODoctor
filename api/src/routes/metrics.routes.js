'use strict';

const express = require('express');
const router  = express.Router();

const { analyzeExecutionOutcome, getStoreCROSuggestions, captureProductMetricsSnapshot, compareProductMetrics, captureExecutionSnapshots, compareExecutionMetrics, getExecutionResultsSummary, getStoreResultsSummary, getStoreExecutionFeed, getStoreOverview } = require('../services/metrics.service');
const { resolveStore }      = require('../lib/resolve-store');
const { getProductActions } = require('../services/action-center.service');
const { PRODUCT_INCLUDE }   = require('../lib/product-include');

// ---------------------------------------------------------------------------
// SHARED HELPER — buildCandidateCountsForStore
//
// Fetches products + applied executions for a store ONCE, runs getProductActions
// once per product, and returns per-issueId candidate counts for all issueIds.
// Reused by both the /candidates route and getStoreSuggestionsWithStatus.
// ---------------------------------------------------------------------------
const ELIGIBLE = a =>
  a.applyType      === 'content_change' &&
  a.canAutoApply   === true             &&
  a.riskLevel      === 'low'            &&
  a.reviewStatus   === 'approved'       &&
  a.proposedContent != null;

async function buildCandidateCountsForStore(prisma, store, issueIds) {
  const rawProducts = await prisma.product.findMany({
    where:   { storeId: store.id },
    orderBy: { createdAt: 'desc' },
    take:    50,
    include: PRODUCT_INCLUDE,
  });

  const productIds  = rawProducts.map(p => p.id);
  const appliedRows = await prisma.contentExecution.findMany({
    where:  { productId: { in: productIds }, issueId: { in: issueIds }, status: 'applied' },
    select: { productId: true, issueId: true },
  });
  const appliedSet = new Set(appliedRows.map(r => `${r.productId}:${r.issueId}`));

  // Initialise counts per issueId
  const counts = {};
  for (const id of issueIds) counts[id] = { readyToApply: 0, alreadyApplied: 0, blocked: 0 };

  for (const raw of rawProducts) {
    const actionResult = await getProductActions(raw, { prisma, storeId: store.id });
    for (const issueId of issueIds) {
      const action = actionResult.actions.find(a => a.issueId === issueId);
      if (!action) continue;
      const wasApplied = appliedSet.has(`${raw.id}:${issueId}`);
      const inReady    = ELIGIBLE(action) && !wasApplied;
      if (wasApplied)   counts[issueId].alreadyApplied++;
      else if (inReady) counts[issueId].readyToApply++;
      else              counts[issueId].blocked++;
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// deriveSuggestionStatus — pure function, rules only
// ---------------------------------------------------------------------------
function deriveSuggestionStatus({ readyToApply, alreadyApplied, blocked }) {
  const total = readyToApply + alreadyApplied + blocked;
  if (total === 0)                                          return 'NO_CANDIDATES';
  if (readyToApply === 0 && alreadyApplied === 0)           return 'BLOCKED';
  if (readyToApply === 0 && alreadyApplied > 0)             return 'FULLY_APPLIED';
  if (readyToApply > 0   && alreadyApplied === 0)           return 'OPEN';
  return 'PARTIALLY_APPLIED';
}

// ---------------------------------------------------------------------------
// getStoreSuggestionsWithStatus — enriches each suggestion with live candidate
// counts and a deterministic operational status.
// ---------------------------------------------------------------------------
async function getStoreSuggestionsWithStatus(prisma, shop) {
  const store = await prisma.store.findUnique({ where: { shopDomain: shop }, select: { id: true } });
  if (!store) return { success: false, reason: 'store not found' };

  const base = await getStoreCROSuggestions(prisma, shop);
  if (!base.success) return base;

  const issueIds = base.suggestions.map(s => s.issueId);
  if (!issueIds.length) return { ...base, suggestions: [] };

  const counts = await buildCandidateCountsForStore(prisma, store, issueIds);

  const suggestions = base.suggestions.map(s => {
    const c = counts[s.issueId] ?? { readyToApply: 0, alreadyApplied: 0, blocked: 0 };
    return {
      ...s,
      candidateSummary: {
        candidateCount:      c.readyToApply + c.alreadyApplied + c.blocked,
        readyToApplyCount:   c.readyToApply,
        alreadyAppliedCount: c.alreadyApplied,
        blockedCount:        c.blocked,
      },
      status: deriveSuggestionStatus(c),
    };
  });

  return { ...base, suggestions };
}

// ---------------------------------------------------------------------------
// POST /metrics/products/:id/snapshot
// Captures a metrics snapshot for one product right now.
//
// Body: { shop: string }
// ---------------------------------------------------------------------------
router.post('/products/:id/snapshot', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const { shop } = req.body;

    if (!shop) return res.status(400).json({ error: 'shop is required' });

    const store = await resolveStore(prisma, shop, res);
    if (!store) return;

    // Confirm product belongs to this store
    const product = await prisma.product.findFirst({
      where:  { id: req.params.id, storeId: store.id },
      select: { id: true },
    });
    if (!product) return res.status(404).json({ error: 'Product not found in this store.' });

    const snapshot = await captureProductMetricsSnapshot(prisma, req.params.id);

    res.json({
      success:   true,
      productId: req.params.id,
      snapshot: {
        orderCount:               snapshot.orderCount,
        unitsSold:                snapshot.unitsSold,
        revenue:                  parseFloat(snapshot.revenue),
        latestAppliedExecutionId: snapshot.latestAppliedExecutionId,
      },
    });
  } catch (err) {
    console.error('[Metrics] POST /products/:id/snapshot error:', err.message);
    res.status(500).json({ error: 'Internal error capturing metrics snapshot.' });
  }
});

// ---------------------------------------------------------------------------
// GET /metrics/products/:id/compare?shop=
// Returns before/after diff from the last 2 snapshots for a product.
// ---------------------------------------------------------------------------
router.get('/products/:id/compare', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    const product = await prisma.product.findFirst({
      where:  { id: req.params.id, storeId: store.id },
      select: { id: true },
    });
    if (!product) return res.status(404).json({ error: 'Product not found in this store.' });

    const result = await compareProductMetrics(prisma, req.params.id);

    if (!result.success) {
      return res.status(422).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('[Metrics] GET /products/:id/compare error:', err.message);
    res.status(500).json({ error: 'Internal error comparing product metrics.' });
  }
});

// ---------------------------------------------------------------------------
// POST /metrics/products/:id/execution-snapshot
// Captures a metrics snapshot linked to a specific ContentExecution.
//
// Body: { shop: string, executionId: string }
// ---------------------------------------------------------------------------
router.post('/products/:id/execution-snapshot', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const { shop, executionId } = req.body;

    if (!shop)        return res.status(400).json({ error: 'shop is required' });
    if (!executionId) return res.status(400).json({ error: 'executionId is required' });

    const store = await resolveStore(prisma, shop, res);
    if (!store) return;

    const product = await prisma.product.findFirst({
      where:  { id: req.params.id, storeId: store.id },
      select: { id: true },
    });
    if (!product) return res.status(404).json({ error: 'Product not found in this store.' });

    const snapshot = await captureExecutionSnapshots(prisma, req.params.id, executionId);

    res.json({
      success:   true,
      productId: req.params.id,
      snapshot: {
        orderCount:               snapshot.orderCount,
        unitsSold:                snapshot.unitsSold,
        revenue:                  parseFloat(snapshot.revenue),
        latestAppliedExecutionId: snapshot.latestAppliedExecutionId,
        baselineExecutionId:      snapshot.baselineExecutionId,
      },
    });
  } catch (err) {
    console.error('[Metrics] POST /products/:id/execution-snapshot error:', err.message);
    res.status(500).json({ error: 'Internal error capturing execution snapshot.' });
  }
});

// ---------------------------------------------------------------------------
// GET /metrics/executions/:id/compare?shop=
// Compares the first 2 snapshots linked to a specific ContentExecution.
// ---------------------------------------------------------------------------
router.get('/executions/:id/compare', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    const result = await compareExecutionMetrics(prisma, req.params.id);

    if (!result.success) {
      return res.status(422).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('[Metrics] GET /executions/:id/compare error:', err.message);
    res.status(500).json({ error: 'Internal error comparing execution metrics.' });
  }
});

// ---------------------------------------------------------------------------
// GET /metrics/executions/:id/results?shop=
// Business-facing results summary for one ContentExecution.
// Returns "waiting_for_more_data" if fewer than 2 linked snapshots exist.
// ---------------------------------------------------------------------------
router.get('/executions/:id/results', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    // Confirm execution belongs to this store
    const execution = await prisma.contentExecution.findFirst({
      where:  { id: req.params.id, storeId: store.id },
      select: { id: true },
    });
    if (!execution) return res.status(404).json({ error: 'Execution not found in this store.' });

    const result = await getExecutionResultsSummary(prisma, req.params.id);

    if (!result.success) {
      return res.status(404).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('[Metrics] GET /executions/:id/results error:', err.message);
    res.status(500).json({ error: 'Internal error fetching execution results.' });
  }
});

// ---------------------------------------------------------------------------
// GET /metrics/executions/:id/analyze?shop=
// Rule-based CRO outcome analysis for one ContentExecution.
// ---------------------------------------------------------------------------
router.get('/executions/:id/analyze', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    const execution = await prisma.contentExecution.findFirst({
      where:  { id: req.params.id, storeId: store.id },
      select: { id: true },
    });
    if (!execution) return res.status(404).json({ error: 'Execution not found in this store.' });

    const result = await analyzeExecutionOutcome(prisma, req.params.id);
    res.json(result);
  } catch (err) {
    console.error('[Metrics] GET /executions/:id/analyze error:', err.message);
    res.status(500).json({ error: 'Internal error analyzing execution outcome.' });
  }
});

// ---------------------------------------------------------------------------
// GET /metrics/executions/:id/details?shop=
// Full inspection payload for one ContentExecution.
// Combines execution record fields with the results summary.
// ---------------------------------------------------------------------------
router.get('/executions/:id/details', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    const execution = await prisma.contentExecution.findFirst({
      where:  { id: req.params.id, storeId: store.id },
      select: {
        id: true, productId: true, issueId: true, status: true,
        createdAt: true, previousContent: true, newContent: true,
      },
    });
    if (!execution) return res.status(404).json({ error: 'Execution not found in this store.' });

    const result = await getExecutionResultsSummary(prisma, req.params.id);

    res.json({
      success:         true,
      executionId:     execution.id,
      productId:       execution.productId,
      issueId:         execution.issueId,
      status:          execution.status,
      createdAt:       execution.createdAt,
      previousContent: execution.previousContent,
      appliedContent:  execution.newContent,
      resultStatus:    result.success ? result.status  : null,
      insight:         result.success ? result.insight : null,
      summary:         result.success ? result.summary : null,
    });
  } catch (err) {
    console.error('[Metrics] GET /executions/:id/details error:', err.message);
    res.status(500).json({ error: 'Internal error fetching execution details.' });
  }
});

// ---------------------------------------------------------------------------
// GET /metrics/store/feed?shop=
// Dashboard feed of 20 most recent executions with enriched result metrics.
// ---------------------------------------------------------------------------
router.get('/store/feed', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    if (!req.query.shop) return res.status(400).json({ error: 'shop is required' });

    const result = await getStoreExecutionFeed(prisma, req.query.shop);

    if (!result.success) return res.status(404).json(result);

    res.json(result);
  } catch (err) {
    console.error('[Metrics] GET /store/feed error:', err.message);
    res.status(500).json({ error: 'Internal error fetching store feed.' });
  }
});

// ---------------------------------------------------------------------------
// GET /metrics/store/results?shop=
// Store-level summary across all measured applied executions.
// ---------------------------------------------------------------------------
router.get('/store/results', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    if (!req.query.shop) return res.status(400).json({ error: 'shop is required' });

    const result = await getStoreResultsSummary(prisma, req.query.shop);

    if (!result.success) {
      return res.status(404).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('[Metrics] GET /store/results error:', err.message);
    res.status(500).json({ error: 'Internal error fetching store results.' });
  }
});

// ---------------------------------------------------------------------------
// GET /metrics/store/suggestions/:issueId/candidates?shop=
// Returns all current action candidates for one issueId across this store.
// Reuses getProductActions + existing review-summary grouping logic.
// ---------------------------------------------------------------------------
router.get('/store/suggestions/:issueId/candidates', async (req, res) => {
  const prisma  = req.app.get('prisma');
  const issueId = req.params.issueId;
  try {
    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    const rawProducts = await prisma.product.findMany({
      where:   { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      take:    50,
      include: PRODUCT_INCLUDE,
    });

    // Batch-load applied executions for this issueId only
    const productIds  = rawProducts.map(p => p.id);
    const appliedRows = await prisma.contentExecution.findMany({
      where:  { productId: { in: productIds }, issueId, status: 'applied' },
      select: { productId: true },
    });
    const appliedSet = new Set(appliedRows.map(r => r.productId));

    const readyToApply   = [];
    const alreadyApplied = [];
    const blocked        = [];

    for (const raw of rawProducts) {
      const actionResult = await getProductActions(raw, { prisma, storeId: store.id });
      const action       = actionResult.actions.find(a => a.issueId === issueId);
      if (!action) continue;

      const eligible =
        action.applyType       === 'content_change' &&
        action.canAutoApply    === true             &&
        action.riskLevel       === 'low'            &&
        action.reviewStatus    === 'approved'       &&
        action.proposedContent !== null;

      const wasApplied    = appliedSet.has(raw.id);
      const inReadyGroup  = eligible && !wasApplied;

      const item = {
        productId:    raw.id,
        issueId,
        title:        raw.title ?? raw.id,
        selectionKey: `${raw.id}::${issueId}`,
        selectable:   inReadyGroup,
        severity:     action.severity,
        score:        action.scoreImpact ?? null,
        riskLevel:    action.riskLevel,
        reviewStatus: action.reviewStatus,
        eligible:     inReadyGroup,
        reason:       wasApplied ? 'already applied'
                    : !eligible  ? (action.reviewStatus !== 'approved' ? `reviewStatus is ${action.reviewStatus}` : 'not eligible')
                    : null,
      };

      if (wasApplied)        alreadyApplied.push(item);
      else if (inReadyGroup) readyToApply.push(item);
      else                   blocked.push(item);
    }

    res.json({
      success: true,
      shop:    req.query.shop,
      issueId,
      summary: {
        candidateCount:      readyToApply.length + alreadyApplied.length + blocked.length,
        readyToApplyCount:   readyToApply.length,
        alreadyAppliedCount: alreadyApplied.length,
        blockedCount:        blocked.length,
      },
      groups: { readyToApply, alreadyApplied, blocked },
    });
  } catch (err) {
    console.error('[Metrics] GET /store/suggestions/:issueId/candidates error:', err.message);
    res.status(500).json({ error: 'Internal error fetching suggestion candidates.' });
  }
});

// ---------------------------------------------------------------------------
// GET /metrics/store/suggestions-status?shop=
// Suggestions enriched with live candidate counts + deterministic status.
// ---------------------------------------------------------------------------
router.get('/store/suggestions-status', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    if (!req.query.shop) return res.status(400).json({ error: 'shop is required' });

    const result = await getStoreSuggestionsWithStatus(prisma, req.query.shop);

    if (!result.success) return res.status(404).json(result);

    res.json(result);
  } catch (err) {
    console.error('[Metrics] GET /store/suggestions-status error:', err.message);
    res.status(500).json({ error: 'Internal error fetching suggestion status.' });
  }
});

// ---------------------------------------------------------------------------
// GET /metrics/store/suggestions?shop=
// Store-level CRO suggestions derived from past measured execution outcomes.
// ---------------------------------------------------------------------------
router.get('/store/suggestions', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    if (!req.query.shop) return res.status(400).json({ error: 'shop is required' });

    const result = await getStoreCROSuggestions(prisma, req.query.shop);

    if (!result.success) return res.status(404).json(result);

    res.json(result);
  } catch (err) {
    console.error('[Metrics] GET /store/suggestions error:', err.message);
    res.status(500).json({ error: 'Internal error generating store CRO suggestions.' });
  }
});

// ---------------------------------------------------------------------------
// GET /metrics/store/overview?shop=
// Single dashboard payload: overview counts + top wins + recent activity.
// ---------------------------------------------------------------------------
router.get('/store/overview', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    if (!req.query.shop) return res.status(400).json({ error: 'shop is required' });

    const result = await getStoreOverview(prisma, req.query.shop);

    if (!result.success) return res.status(404).json(result);

    res.json(result);
  } catch (err) {
    console.error('[Metrics] GET /store/overview error:', err.message);
    res.status(500).json({ error: 'Internal error fetching store overview.' });
  }
});

module.exports = router;
