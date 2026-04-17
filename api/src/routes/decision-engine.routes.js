'use strict';

const express = require('express');
const router  = express.Router();

const { getTopDecisionActions } = require('../services/metrics.service');
const { resolveStore }          = require('../lib/resolve-store');

// ---------------------------------------------------------------------------
// GET /decision-engine/top-actions?shop=<shopDomain>
// Returns the top 3 ranked store opportunities from the Decision Engine v1.
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

module.exports = router;
