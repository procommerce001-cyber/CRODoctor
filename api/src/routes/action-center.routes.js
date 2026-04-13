'use strict';

const express = require('express');
const router  = express.Router();

const {
  getProductActions,
  getStoreQueue,
  saveReviewState,
  getReviewStateForProduct,
  buildActionPreview,
  checkApplyGate,
  applyContentChange,
  rollbackContentChange,
  buildBatchPreview,
} = require('../services/action-center.service');

const {
  previewContentExecution,
  getExecutionHistory,
} = require('../services/content-execution.service');

const { getProductReport } = require('../services/action-center.service');

const { PRODUCT_INCLUDE } = require('../lib/product-include');
const { resolveStore }    = require('../lib/resolve-store');

// ---------------------------------------------------------------------------
// GET /action-center/products/:id?shop=
// Returns detected issues + generated fixes with persisted review state merged in.
// Requires ?shop= to resolve storeId for state lookup.
// ---------------------------------------------------------------------------
router.get('/products/:id', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const raw = await prisma.product.findUnique({
      where:   { id: req.params.id },
      include: PRODUCT_INCLUDE,
    });
    if (!raw) return res.status(404).json({ error: 'Product not found.' });

    // Resolve store for state merge — optional; without shop param, state is not merged
    let storeId = null;
    if (req.query.shop) {
      const store = await prisma.store.findUnique({ where: { shopDomain: req.query.shop } });
      if (store) storeId = store.id;
    }

    const result = await getProductActions(raw, { prisma, storeId });
    res.json(result);
  } catch (err) {
    console.error('[ActionCenter] GET /products/:id error:', err.message);
    res.status(500).json({ error: 'Internal error during action center analysis.' });
  }
});

// ---------------------------------------------------------------------------
// POST /action-center/batch-apply-safe
// Controlled execution of CONTENT_CHANGE actions for an explicit product list.
//
// Eligibility (ALL must be true per action):
//   applyType === "content_change"
//   canAutoApply === true
//   riskLevel === "low"
//   reviewStatus === "approved"
//   proposedContent is non-null
//   not already applied (ContentExecution status="applied" exists → skip)
//   product belongs to the requested shop
//
// Safety constraints:
//   - productIds capped at 5
//   - Sequential execution — no concurrent writes
//   - Stops after 2 accumulated failures
//   - dryRun=true → no Shopify writes, no DB writes, gate not called
//   - Does NOT auto-approve; does NOT bypass apply-gate
//
// Body: { shop: string, productIds: string[], dryRun?: boolean }
// ---------------------------------------------------------------------------
router.post('/batch-apply-safe', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const { shop, productIds = [], dryRun = false } = req.body;

    if (!shop)                return res.status(400).json({ error: 'shop is required' });
    if (!productIds.length)   return res.status(400).json({ error: 'productIds is required' });
    if (productIds.length > 5) return res.status(400).json({ error: 'max 5 products per batch' });

    const store = await resolveStore(prisma, shop, res);
    if (!store) return;

    const results        = [];
    let   appliedCount   = 0;
    let   wouldApplyCount = 0;
    let   skippedCount   = 0;
    let   failedCount    = 0;
    let   stoppedEarly   = false;
    let   failuresSeen   = 0;
    const MAX_FAILURES   = 2;

    for (const productId of productIds) {
      if (failuresSeen >= MAX_FAILURES) { stoppedEarly = true; break; }

      // 1. Validate product ownership
      const rawProduct = await prisma.product.findFirst({
        where:   { id: productId, storeId: store.id },
        include: PRODUCT_INCLUDE,
      });

      if (!rawProduct) {
        results.push({
          productId, issueId: null, eligible: false,
          applied: false, wouldApply: false, skipped: true, failed: false,
          reason: 'product not found or does not belong to this shop',
          executionType: null, riskLevel: null,
        });
        skippedCount++; continue;
      }

      // 2. Run CRO engine + merge review state for this product
      const actionResult    = await getProductActions(rawProduct, { prisma, storeId: store.id });
      const eligibleActions = actionResult.actions.filter(a =>
        a.applyType        === 'content_change' &&
        a.canAutoApply     === true             &&
        a.riskLevel        === 'low'            &&
        a.reviewStatus     === 'approved'       &&
        a.proposedContent  !== null
      );

      if (!eligibleActions.length) {
        results.push({
          productId, issueId: null, eligible: false,
          applied: false, wouldApply: false, skipped: true, failed: false,
          reason: 'no eligible content_change actions (check applyType, canAutoApply, riskLevel, reviewStatus)',
          executionType: null, riskLevel: null,
        });
        skippedCount++; continue;
      }

      // 3. Process each eligible action sequentially
      for (const actionItem of eligibleActions) {
        if (failuresSeen >= MAX_FAILURES) { stoppedEarly = true; break; }

        const { issueId, executionType, riskLevel } = actionItem;

        // 3a. Already-applied guard (upfront — avoids unnecessary gate call)
        const alreadyApplied = await prisma.contentExecution.findFirst({
          where: { productId, issueId, status: 'applied' },
        });
        if (alreadyApplied) {
          results.push({
            productId, issueId, eligible: false,
            applied: false, wouldApply: false, skipped: true, failed: false,
            reason: 'already applied', executionType, riskLevel,
          });
          skippedCount++; continue;
        }

        // 3b. dryRun — no writes, return what would happen
        if (dryRun) {
          results.push({
            productId, issueId, eligible: true,
            applied: false, wouldApply: true, skipped: false, failed: false,
            reason: null, executionType, riskLevel,
          });
          wouldApplyCount++; continue;
        }

        // 3c. Live apply — re-fetch product for fresh bodyHtml before each write
        //     (a previous action in this batch may have changed it)
        const freshProduct = await prisma.product.findFirst({
          where: { id: productId, storeId: store.id }, include: PRODUCT_INCLUDE,
        });
        if (!freshProduct) {
          results.push({
            productId, issueId, eligible: true,
            applied: false, wouldApply: false, skipped: true, failed: false,
            reason: 'product vanished during batch', executionType, riskLevel,
          });
          skippedCount++; continue;
        }

        // Delegate to existing apply logic — gate enforced inside, P2002 guard active
        const applyResult = await applyContentChange(prisma, store, freshProduct, actionItem);

        if (applyResult.applied) {
          results.push({
            productId, issueId, eligible: true,
            applied: true, wouldApply: false, skipped: false, failed: false,
            reason: null, executionType, riskLevel,
          });
          appliedCount++;
          failuresSeen = 0;                      // reset on success
        } else if (applyResult.skipped) {
          results.push({
            productId, issueId, eligible: true,
            applied: false, wouldApply: false, skipped: true, failed: false,
            reason: applyResult.reason, executionType, riskLevel,
          });
          skippedCount++;
        } else {
          results.push({
            productId, issueId, eligible: true,
            applied: false, wouldApply: false, skipped: false, failed: true,
            reason: applyResult.blockReason || applyResult.error || 'apply blocked',
            executionType, riskLevel,
          });
          failedCount++;
          failuresSeen++;
        }
      }
    }

    res.json({
      shop,
      dryRun,
      requestedProductCount: productIds.length,
      actionCount:           results.length,
      appliedCount,
      wouldApplyCount,
      skippedCount,
      failedCount,
      stoppedEarly,
      results,
    });
  } catch (err) {
    console.error('[ActionCenter] POST /batch-apply-safe error:', err.message);
    res.status(500).json({ error: 'Internal error during batch apply.' });
  }
});

// ---------------------------------------------------------------------------
// GET /action-center/batch-preview?shop=
// Control-layer decision view: groups all actions into high_impact / quick_wins
// / needs_review, scores and sorts each group, marks readyToApply per item.
// ---------------------------------------------------------------------------
router.get('/batch-preview', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    const rawProducts = await prisma.product.findMany({
      where:   { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      take:    50,
      include: PRODUCT_INCLUDE,
    });

    const result = await buildBatchPreview(req.query.shop, rawProducts, {
      prisma,
      storeId: store.id,
    });
    res.json(result);
  } catch (err) {
    console.error('[ActionCenter] GET /batch-preview error:', err.message);
    res.status(500).json({ error: 'Internal error during batch preview.' });
  }
});

// ---------------------------------------------------------------------------
// GET /action-center/queue?shop=
// Returns full store queue with persisted review state merged into every item.
// ---------------------------------------------------------------------------
router.get('/queue', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    const rawProducts = await prisma.product.findMany({
      where:   { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      take:    50,                    // cap: avoid full-catalog scan on every request
      include: PRODUCT_INCLUDE,
    });

    const result = await getStoreQueue(req.query.shop, rawProducts, {
      prisma,
      storeId: store.id,
    });
    res.json(result);
  } catch (err) {
    console.error('[ActionCenter] GET /queue error:', err.message);
    res.status(500).json({ error: 'Internal error during queue generation.' });
  }
});

// ---------------------------------------------------------------------------
// POST /action-center/review
// Persists a reviewer decision for one issue on one product.
//
// Body: {
//   shop:                 string  (required — to resolve storeId)
//   productId:            string  (required)
//   issueId:              string  (required)
//   reviewStatus:         "pending" | "approved" | "rejected" | "deferred"
//   selectedVariantIndex: number  (optional — which generatedFix variant was chosen)
// }
// ---------------------------------------------------------------------------
router.post('/review', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const { shop, productId, issueId, reviewStatus, selectedVariantIndex } = req.body;

    if (!shop)         return res.status(400).json({ error: 'shop is required' });
    if (!productId)    return res.status(400).json({ error: 'productId is required' });
    if (!issueId)      return res.status(400).json({ error: 'issueId is required' });
    if (!reviewStatus) return res.status(400).json({ error: 'reviewStatus is required' });

    const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return res.status(404).json({ error: 'Store not found.' });

    // Confirm the product belongs to this store
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId: store.id },
      select: { id: true },
    });
    if (!product) return res.status(404).json({ error: 'Product not found in this store.' });

    const saved = await saveReviewState(prisma, {
      storeId:             store.id,
      productId,
      issueId,
      reviewStatus,
      selectedVariantIndex: typeof selectedVariantIndex === 'number' ? selectedVariantIndex : null,
    });

    res.json({ success: true, item: saved });
  } catch (err) {
    if (err.message.startsWith('Invalid reviewStatus')) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[ActionCenter] POST /review error:', err.message);
    res.status(500).json({ error: 'Internal error saving review state.' });
  }
});

// ---------------------------------------------------------------------------
// GET /action-center/review-state?productId=&shop=
// Returns raw persisted state for a product. Pure DB read — no engine re-run.
// ---------------------------------------------------------------------------
router.get('/review-state', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const { productId, shop } = req.query;

    if (!productId) return res.status(400).json({ error: 'productId query param required' });
    if (!shop)      return res.status(400).json({ error: 'shop query param required' });

    const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return res.status(404).json({ error: 'Store not found.' });

    const result = await getReviewStateForProduct(prisma, store.id, productId);
    res.json(result);
  } catch (err) {
    console.error('[ActionCenter] GET /review-state error:', err.message);
    res.status(500).json({ error: 'Internal error fetching review state.' });
  }
});

// ---------------------------------------------------------------------------
// POST /action-center/products/:id/apply
// Real execution for a single CONTENT_CHANGE action item.
// Calls the apply-gate internally — only proceeds if eligibleToApply === true.
// Writes proposedContent to Shopify, persists execution record, updates local DB.
//
// Body: { shop: string, issueId: string }
//
// Gate conditions (all must pass):
//   1. applyType === "content_change"
//   2. canAutoApply === true
//   3. reviewStatus === "approved"
// ---------------------------------------------------------------------------
router.post('/products/:id/apply', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const { shop, issueId } = req.body;

    if (!shop)    return res.status(400).json({ error: 'shop is required' });
    if (!issueId) return res.status(400).json({ error: 'issueId is required' });

    const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return res.status(404).json({ error: 'Store not found.' });

    const raw = await prisma.product.findFirst({
      where:   { id: req.params.id, storeId: store.id },
      include: PRODUCT_INCLUDE,
    });
    if (!raw) return res.status(404).json({ error: 'Product not found in this store.' });

    const result     = await getProductActions(raw, { prisma, storeId: store.id });
    const actionItem = result.actions.find(a => a.issueId === issueId);

    if (!actionItem) {
      return res.status(404).json({ error: `No action found for issueId "${issueId}" on this product.` });
    }

    const applyResult = await applyContentChange(prisma, store, raw, actionItem);

    if (!applyResult.applied) {
      const status = applyResult.error ? 502 : 422;
      return res.status(status).json(applyResult);
    }

    res.json(applyResult);
  } catch (err) {
    console.error('[ActionCenter] POST /products/:id/apply error:', err.message);
    res.status(500).json({ error: 'Internal error during apply.' });
  }
});

// ---------------------------------------------------------------------------
// GET /action-center/products/:id/executions?shop=
// Returns the ContentExecution history for a product (newest first).
// Pure DB read — no engine re-run.
// ---------------------------------------------------------------------------
router.get('/products/:id/executions', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    const result = await getExecutionHistory(prisma, store.id, req.params.id);
    res.json(result);
  } catch (err) {
    console.error('[ActionCenter] GET /products/:id/executions error:', err.message);
    res.status(500).json({ error: 'Internal error fetching execution history.' });
  }
});

// ---------------------------------------------------------------------------
// POST /action-center/products/:id/rollback
// Reverts a product's bodyHtml to its exact state before the last apply.
//
// Body: { shop: string (required), issueId: string (required) }
//
// Safety checks (all must pass):
//   1. A ContentExecution with status='applied' exists for this product+issue
//   2. Current bodyHtml matches the resultContent stored at apply time
//      (aborts if a manual edit has been made since)
//   3. Not already rolled back (idempotent — returns skipped if so)
// ---------------------------------------------------------------------------
router.post('/products/:id/rollback', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const { shop, issueId } = req.body;

    if (!shop)    return res.status(400).json({ error: 'shop is required' });
    if (!issueId) return res.status(400).json({ error: 'issueId is required' });

    const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return res.status(404).json({ error: 'Store not found.' });

    const raw = await prisma.product.findFirst({
      where:   { id: req.params.id, storeId: store.id },
      include: PRODUCT_INCLUDE,
    });
    if (!raw) return res.status(404).json({ error: 'Product not found in this store.' });

    const result = await rollbackContentChange(prisma, store, raw, issueId);

    if (!result.success) {
      const status = result.skipped ? 422 : 409;
      return res.status(status).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('[ActionCenter] POST /products/:id/rollback error:', err.message);
    res.status(500).json({ error: 'Internal error during rollback.' });
  }
});

// ---------------------------------------------------------------------------
// POST /action-center/products/:id/apply-gate
// Gate check for a single content_change action. Simulation only — no Shopify
// write. Returns eligibleToApply + blockReason + current/proposed content.
//
// Body: { shop: string, issueId: string }
//
// Gate conditions (all must pass):
//   1. applyType === "content_change"
//   2. canAutoApply === true
//   3. reviewStatus === "approved"
// ---------------------------------------------------------------------------
router.post('/products/:id/apply-gate', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const { shop, issueId } = req.body;

    if (!shop)    return res.status(400).json({ error: 'shop is required' });
    if (!issueId) return res.status(400).json({ error: 'issueId is required' });

    const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return res.status(404).json({ error: 'Store not found.' });

    const raw = await prisma.product.findFirst({
      where:   { id: req.params.id, storeId: store.id },
      include: PRODUCT_INCLUDE,
    });
    if (!raw) return res.status(404).json({ error: 'Product not found in this store.' });

    const result     = await getProductActions(raw, { prisma, storeId: store.id });
    const actionItem = result.actions.find(a => a.issueId === issueId);

    if (!actionItem) {
      return res.status(404).json({ error: `No action found for issueId "${issueId}" on this product.` });
    }

    const gateResult = checkApplyGate(actionItem, raw);

    if (!gateResult.eligibleToApply) {
      return res.status(422).json(gateResult);
    }

    res.json(gateResult);
  } catch (err) {
    console.error('[ActionCenter] POST /products/:id/apply-gate error:', err.message);
    res.status(500).json({ error: 'Internal error during apply gate check.' });
  }
});

// ---------------------------------------------------------------------------
// GET /action-center/products/:id/preview?shop=
// Returns action items grouped into autoApplicable / requiresReview.
// Each item includes all classification fields + a human-readable changeSummary.
// No fixes are applied. Pure read.
// ---------------------------------------------------------------------------
router.get('/products/:id/preview', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const raw = await prisma.product.findUnique({
      where:   { id: req.params.id },
      include: PRODUCT_INCLUDE,
    });
    if (!raw) return res.status(404).json({ error: 'Product not found.' });

    let storeId = null;
    if (req.query.shop) {
      const store = await prisma.store.findUnique({ where: { shopDomain: req.query.shop } });
      if (store) storeId = store.id;
    }

    const result  = await getProductActions(raw, { prisma, storeId });
    const preview = buildActionPreview(result.actions, raw);

    res.json({
      productId:         result.productId,
      title:             result.title,
      optimizationScore: result.optimizationScore,
      ...preview,
    });
  } catch (err) {
    console.error('[ActionCenter] GET /products/:id/preview error:', err.message);
    res.status(500).json({ error: 'Internal error generating action preview.' });
  }
});

// ---------------------------------------------------------------------------
// GET /action-center/products/:id/report
// Business-grade CRO report for a single product.
// Returns 3–5 strongest issues formatted for a non-technical business owner.
// No review state merged — pure analytical read.
// ---------------------------------------------------------------------------
router.get('/products/:id/report', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const raw = await prisma.product.findUnique({
      where:   { id: req.params.id },
      include: PRODUCT_INCLUDE,
    });
    if (!raw) return res.status(404).json({ error: 'Product not found.' });

    const report = await getProductReport(raw);
    res.json(report);
  } catch (err) {
    console.error('[ActionCenter] GET /products/:id/report error:', err.message);
    res.status(500).json({ error: 'Internal error generating CRO report.' });
  }
});

module.exports = router;
