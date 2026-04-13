'use strict';

const express = require('express');
const router  = express.Router();

const { getDashboardSelectionPayload } = require('../services/dashboard.service');

// ---------------------------------------------------------------------------
// GET /dashboard/selection?shop=
// Single payload for the main dashboard screen.
// Combines store metrics overview + review selection groups.
// ---------------------------------------------------------------------------
router.get('/selection', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    if (!req.query.shop) return res.status(400).json({ error: 'shop is required' });

    const result = await getDashboardSelectionPayload(prisma, req.query.shop);

    if (!result.success) return res.status(404).json(result);

    res.json(result);
  } catch (err) {
    console.error('[Dashboard] GET /selection error:', err.message);
    res.status(500).json({ error: 'Internal error generating dashboard payload.' });
  }
});

module.exports = router;
