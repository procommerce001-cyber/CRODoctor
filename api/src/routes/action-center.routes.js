'use strict';

const express = require('express');
const router  = express.Router();

const {
  getProductActions,
  getStoreQueue,
  saveReviewState,
  getReviewStateForProduct,
} = require('../services/action-center.service');

const {
  previewContentExecution,
  previewRollback,
  getExecutionHistory,
} = require('../services/content-execution.service');

// Shared Prisma include — identical to cro.routes.js
const PRODUCT_INCLUDE = {
  variants: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, shopifyVariantId: true, title: true, sku: true,
      price: true, compareAtPrice: true, inventoryQuantity: true, availableForSale: true,
    },
  },
  images: {
    orderBy: { position: 'asc' },
    select: { id: true, src: true, altText: true, position: true },
  },
};

// ---------------------------------------------------------------------------
// Helper: resolve store or return 400/404
// ---------------------------------------------------------------------------
async function resolveStore(prisma, shop, res) {
  if (!shop) {
    res.status(400).json({ error: 'shop query param required' });
    return null;
  }
  const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
  if (!store) {
    res.status(404).json({ error: 'Store not found.' });
    return null;
  }
  return store;
}

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
// Draft-safe execution for content_change issues.
//
// Body: {
//   shop:                 string  (required)
//   issueId:              string  (required)
//   selectedVariantIndex: number  (optional, default 0)
//   preview:              boolean (optional, default true)
// }
//
// When preview=true (default):
//   - Runs gate checks and returns preview object
//   - Logs a "previewed" ContentExecution row
//   - Does NOT touch Shopify or the product record
//
// When preview=false:
//   - Same checks + returns same preview object
//   - Logs an "applied" ContentExecution row
//   - Still does NOT call Shopify — that step is pending
//
// Gate rules (returns 422 if any fail):
//   1. reviewStatus must be "approved"
//   2. canAutoApply must be true
//   3. applyType must be "content_change"
// ---------------------------------------------------------------------------
router.post('/products/:id/apply', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const { shop, issueId, selectedVariantIndex, preview = true } = req.body;

    if (!shop)    return res.status(400).json({ error: 'shop is required' });
    if (!issueId) return res.status(400).json({ error: 'issueId is required' });

    const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return res.status(404).json({ error: 'Store not found.' });

    const result = await previewContentExecution(prisma, {
      storeId:             store.id,
      productId:           req.params.id,
      issueId,
      selectedVariantIndex: typeof selectedVariantIndex === 'number' ? selectedVariantIndex : 0,
      preview:             preview !== false,
    });

    // If the gate blocked execution, surface that clearly with 422
    if (!result.eligibleToApply) {
      return res.status(422).json(result);
    }

    res.json(result);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    console.error('[ActionCenter] POST /products/:id/apply error:', err.message);
    res.status(500).json({ error: 'Internal error during execution preview.' });
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
// Preview-only rollback scaffold. Returns what would be restored.
// No Shopify write. No "rolled_back" row logged. Safe to call repeatedly.
//
// Body: {
//   shop:        string  (required)
//   issueId:     string  (required)
//   executionId: string  (optional — pin to a specific execution row;
//                         defaults to the most recent "applied" row for issueId)
// }
// ---------------------------------------------------------------------------
router.post('/products/:id/rollback', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const { shop, issueId, executionId } = req.body;

    if (!shop)    return res.status(400).json({ error: 'shop is required' });
    if (!issueId) return res.status(400).json({ error: 'issueId is required' });

    const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return res.status(404).json({ error: 'Store not found.' });

    const result = await previewRollback(prisma, {
      storeId:     store.id,
      productId:   req.params.id,
      issueId,
      executionId: executionId ?? null,
    });

    if (!result.eligibleToRollback) {
      return res.status(422).json(result);
    }

    res.json(result);
  } catch (err) {
    console.error('[ActionCenter] POST /products/:id/rollback error:', err.message);
    res.status(500).json({ error: 'Internal error during rollback preview.' });
  }
});

module.exports = router;
