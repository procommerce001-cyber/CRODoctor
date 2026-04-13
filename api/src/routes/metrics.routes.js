'use strict';

const express = require('express');
const router  = express.Router();

const { captureProductMetricsSnapshot, compareProductMetrics, captureExecutionSnapshots, compareExecutionMetrics, getExecutionResultsSummary, getStoreResultsSummary, getStoreExecutionFeed, getStoreOverview } = require('../services/metrics.service');
const { resolveStore }                  = require('../lib/resolve-store');

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
