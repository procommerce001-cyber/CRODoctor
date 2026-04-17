'use strict';

const express = require('express');
const router  = express.Router();

const { getTopDecisionActions }              = require('../services/metrics.service');
const { resolveStore }                       = require('../lib/resolve-store');
const { getProductActions, applyContentChange } = require('../services/action-center.service');
const { PRODUCT_INCLUDE }                    = require('../lib/product-include');

// ---------------------------------------------------------------------------
// GET /decision-engine/top-actions?shop=<shopDomain>
// ---------------------------------------------------------------------------
router.get('/top-actions', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    if (!req.query.shop) return res.status(400).json({ error: 'shop is required' });

    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    const result = await getTopDecisionActions(prisma, req.query.shop);
    if (!result.success) return res.status(404).json(result);

    res.json(result);
  } catch (err) {
    console.error('[DecisionEngine] GET /top-actions error:', err.message);
    res.status(500).json({ error: 'Internal error generating top decision actions.' });
  }
});

// ---------------------------------------------------------------------------
// POST /decision-engine/actions/execute?shop=<shopDomain>
// Body: { actionKey: "productId::issueId" }
//
// For content_change issues: applies the generated fix to Shopify and stores
// a ContentExecution row with status="applied" + previousContent for rollback.
//
// For non-content issues (manual, app_config): falls back to a lightweight
// "completed" record — no Shopify write.
//
// Idempotent — calling twice returns the existing record.
// ---------------------------------------------------------------------------
router.post('/actions/execute', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    if (!req.query.shop) return res.status(400).json({ error: 'shop is required' });

    const { actionKey } = req.body || {};
    if (!actionKey || !actionKey.includes('::')) {
      return res.status(400).json({ error: 'actionKey is required and must be "productId::issueId"' });
    }

    const [productId, issueId] = actionKey.split('::');
    if (!productId || !issueId) {
      return res.status(400).json({ error: 'actionKey must be "productId::issueId"' });
    }

    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    // Validate against live Decision Engine output.
    const decisionResult = await getTopDecisionActions(prisma, req.query.shop);
    if (!decisionResult.success) {
      return res.status(400).json({ error: 'No eligible actions found for this store.' });
    }
    const isEligible = decisionResult.topActions.some(
      a => a.productId === productId && a.issueId === issueId
    );
    if (!isEligible) {
      return res.status(400).json({
        error: `actionKey "${actionKey}" is not in the current top actions. Only ranked actions can be executed.`,
      });
    }

    // Idempotency — return existing record if already applied or completed.
    const existing = await prisma.contentExecution.findFirst({
      where:  { storeId: store.id, productId, issueId, status: { in: ['applied', 'completed'] } },
      select: { id: true, createdAt: true, status: true },
    });
    if (existing) {
      return res.json({
        success:         true,
        actionKey,
        applied:         existing.status === 'applied',
        executionStatus: 'completed',
        executedBy:      'user',
        executedAt:      existing.createdAt,
        executionId:     existing.id,
      });
    }

    // Fetch full product (needed by applyContentChange and generatedFix).
    const rawProduct = await prisma.product.findUnique({
      where:   { id: productId },
      include: PRODUCT_INCLUDE,
    });
    if (!rawProduct) return res.status(404).json({ error: 'Product not found.' });

    // Build action details (includes generatedFix, applyType, canAutoApply).
    const actionResult = await getProductActions(rawProduct, { prisma, storeId: store.id });
    const action = actionResult.actions.find(a => a.issueId === issueId);

    // ── Content-change path: real Shopify apply ───────────────────────────
    const hasGeneratedContent = !!action?.generatedFix?.bestGuess?.content;

    if (action?.applyType === 'content_change' && action.canAutoApply && hasGeneratedContent) {
      // The user clicking "Fix this now" counts as approval.
      await prisma.actionItem.upsert({
        where:  { storeId_productId_issueId: { storeId: store.id, productId, issueId } },
        update: { reviewStatus: 'approved' },
        create: { storeId: store.id, productId, issueId, reviewStatus: 'approved' },
      });

      const approvedAction = { ...action, reviewStatus: 'approved' };
      const applyResult = await applyContentChange(prisma, store, rawProduct, approvedAction);

      if (!applyResult.applied) {
        // Gate blocked or already applied — surface a clear reason.
        return res.status(400).json({
          success: false,
          reason:  applyResult.blockReason ?? applyResult.reason ?? 'Apply was blocked.',
        });
      }

      // Fetch the execution row just written by applyContentChange.
      const execution = await prisma.contentExecution.findFirst({
        where:   { storeId: store.id, productId, issueId, status: 'applied' },
        orderBy: { createdAt: 'desc' },
        select:  { id: true, createdAt: true },
      });

      return res.json({
        success:         true,
        actionKey,
        applied:         true,
        executionStatus: 'completed',
        executedBy:      'user',
        executedAt:      execution?.createdAt ?? new Date(),
        executionId:     execution?.id ?? null,
      });
    }

    // ── Fallback: non-content issue — record completion without Shopify write ─
    const execution = await prisma.contentExecution.create({
      data: {
        storeId:    store.id,
        productId,
        issueId,
        newContent: '[manual-execution]',
        status:     'completed',
      },
    });

    res.json({
      success:         true,
      actionKey,
      applied:         false,
      executionStatus: 'completed',
      executedBy:      'user',
      executedAt:      execution.createdAt,
      executionId:     execution.id,
    });
  } catch (err) {
    console.error('[DecisionEngine] POST /actions/execute error:', err.message);
    res.status(500).json({ error: 'Internal error executing action.' });
  }
});

module.exports = router;
