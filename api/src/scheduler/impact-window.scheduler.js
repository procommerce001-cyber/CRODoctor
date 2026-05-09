'use strict';

// ---------------------------------------------------------------------------
// impact-window.scheduler.js
//
// Runs every hour. Adaptive measurement-window rules:
//
//   Standard close — afterReadyAt <= now AND no after-snapshot yet:
//     • Check first-party atc_click count in the after-window period.
//     • atcCount === 0 (no tracker data) → capture immediately (original behaviour).
//     • 0 < atcCount < ATC_INSUFFICIENT_FLOOR AND < MAX_WINDOW_DAYS old
//         → extend afterReadyAt to applyDate + 14 d; skip capture this sweep.
//     • Otherwise (sufficient signal OR at max window cap) → capture.
//
//   Early close — afterReadyAt > now but atcCount >= ATC_EARLY_CLOSE_FLOOR
//     AND at least MIN_AFTER_DAYS_FOR_EARLY_CLOSE have elapsed:
//     → capture the after-snapshot now; do not wait for afterReadyAt.
//
// Before-snapshot was captured at apply time by captureWindowedBeforeSnapshot.
// Once both snapshots share a baselineExecutionId, compareExecutionMetrics /
// getExecutionResultsSummary surface the comparison — no further changes needed.
// ---------------------------------------------------------------------------

const { captureWindowedAfterSnapshot } = require('../services/metrics.service');

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// Adaptive window thresholds (mirror MIN_ATC_PER_WINDOW* in metrics.service.js).
const MAX_WINDOW_DAYS                = 14;  // hard cap — never extend past this
const ATC_INSUFFICIENT_FLOOR         = 20;  // extend when 0 < atcCount < this
const ATC_EARLY_CLOSE_FLOOR          = 150; // close early when atcCount >= this
const MIN_AFTER_DAYS_FOR_EARLY_CLOSE = 3;   // earliest day an early-close can fire

// ---------------------------------------------------------------------------
// afterWindowBoundary
// Returns UTC midnight of the day after applyDate — mirrors the after-window
// start computed by captureWindowedAfterSnapshot.
// ---------------------------------------------------------------------------
function afterWindowBoundary(applyDate) {
  const d = new Date(applyDate);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

// ---------------------------------------------------------------------------
// runImpactWindowSweep
// ---------------------------------------------------------------------------
async function runImpactWindowSweep(prisma) {
  const now = new Date();

  let captured    = 0;
  let skipped     = 0;
  let extended    = 0;
  let earlyClosed = 0;
  let failed      = 0;

  // ── 1. Standard close path — executions whose afterReadyAt has elapsed ────
  const due = await prisma.contentExecution.findMany({
    where: {
      status:       'applied',
      afterReadyAt: { lte: now },
    },
    select: { id: true, productId: true, createdAt: true },
  });

  for (const exec of due) {
    // Idempotency: skip if after-snapshot already exists for this execution
    const existing = await prisma.productMetricsSnapshot.findFirst({
      where:  { baselineExecutionId: exec.id, phase: 'after' },
      select: { id: true },
    });
    if (existing) { skipped++; continue; }

    // Adaptive extension: if first-party ATC signal is present but below the
    // floor, and the max window cap has not been reached, extend afterReadyAt.
    // atcCount === 0 means the storefront tracker has no data for this product
    // — do NOT extend in that case; fall through to capture (original behaviour).
    const daysSinceApply = (now.getTime() - exec.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (exec.productId && daysSinceApply < MAX_WINDOW_DAYS) {
      const afterStart = afterWindowBoundary(exec.createdAt);
      const atcCount   = await prisma.pdpEvent.count({
        where: { productId: exec.productId, event: 'atc_click', issuedAt: { gte: afterStart } },
      });
      if (atcCount > 0 && atcCount < ATC_INSUFFICIENT_FLOOR) {
        const maxReadyAt = new Date(exec.createdAt.getTime() + MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000);
        await prisma.contentExecution.update({
          where: { id: exec.id },
          data:  { afterReadyAt: maxReadyAt },
        }).catch(err => console.error(`[Scheduler] extend failed for execution ${exec.id}:`, err.message));
        extended++;
        continue;
      }
    }

    try {
      await captureWindowedAfterSnapshot(prisma, exec.productId, exec.id, exec.createdAt);
      captured++;
    } catch (err) {
      console.error(`[Scheduler] after-snapshot failed for execution ${exec.id}:`, err.message);
      failed++;
    }
  }

  // ── 2. Early-close scan — windows not yet due but signal already sufficient
  // Fires only after MIN_AFTER_DAYS_FOR_EARLY_CLOSE so a single traffic burst
  // cannot trigger a premature close on the first day.
  const earliestApply = new Date(now.getTime() - MIN_AFTER_DAYS_FOR_EARLY_CLOSE * 24 * 60 * 60 * 1000);
  const openWindows   = await prisma.contentExecution.findMany({
    where: {
      status:       'applied',
      afterReadyAt: { gt: now },
      createdAt:    { lte: earliestApply },
    },
    select: { id: true, productId: true, createdAt: true },
  });

  for (const exec of openWindows) {
    const existing = await prisma.productMetricsSnapshot.findFirst({
      where:  { baselineExecutionId: exec.id, phase: 'after' },
      select: { id: true },
    });
    if (existing) continue; // already captured early on a prior sweep

    if (!exec.productId) continue;
    const afterStart = afterWindowBoundary(exec.createdAt);
    const atcCount   = await prisma.pdpEvent.count({
      where: { productId: exec.productId, event: 'atc_click', issuedAt: { gte: afterStart, lte: now } },
    });
    if (atcCount >= ATC_EARLY_CLOSE_FLOOR) {
      try {
        await captureWindowedAfterSnapshot(prisma, exec.productId, exec.id, exec.createdAt);
        earlyClosed++;
      } catch (err) {
        console.error(`[Scheduler] early-close failed for execution ${exec.id}:`, err.message);
      }
    }
  }

  if (due.length > 0 || earlyClosed > 0) {
    console.log(
      `[Scheduler] Impact sweep — ${due.length} due, ` +
      `${captured} captured, ${skipped} skipped, ${extended} extended, ` +
      `${earlyClosed} early-closed, ${failed} failed`,
    );
  }
}

// ---------------------------------------------------------------------------
// startImpactWindowScheduler
// Call once at server startup. Runs an initial sweep immediately, then repeats
// every hour so windows captured during off-hours are not missed.
// ---------------------------------------------------------------------------
function startImpactWindowScheduler(prisma) {
  // Run once immediately so any windows that opened during downtime are caught
  runImpactWindowSweep(prisma).catch(err => {
    console.error('[Scheduler] Initial sweep error:', err.message);
  });

  setInterval(() => {
    runImpactWindowSweep(prisma).catch(err => {
      console.error('[Scheduler] Sweep error:', err.message);
    });
  }, SWEEP_INTERVAL_MS);

  console.log('[Scheduler] Impact window scheduler started (interval: 1h)');
}

module.exports = { startImpactWindowScheduler, runImpactWindowSweep };
