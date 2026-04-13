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
const { captureProductMetricsSnapshot, captureExecutionSnapshots } = require('../services/metrics.service');

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
// POST /action-center/batch-apply-selected
// Controlled execution: applies ONLY the explicitly listed selectionKeys.
// Does NOT auto-expand, does NOT group by product, stays strictly action-level.
//
// Body: { shop: string, selection: string[] }
//   selection entries must be "productId::issueId"
//
// Safety: max 10 items, sequential execution.
// ---------------------------------------------------------------------------
router.post('/batch-apply-selected', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const { shop, selection = [] } = req.body;

    if (!shop)                 return res.status(400).json({ error: 'shop is required' });
    if (!selection.length)     return res.status(400).json({ error: 'selection must be a non-empty array' });
    if (selection.length > 10) return res.status(400).json({ error: 'max 10 selectionKeys per request' });

    const invalidKey = selection.find(k => typeof k !== 'string' || k.split('::').length !== 2 || !k.split('::')[0] || !k.split('::')[1]);
    if (invalidKey !== undefined) return res.status(400).json({ error: `invalid selectionKey format: "${invalidKey}" — expected productId::issueId` });

    const seen = new Set();
    const duplicate = selection.find(k => seen.size === seen.add(k).size);
    if (duplicate !== undefined) return res.status(400).json({ error: `duplicate selectionKey: "${duplicate}"` });

    const store = await resolveStore(prisma, shop, res);
    if (!store) return;

    const results      = [];
    let appliedCount   = 0;
    let skippedCount   = 0;
    let failedCount    = 0;

    for (const key of selection) {
      const [productId, issueId] = key.split('::');

      // 1. Fetch product (ownership check)
      const rawProduct = await prisma.product.findFirst({
        where:   { id: productId, storeId: store.id },
        include: PRODUCT_INCLUDE,
      });
      if (!rawProduct) {
        results.push({
          selectionKey: key, productId, issueId,
          status: 'skipped', reason: 'product not found or does not belong to this shop',
          executionId: null,
        });
        skippedCount++; continue;
      }

      // 2. Resolve action item
      const actionResult = await getProductActions(rawProduct, { prisma, storeId: store.id });
      const actionItem   = actionResult.actions.find(a => a.issueId === issueId);
      if (!actionItem) {
        results.push({
          selectionKey: key, productId, issueId,
          status: 'skipped', reason: `no action found for issueId "${issueId}" on this product`,
          executionId: null,
        });
        skippedCount++; continue;
      }

      // 3. Re-fetch for freshest bodyHtml before write
      const freshProduct = await prisma.product.findFirst({
        where: { id: productId, storeId: store.id }, include: PRODUCT_INCLUDE,
      });
      if (!freshProduct) {
        results.push({
          selectionKey: key, productId, issueId,
          status: 'skipped', reason: 'product vanished during execution',
          executionId: null,
        });
        skippedCount++; continue;
      }

      // 4. Apply — gate enforced inside applyContentChange
      const applyResult = await applyContentChange(prisma, store, freshProduct, actionItem);

      if (applyResult.applied) {
        // Fetch executionId from the record written by applyContentChange
        const execution = await prisma.contentExecution.findFirst({
          where:   { productId, issueId, status: 'applied' },
          orderBy: { createdAt: 'desc' },
          select:  { id: true },
        });
        results.push({
          selectionKey: key, productId, issueId,
          status: 'applied', reason: null,
          executionId: execution?.id ?? null,
        });
        appliedCount++;
      } else if (applyResult.skipped) {
        results.push({
          selectionKey: key, productId, issueId,
          status: 'skipped', reason: applyResult.reason,
          executionId: null,
        });
        skippedCount++;
      } else {
        results.push({
          selectionKey: key, productId, issueId,
          status: 'failed', reason: applyResult.blockReason || applyResult.error || 'apply blocked',
          executionId: null,
        });
        failedCount++;
      }
    }

    res.json({
      mode:                    'selection_apply',
      requestedSelectionCount: selection.length,
      resultCount:             results.length,
      appliedCount,
      skippedCount,
      failedCount,
      results,
    });
  } catch (err) {
    console.error('[ActionCenter] POST /batch-apply-selected error:', err.message);
    res.status(500).json({ error: 'Internal error during selection apply.' });
  }
});

// ---------------------------------------------------------------------------
// GET /action-center/review-summary?shop=
// Decision-ready action view grouped into readyToApply / alreadyApplied / blocked.
// No filtering — every action appears in exactly one group.
// Sorted within each group: score ASC (most negative first), then severity.
// ---------------------------------------------------------------------------
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function sortActionItems(items) {
  return items.sort((a, b) => {
    const scoreDiff = (a.score ?? 0) - (b.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
  });
}

router.get('/review-summary', async (req, res) => {
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

    // Batch-load all applied executions for this store's products in one query
    const productIds = rawProducts.map(p => p.id);
    const appliedRows = await prisma.contentExecution.findMany({
      where:  { productId: { in: productIds }, status: 'applied' },
      select: { productId: true, issueId: true },
    });
    const appliedSet = new Set(appliedRows.map(r => `${r.productId}:${r.issueId}`));

    const readyToApply   = [];
    const alreadyApplied = [];
    const blocked        = [];

    for (const raw of rawProducts) {
      const actionResult = await getProductActions(raw, { prisma, storeId: store.id });

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

        const wasApplied = appliedSet.has(`${raw.id}:${action.issueId}`);

        const inReadyGroup = eligible && !wasApplied;

        const item = {
          productId:    raw.id,
          issueId:      action.issueId,
          selectionKey: `${raw.id}::${action.issueId}`,
          selectable:   inReadyGroup,
          severity:     action.severity,
          score:        action.scoreImpact,
          riskLevel:    action.riskLevel,
          reviewStatus: action.reviewStatus,
          eligible:     inReadyGroup,
          canAutoApply: action.canAutoApply,
          wouldApply:   inReadyGroup,
          reason:       wasApplied ? 'already applied' : reason,
        };

        if (wasApplied)         alreadyApplied.push(item);
        else if (inReadyGroup)  readyToApply.push(item);
        else                    blocked.push(item);
      }
    }

    sortActionItems(readyToApply);
    sortActionItems(alreadyApplied);
    sortActionItems(blocked);

    res.json({
      shop: req.query.shop,
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
    });
  } catch (err) {
    console.error('[ActionCenter] GET /review-summary error:', err.message);
    res.status(500).json({ error: 'Internal error generating review summary.' });
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

    // 1. Explicit gate check — abort before any snapshot if not eligible
    const gate = checkApplyGate(actionItem, raw);
    if (!gate.eligibleToApply) {
      return res.status(422).json({ applied: false, blockReason: gate.blockReason });
    }

    // 2. Before-snapshot (phase='before') — gate passed, executionId not yet known
    let beforeCaptured  = false;
    let beforeSnapshotId = null;
    try {
      const beforeSnap = await captureProductMetricsSnapshot(prisma, raw.id, 'before');
      beforeSnapshotId = beforeSnap.id;
      beforeCaptured   = true;
    } catch (snapErr) {
      console.warn('[ActionCenter] before-snapshot failed (non-fatal):', snapErr.message);
    }

    // 3. Apply — gate runs again inside applyContentChange (idempotent, safe)
    const applyResult = await applyContentChange(prisma, store, raw, actionItem);

    if (!applyResult.applied) {
      const status = applyResult.error ? 502 : 422;
      return res.status(status).json(applyResult);
    }

    // 4. Fetch the executionId written by applyContentChange
    const execution = await prisma.contentExecution.findFirst({
      where:   { productId: raw.id, issueId, status: 'applied' },
      orderBy: { createdAt: 'desc' },
      select:  { id: true },
    });
    const executionId = execution?.id ?? null;

    // 5. Link before-snapshot to execution, then capture after-snapshot (phase='after')
    let afterCaptured = false;
    let warning       = undefined;
    if (executionId) {
      // Retroactively link the before-snapshot
      if (beforeSnapshotId) {
        try {
          await prisma.productMetricsSnapshot.update({
            where: { id: beforeSnapshotId },
            data:  { baselineExecutionId: executionId },
          });
        } catch (linkErr) {
          console.warn('[ActionCenter] before-snapshot link failed (non-fatal):', linkErr.message);
        }
      }
      try {
        await captureExecutionSnapshots(prisma, raw.id, executionId);
        afterCaptured = true;
      } catch (snapErr) {
        console.warn('[ActionCenter] after-snapshot failed (non-fatal):', snapErr.message);
        warning = 'apply succeeded but after-snapshot failed';
      }
    }

    res.json({
      ...applyResult,
      executionId,
      metricsSnapshots: { beforeCaptured, afterCaptured },
      ...(warning ? { warning } : {}),
    });
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
