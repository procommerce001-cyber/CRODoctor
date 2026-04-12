'use strict';

const express   = require('express');
const router    = express.Router();

const { analyzeProduct }   = require('../services/cro/analyzeProduct');
const { analyzeStore }     = require('../services/cro/analyzeStore');
const { toCroProduct }     = require('../services/cro/formatters');
const { RULES }            = require('../services/cro/rules');
const { PRODUCT_INCLUDE }  = require('../lib/product-include');
const { resolveStore }     = require('../lib/resolve-store');

// ---------------------------------------------------------------------------
// GET /cro/health
// Engine status — confirms rules are loaded and scoring is working.
// ---------------------------------------------------------------------------
router.get('/health', (_req, res) => {
  res.json({
    success:     true,
    croEngine:   'ok',
    rulesLoaded: RULES.length,
    scoring:     'ok',
    version:     '2.0.0',
  });
});

// ---------------------------------------------------------------------------
// GET /cro/products?shop=
// CRO analysis for all products in the store.
// Returns a lightweight summary per product — full detail via /cro/products/:id
// ---------------------------------------------------------------------------
router.get('/products', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    const rawProducts = await prisma.product.findMany({
      where:   { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      include: PRODUCT_INCLUDE,
    });

    const analyses = rawProducts.map(p => {
      const croProduct = toCroProduct(p);
      const analysis   = analyzeProduct(croProduct);
      // Return summary shape — not full issue lists (use /cro/products/:id for that)
      return {
        productId:         analysis.productId,
        title:             analysis.title,
        status:            analysis.status,
        optimizationScore: analysis.optimizationScore,
        scoreLabel:        analysis.scoreLabel,
        summary:           analysis.summary,
        totalIssues:       analysis.totalIssues,
        criticalCount:     analysis.criticalCount,
        topIssues:         analysis.topIssues.slice(0, 3).map(i => ({
          issueId:  i.issueId,
          title:    i.title,
          severity: i.severity,
          effort:   i.effort,
        })),
      };
    });

    res.json({
      shop:     req.query.shop,
      total:    analyses.length,
      products: analyses,
    });
  } catch (err) {
    console.error('[CRO] GET /products error:', err.message);
    res.status(500).json({ error: 'Internal error during CRO product analysis.' });
  }
});

// ---------------------------------------------------------------------------
// GET /cro/products/:id
// Full CRO analysis for a single product.
// Returns the complete standardized analysis object.
// ---------------------------------------------------------------------------
router.get('/products/:id', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const raw = await prisma.product.findUnique({
      where:   { id: req.params.id },
      include: PRODUCT_INCLUDE,
    });

    if (!raw) return res.status(404).json({ error: 'Product not found.' });

    const analysis = analyzeProduct(toCroProduct(raw));
    res.json(analysis);
  } catch (err) {
    console.error('[CRO] GET /products/:id error:', err.message);
    res.status(500).json({ error: 'Internal error during CRO product analysis.' });
  }
});

// ---------------------------------------------------------------------------
// GET /cro/priorities?shop=
// Top 10 highest-priority issues across the store, ranked by severity + effort.
// Designed for the Action Center — "what should I do next?"
// ---------------------------------------------------------------------------
router.get('/priorities', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    const rawProducts = await prisma.product.findMany({
      where:   { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      include: PRODUCT_INCLUDE,
    });

    const allIssues = rawProducts.flatMap(p => {
      const analysis = analyzeProduct(toCroProduct(p));
      return analysis.topIssues.concat(analysis.criticalBlockers, analysis.quickWins, analysis.revenueOpportunities)
        .map(issue => ({ ...issue, productId: analysis.productId, productTitle: analysis.title }));
    });

    // De-duplicate: keep one per (issueId × productId) pair — prevent double-counting
    const seen = new Set();
    const deduplicated = allIssues.filter(i => {
      const key = `${i.issueId}__${i.productId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort: critical → high → medium → low, then effort asc (low effort first)
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const effortOrder   = { low: 0, medium: 1, high: 2 };
    deduplicated.sort((a, b) => {
      const sA = severityOrder[a.severity] ?? 9;
      const sB = severityOrder[b.severity] ?? 9;
      if (sA !== sB) return sA - sB;
      return (effortOrder[a.effort] ?? 9) - (effortOrder[b.effort] ?? 9);
    });

    res.json({
      shop:         req.query.shop,
      totalIssues:  deduplicated.length,
      topPriorities: deduplicated.slice(0, 10),
    });
  } catch (err) {
    console.error('[CRO] GET /priorities error:', err.message);
    res.status(500).json({ error: 'Internal error during priority analysis.' });
  }
});

// ---------------------------------------------------------------------------
// GET /cro/action-plan?shop=
// Full store-level CRO action plan.
// ---------------------------------------------------------------------------
router.get('/action-plan', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const store = await resolveStore(prisma, req.query.shop, res);
    if (!store) return;

    const rawProducts = await prisma.product.findMany({
      where:   { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      include: PRODUCT_INCLUDE,
    });

    const croProducts = rawProducts.map(toCroProduct);
    const plan        = analyzeStore(req.query.shop, croProducts);

    res.json(plan);
  } catch (err) {
    console.error('[CRO] GET /action-plan error:', err.message);
    res.status(500).json({ error: 'Internal error during action plan generation.' });
  }
});

module.exports = router;
