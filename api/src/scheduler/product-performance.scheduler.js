'use strict';

// ---------------------------------------------------------------------------
// product-performance.scheduler.js
//
// Runs once every 24 hours. For each active store, captures a fresh
// ProductPerformanceProfile for every active product using a rolling 28-day
// window. capturedAt is truncated to UTC midnight so the upsert key
// (productId, capturedAt) produces at most one row per product per day.
//
// Per-product errors are caught and logged without aborting the store sweep.
// ---------------------------------------------------------------------------

const { captureProductPerformanceProfile } = require('../services/product-performance.service');

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ---------------------------------------------------------------------------
// runProductPerformanceSync
// ---------------------------------------------------------------------------
async function runProductPerformanceSync(prisma) {
  const stores = await prisma.store.findMany({
    where:  { isActive: true, accessToken: { not: null } },
    select: { id: true, shopDomain: true },
  });

  // UTC midnight of today — shared across all stores in this sweep
  const capturedAt = new Date();
  capturedAt.setUTCHours(0, 0, 0, 0);

  for (const store of stores) {
    const products = await prisma.product.findMany({
      where:  { storeId: store.id, status: 'active' },
      select: { id: true },
    });

    let captured = 0;
    let failed   = 0;

    for (const product of products) {
      try {
        await captureProductPerformanceProfile(prisma, product.id, { capturedAt });
        captured++;
      } catch (err) {
        console.error(
          `[ProductPerformance] profile failed — store=${store.shopDomain} product=${product.id}:`,
          err.message,
        );
        failed++;
      }
    }

    console.log(
      `[ProductPerformance] store=${store.shopDomain} — ` +
      `${products.length} products, ${captured} captured, ${failed} failed`,
    );
  }
}

// ---------------------------------------------------------------------------
// startProductPerformanceScheduler
// Call once at server startup — same pattern as the other schedulers.
// ---------------------------------------------------------------------------
function startProductPerformanceScheduler(prisma) {
  runProductPerformanceSync(prisma).catch(err =>
    console.error('[ProductPerformance] initial sweep error:', err.message),
  );

  setInterval(() => {
    runProductPerformanceSync(prisma).catch(err =>
      console.error('[ProductPerformance] sweep error:', err.message),
    );
  }, SWEEP_INTERVAL_MS);

  console.log('[ProductPerformance] scheduler started (interval: 24h)');
}

module.exports = { startProductPerformanceScheduler, runProductPerformanceSync };
