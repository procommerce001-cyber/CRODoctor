'use strict';

// ---------------------------------------------------------------------------
// impact-window.scheduler.js
//
// Runs every hour. Finds ContentExecution rows where:
//   status       = 'applied'
//   afterReadyAt <= now
//   no phase='after' snapshot is yet linked to this execution
//
// For each due execution, captures the windowed after-snapshot covering
// [applyDate+1d, applyDate+8d). The before-snapshot was already captured
// at apply time by captureWindowedBeforeSnapshot.
//
// Once both snapshots exist with the same baselineExecutionId, the existing
// compareExecutionMetrics / getExecutionResultsSummary functions surface the
// comparison — no further changes required.
// ---------------------------------------------------------------------------

const { captureWindowedAfterSnapshot } = require('../services/metrics.service');

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// runImpactWindowSweep
// ---------------------------------------------------------------------------
async function runImpactWindowSweep(prisma) {
  const now = new Date();

  const due = await prisma.contentExecution.findMany({
    where: {
      status:       'applied',
      afterReadyAt: { lte: now },
    },
    select: { id: true, productId: true, createdAt: true },
  });

  if (due.length === 0) return;

  let captured = 0;
  let skipped  = 0;
  let failed   = 0;

  for (const exec of due) {
    // Idempotency: skip if after-snapshot already exists for this execution
    const existing = await prisma.productMetricsSnapshot.findFirst({
      where:  { baselineExecutionId: exec.id, phase: 'after' },
      select: { id: true },
    });
    if (existing) { skipped++; continue; }

    try {
      await captureWindowedAfterSnapshot(prisma, exec.productId, exec.id, exec.createdAt);
      captured++;
    } catch (err) {
      console.error(`[Scheduler] after-snapshot failed for execution ${exec.id}:`, err.message);
      failed++;
    }
  }

  console.log(
    `[Scheduler] Impact sweep complete — ${due.length} due, ` +
    `${captured} captured, ${skipped} skipped, ${failed} failed`,
  );
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
