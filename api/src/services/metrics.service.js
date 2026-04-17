'use strict';

const { getProductActions } = require('./action-center.service');
const { PRODUCT_INCLUDE }   = require('../lib/product-include');

// ---------------------------------------------------------------------------
// captureProductMetricsSnapshot
//
// Computes order-derived metrics for one product and upserts a snapshot row
// for today's date (UTC midnight). Safe to call multiple times per day —
// the upsert overwrites the existing row with fresher numbers.
//
// Metrics derived from existing OrderLineItem / Order data only:
//   orderCount  — distinct orders that contain this product
//   unitsSold   — sum of quantity across all line items for this product
//   revenue     — sum of (price * quantity - totalDiscount) per line item
//   latestAppliedExecutionId — most recent ContentExecution with status='applied'
// ---------------------------------------------------------------------------
async function captureProductMetricsSnapshot(prisma, productId, phase = 'standalone') {
  const product = await prisma.product.findUnique({
    where:  { id: productId },
    select: { id: true },
  });
  if (!product) throw new Error(`Product not found: ${productId}`);

  // Pull all line items for this product
  const lineItems = await prisma.orderLineItem.findMany({
    where:  { productId },
    select: { orderId: true, quantity: true, price: true, totalDiscount: true },
  });

  const orderCount = new Set(lineItems.map(li => li.orderId)).size;
  const unitsSold  = lineItems.reduce((sum, li) => sum + li.quantity, 0);
  const revenue    = lineItems.reduce(
    (sum, li) => sum + parseFloat(li.price) * li.quantity - parseFloat(li.totalDiscount),
    0
  );

  // Latest applied execution for this product (nullable)
  const latestExecution = await prisma.contentExecution.findFirst({
    where:   { productId, status: 'applied' },
    orderBy: { createdAt: 'desc' },
    select:  { id: true },
  });

  // Normalize to UTC midnight so one row per calendar day
  const snapshotDate = new Date();
  snapshotDate.setUTCHours(0, 0, 0, 0);

  const snapshot = await prisma.productMetricsSnapshot.upsert({
    where:  { productId_snapshotDate_phase: { productId, snapshotDate, phase } },
    update: { orderCount, unitsSold, revenue, latestAppliedExecutionId: latestExecution?.id ?? null },
    create: { productId, snapshotDate, phase, orderCount, unitsSold, revenue, latestAppliedExecutionId: latestExecution?.id ?? null },
  });

  return snapshot;
}

// ---------------------------------------------------------------------------
// captureWindowedBeforeSnapshot
//
// Captures the "before" snapshot for the 7-day impact window.
// Unlike captureProductMetricsSnapshot (all-time cumulative), this counts
// only orders whose Order.createdAt falls within [windowStart, windowEnd).
//
// windowStart = today at UTC midnight - windowDays
// windowEnd   = today at UTC midnight
//
// All orders within the window are included regardless of cancellation status,
// consistent with captureProductMetricsSnapshot.
// The snapshot is upserted so re-running on the same day is safe.
// ---------------------------------------------------------------------------
async function captureWindowedBeforeSnapshot(prisma, productId, windowDays = 7) {
  const product = await prisma.product.findUnique({
    where:  { id: productId },
    select: { id: true },
  });
  if (!product) throw new Error(`Product not found: ${productId}`);

  const windowEnd = new Date();
  windowEnd.setUTCHours(0, 0, 0, 0);
  const windowStart = new Date(windowEnd);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);

  const lineItems = await prisma.orderLineItem.findMany({
    where: {
      productId,
      order: {
        createdAt: { gte: windowStart, lt: windowEnd },
      },
    },
    select: { orderId: true, quantity: true, price: true, totalDiscount: true },
  });

  const orderCount = new Set(lineItems.map(li => li.orderId)).size;
  const unitsSold  = lineItems.reduce((sum, li) => sum + li.quantity, 0);
  const revenue    = lineItems.reduce(
    (sum, li) => sum + parseFloat(li.price) * li.quantity - parseFloat(li.totalDiscount),
    0
  );

  const latestExecution = await prisma.contentExecution.findFirst({
    where:   { productId, status: 'applied' },
    orderBy: { createdAt: 'desc' },
    select:  { id: true },
  });

  const snapshotDate = new Date();
  snapshotDate.setUTCHours(0, 0, 0, 0);

  return prisma.productMetricsSnapshot.upsert({
    where:  { productId_snapshotDate_phase: { productId, snapshotDate, phase: 'before' } },
    update: {
      orderCount, unitsSold, revenue,
      windowStart, windowEnd,
      latestAppliedExecutionId: latestExecution?.id ?? null,
    },
    create: {
      productId, snapshotDate, phase: 'before',
      orderCount, unitsSold, revenue,
      windowStart, windowEnd,
      latestAppliedExecutionId: latestExecution?.id ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// captureWindowedAfterSnapshot
//
// Captures the "after" snapshot for the 7-day impact window.
// Called by the scheduler when afterReadyAt has elapsed.
//
// After window: [applyDate + 1d, applyDate + 8d)
// This is the 7-day block immediately following the apply date, matching
// the same window length as the before-snapshot for a clean comparison.
//
// applyDate is the ContentExecution.createdAt value.
// ---------------------------------------------------------------------------
async function captureWindowedAfterSnapshot(prisma, productId, executionId, applyDate) {
  const product = await prisma.product.findUnique({
    where:  { id: productId },
    select: { id: true },
  });
  if (!product) throw new Error(`Product not found: ${productId}`);

  const windowStart = new Date(applyDate);
  windowStart.setUTCHours(0, 0, 0, 0);
  windowStart.setUTCDate(windowStart.getUTCDate() + 1);

  const windowEnd = new Date(windowStart);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 7);

  const lineItems = await prisma.orderLineItem.findMany({
    where: {
      productId,
      order: {
        createdAt: { gte: windowStart, lt: windowEnd },
      },
    },
    select: { orderId: true, quantity: true, price: true, totalDiscount: true },
  });

  const orderCount = new Set(lineItems.map(li => li.orderId)).size;
  const unitsSold  = lineItems.reduce((sum, li) => sum + li.quantity, 0);
  const revenue    = lineItems.reduce(
    (sum, li) => sum + parseFloat(li.price) * li.quantity - parseFloat(li.totalDiscount),
    0
  );

  const snapshotDate = new Date();
  snapshotDate.setUTCHours(0, 0, 0, 0);

  return prisma.productMetricsSnapshot.upsert({
    where:  { productId_snapshotDate_phase: { productId, snapshotDate, phase: 'after' } },
    update: {
      orderCount, unitsSold, revenue,
      windowStart, windowEnd,
      baselineExecutionId: executionId,
    },
    create: {
      productId, snapshotDate, phase: 'after',
      orderCount, unitsSold, revenue,
      windowStart, windowEnd,
      baselineExecutionId: executionId,
    },
  });
}

// ---------------------------------------------------------------------------
// compareProductMetrics
//
// Fetches the last 2 snapshots for a product and returns a before/after diff.
// Returns { success: false, reason } if fewer than 2 snapshots exist.
// ---------------------------------------------------------------------------
function safePct(before, after) {
  if (before === 0) return null;
  return parseFloat(((after - before) / before * 100).toFixed(2));
}

async function compareProductMetrics(prisma, productId) {
  const snapshots = await prisma.productMetricsSnapshot.findMany({
    where:   { productId },
    orderBy: { snapshotDate: 'desc' },
    take:    2,
  });

  if (snapshots.length < 2) {
    return { success: false, reason: 'not enough data' };
  }

  const after  = snapshots[0];
  const before = snapshots[1];

  const bOrders  = before.orderCount;
  const bUnits   = before.unitsSold;
  const bRevenue = parseFloat(before.revenue);
  const aOrders  = after.orderCount;
  const aUnits   = after.unitsSold;
  const aRevenue = parseFloat(after.revenue);

  return {
    success:   true,
    productId,
    before: {
      snapshotDate: before.snapshotDate,
      orderCount:   bOrders,
      unitsSold:    bUnits,
      revenue:      bRevenue,
    },
    after: {
      snapshotDate: after.snapshotDate,
      orderCount:   aOrders,
      unitsSold:    aUnits,
      revenue:      aRevenue,
    },
    diff: {
      orderCountDiff:          aOrders  - bOrders,
      unitsSoldDiff:           aUnits   - bUnits,
      revenueDiff:             parseFloat((aRevenue - bRevenue).toFixed(2)),
      orderCountChangePercent: safePct(bOrders,  aOrders),
      unitsSoldChangePercent:  safePct(bUnits,   aUnits),
      revenueChangePercent:    safePct(bRevenue, aRevenue),
    },
  };
}

// ---------------------------------------------------------------------------
// captureExecutionSnapshots
//
// Captures a metrics snapshot for a product and links it to a specific
// ContentExecution via baselineExecutionId. Reuses captureProductMetricsSnapshot
// for metric calculation, then stamps the execution link on the row.
// ---------------------------------------------------------------------------
async function captureExecutionSnapshots(prisma, productId, executionId) {
  const execution = await prisma.contentExecution.findUnique({
    where:  { id: executionId },
    select: { id: true, productId: true },
  });
  if (!execution) throw new Error(`ContentExecution not found: ${executionId}`);
  if (execution.productId !== productId) throw new Error(`Execution ${executionId} does not belong to product ${productId}`);

  // Upsert with phase='after' and stamp executionId in one call
  const snapshotDate = new Date();
  snapshotDate.setUTCHours(0, 0, 0, 0);

  const lineItems = await prisma.orderLineItem.findMany({
    where:  { productId },
    select: { orderId: true, quantity: true, price: true, totalDiscount: true },
  });
  const orderCount = new Set(lineItems.map(li => li.orderId)).size;
  const unitsSold  = lineItems.reduce((sum, li) => sum + li.quantity, 0);
  const revenue    = lineItems.reduce(
    (sum, li) => sum + parseFloat(li.price) * li.quantity - parseFloat(li.totalDiscount), 0
  );
  const latestExec = await prisma.contentExecution.findFirst({
    where:   { productId, status: 'applied' },
    orderBy: { createdAt: 'desc' },
    select:  { id: true },
  });

  return prisma.productMetricsSnapshot.upsert({
    where:  { productId_snapshotDate_phase: { productId, snapshotDate, phase: 'after' } },
    update: { orderCount, unitsSold, revenue, latestAppliedExecutionId: latestExec?.id ?? null, baselineExecutionId: executionId },
    create: { productId, snapshotDate, phase: 'after', orderCount, unitsSold, revenue, latestAppliedExecutionId: latestExec?.id ?? null, baselineExecutionId: executionId },
  });
}

// ---------------------------------------------------------------------------
// compareExecutionMetrics
//
// Looks up phase="before" and phase="after" snapshots for a specific executionId.
// Returns { success: false } if either phase is missing.
// ---------------------------------------------------------------------------
async function compareExecutionMetrics(prisma, executionId) {
  const [before, after] = await Promise.all([
    prisma.productMetricsSnapshot.findFirst({ where: { baselineExecutionId: executionId, phase: 'before' } }),
    prisma.productMetricsSnapshot.findFirst({ where: { baselineExecutionId: executionId, phase: 'after'  } }),
  ]);

  if (!before || !after) {
    return { success: false, reason: 'not enough execution-linked snapshots' };
  }

  const bOrders  = before.orderCount;
  const bUnits   = before.unitsSold;
  const bRevenue = parseFloat(before.revenue);
  const aOrders  = after.orderCount;
  const aUnits   = after.unitsSold;
  const aRevenue = parseFloat(after.revenue);

  return {
    success:     true,
    executionId,
    productId:   before.productId,
    before: {
      snapshotDate: before.snapshotDate,
      orderCount:   bOrders,
      unitsSold:    bUnits,
      revenue:      bRevenue,
    },
    after: {
      snapshotDate: after.snapshotDate,
      orderCount:   aOrders,
      unitsSold:    aUnits,
      revenue:      aRevenue,
    },
    diff: {
      orderCountDiff:          aOrders  - bOrders,
      unitsSoldDiff:           aUnits   - bUnits,
      revenueDiff:             parseFloat((aRevenue - bRevenue).toFixed(2)),
      orderCountChangePercent: safePct(bOrders,  aOrders),
      unitsSoldChangePercent:  safePct(bUnits,   aUnits),
      revenueChangePercent:    safePct(bRevenue, aRevenue),
    },
  };
}

// ---------------------------------------------------------------------------
// getExecutionResultsSummary
//
// Business-facing summary for one ContentExecution.
// Delegates metric comparison to compareExecutionMetrics — no new data sources.
// Returns "waiting_for_more_data" when fewer than 2 linked snapshots exist.
// ---------------------------------------------------------------------------
function buildInsight(metric, pct) {
  if (pct === null) return null;
  const direction = pct > 0 ? 'increased' : pct < 0 ? 'decreased' : 'unchanged';
  const absPct    = Math.abs(pct);
  if (pct === 0) return `${metric} was unchanged after this content change.`;
  return `${metric} ${direction} by ${absPct}% after this content change.`;
}

async function getExecutionResultsSummary(prisma, executionId) {
  const execution = await prisma.contentExecution.findUnique({
    where:  { id: executionId },
    select: { id: true, productId: true, issueId: true, status: true },
  });
  if (!execution) return { success: false, reason: 'execution not found' };

  const compare = await compareExecutionMetrics(prisma, executionId);

  if (!compare.success) {
    return {
      success:     true,
      executionId,
      productId:   execution.productId,
      issueId:     execution.issueId,
      status:      'waiting_for_more_data',
      summary:     null,
      insight:     null,
    };
  }

  const { before, after, diff } = compare;

  const summary = {
    orders: {
      before:        before.orderCount,
      after:         after.orderCount,
      diff:          diff.orderCountDiff,
      changePercent: diff.orderCountChangePercent,
    },
    unitsSold: {
      before:        before.unitsSold,
      after:         after.unitsSold,
      diff:          diff.unitsSoldDiff,
      changePercent: diff.unitsSoldChangePercent,
    },
    revenue: {
      before:        before.revenue,
      after:         after.revenue,
      diff:          diff.revenueDiff,
      changePercent: diff.revenueChangePercent,
    },
  };

  // Pick the most meaningful metric for the insight line (revenue first, then units)
  const insight =
    buildInsight('Revenue',    diff.revenueChangePercent)   ??
    buildInsight('Units sold', diff.unitsSoldChangePercent) ??
    buildInsight('Orders',     diff.orderCountChangePercent);

  return {
    success:     true,
    executionId,
    productId:   execution.productId,
    issueId:     execution.issueId,
    status:      'measured',
    summary,
    insight,
  };
}

// ---------------------------------------------------------------------------
// getStoreResultsSummary
//
// Aggregates measured execution results for all applied ContentExecutions
// in one store. Reuses getExecutionResultsSummary per execution — no new data.
// ---------------------------------------------------------------------------
async function getStoreResultsSummary(prisma, shop) {
  const store = await prisma.store.findUnique({
    where:  { shopDomain: shop },
    select: { id: true },
  });
  if (!store) return { success: false, reason: 'store not found' };

  const executions = await prisma.contentExecution.findMany({
    where:  { storeId: store.id, status: 'applied' },
    select: { id: true },
  });

  let measuredExecutions = 0;
  let waitingExecutions  = 0;
  let revenueUpCount     = 0;
  let revenueDownCount   = 0;
  let unitsSoldUpCount   = 0;
  let ordersUpCount      = 0;
  const topWinsCandidates = [];

  for (const { id } of executions) {
    const result = await getExecutionResultsSummary(prisma, id);
    if (!result.success) continue;

    if (result.status === 'waiting_for_more_data') {
      waitingExecutions++;
      continue;
    }

    measuredExecutions++;
    const { summary } = result;

    if ((summary.revenue.changePercent   ?? 0) > 0) revenueUpCount++;
    if ((summary.revenue.changePercent   ?? 0) < 0) revenueDownCount++;
    if ((summary.unitsSold.changePercent ?? 0) > 0) unitsSoldUpCount++;
    if ((summary.orders.changePercent    ?? 0) > 0) ordersUpCount++;

    topWinsCandidates.push({
      executionId:             id,
      productId:               result.productId,
      issueId:                 result.issueId,
      revenueChangePercent:    summary.revenue.changePercent,
      unitsSoldChangePercent:  summary.unitsSold.changePercent,
      ordersChangePercent:     summary.orders.changePercent,
    });
  }

  const topWins = topWinsCandidates
    .sort((a, b) => (b.revenueChangePercent ?? -Infinity) - (a.revenueChangePercent ?? -Infinity))
    .slice(0, 5);

  return {
    success: true,
    shop,
    summary: {
      totalAppliedExecutions: executions.length,
      measuredExecutions,
      waitingExecutions,
      revenueUpCount,
      revenueDownCount,
      unitsSoldUpCount,
      ordersUpCount,
    },
    topWins,
  };
}

// ---------------------------------------------------------------------------
// getStoreExecutionFeed
//
// Dashboard-feed of the 20 most recent ContentExecutions for a store.
// Enriches each execution with result metrics via getExecutionResultsSummary.
// ---------------------------------------------------------------------------
async function getStoreExecutionFeed(prisma, shop) {
  const store = await prisma.store.findUnique({
    where:  { shopDomain: shop },
    select: { id: true },
  });
  if (!store) return { success: false, reason: 'store not found' };

  const executions = await prisma.contentExecution.findMany({
    where:   { storeId: store.id },
    orderBy: { createdAt: 'desc' },
    take:    20,
    select:  { id: true, productId: true, issueId: true, status: true, createdAt: true },
  });

  const items = [];

  for (const exec of executions) {
    const result = exec.status === 'applied'
      ? await getExecutionResultsSummary(prisma, exec.id)
      : null;

    const measured = result?.status === 'measured';

    items.push({
      executionId:            exec.id,
      productId:              exec.productId,
      issueId:                exec.issueId,
      status:                 exec.status,
      createdAt:              exec.createdAt,
      resultStatus:           result?.status ?? null,
      insight:                measured ? result.insight                           : null,
      revenueChangePercent:   measured ? result.summary.revenue.changePercent     : null,
      unitsSoldChangePercent: measured ? result.summary.unitsSold.changePercent   : null,
      ordersChangePercent:    measured ? result.summary.orders.changePercent      : null,
    });
  }

  return { success: true, shop, items };
}

// ---------------------------------------------------------------------------
// getStoreOverview
//
// Single dashboard payload: aggregates + top wins + recent activity feed.
// Pure composition — delegates entirely to existing summary and feed functions.
// ---------------------------------------------------------------------------
async function getStoreOverview(prisma, shop) {
  const [summaryResult, feedResult] = await Promise.all([
    getStoreResultsSummary(prisma, shop),
    getStoreExecutionFeed(prisma, shop),
  ]);

  if (!summaryResult.success) return { success: false, reason: summaryResult.reason };

  return {
    success:        true,
    shop,
    overview:       summaryResult.summary,
    topWins:        summaryResult.topWins.slice(0, 5),
    recentActivity: (feedResult.success ? feedResult.items : []).slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// analyzeExecutionOutcome
//
// Rule-based decision engine for one ContentExecution.
// Delegates entirely to getExecutionResultsSummary — no new data sources.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// getStoreCROSuggestions
//
// Aggregates analyzeExecutionOutcome across all applied executions for a store
// and produces deterministic pattern-level suggestions grouped by issueId.
// ---------------------------------------------------------------------------
async function getStoreCROSuggestions(prisma, shop) {
  const store = await prisma.store.findUnique({
    where:  { shopDomain: shop },
    select: { id: true },
  });
  if (!store) return { success: false, reason: 'store not found' };

  const executions = await prisma.contentExecution.findMany({
    where:  { storeId: store.id, status: 'applied' },
    select: { id: true, issueId: true },
  });

  // Accumulate per-issueId outcome counts
  const byIssue = {};   // issueId → { success, neutral, negative }
  let measuredExecutions  = 0;
  let successfulExecutions = 0;
  let neutralExecutions    = 0;
  let negativeExecutions   = 0;

  for (const { id, issueId } of executions) {
    const outcome = await analyzeExecutionOutcome(prisma, id);
    if (outcome.status === 'pending') continue;   // not enough data — skip

    measuredExecutions++;
    if (!byIssue[issueId]) byIssue[issueId] = { success: 0, neutral: 0, negative: 0 };

    if (outcome.status === 'success')  { byIssue[issueId].success++;  successfulExecutions++; }
    if (outcome.status === 'neutral')  { byIssue[issueId].neutral++;  neutralExecutions++;    }
    if (outcome.status === 'negative') { byIssue[issueId].negative++; negativeExecutions++;   }
  }

  // Apply deterministic rules per issueId
  const suggestions = Object.entries(byIssue).map(([issueId, counts]) => {
    const { success, neutral, negative } = counts;
    let type, recommendation;

    if (success >= 2) {
      type           = 'scale_winner';
      recommendation = 'This change pattern is working. Apply this issue type to more similar products.';
    } else if (success > 0 && negative > 0) {
      type           = 'mixed_pattern';
      recommendation = 'This issue type shows mixed outcomes. Apply only to products with similar positioning and test carefully.';
    } else if (negative >= 2) {
      type           = 'pause_pattern';
      recommendation = 'This issue type is underperforming. Pause broad rollout and test a different messaging approach.';
    } else {
      type           = 'insufficient_signal';
      recommendation = 'More measured executions are needed before scaling this pattern.';
    }

    return { type, issueId, successCount: success, neutralCount: neutral, negativeCount: negative, recommendation };
  });

  return {
    success: true,
    shop,
    summary: { measuredExecutions, successfulExecutions, neutralExecutions, negativeExecutions },
    suggestions,
  };
}

async function analyzeExecutionOutcome(prisma, executionId) {
  const result = await getExecutionResultsSummary(prisma, executionId);

  if (!result.success) {
    return {
      executionId,
      status:         'pending',
      insight:        null,
      recommendation: 'Wait for more data before making changes',
    };
  }

  if (result.status === 'waiting_for_more_data') {
    return {
      executionId,
      status:         'pending',
      insight:        null,
      recommendation: 'Wait for more data before making changes',
    };
  }

  const rev = result.summary.revenue.changePercent ?? 0;

  if (rev > 10) {
    return {
      executionId,
      status:         'success',
      insight:        'This change improved performance',
      recommendation: 'Apply similar structure to other products',
    };
  }

  if (rev < -5) {
    return {
      executionId,
      status:         'negative',
      insight:        'This change hurt performance',
      recommendation: 'Rollback or test alternative messaging',
    };
  }

  return {
    executionId,
    status:         'neutral',
    insight:        'No significant impact detected',
    recommendation: 'Test a stronger variation (headline / offer / benefits)',
  };
}

// ---------------------------------------------------------------------------
// getTopDecisionActions
//
// Decision Engine v1 — ranks every eligible (product × issue) pair in the store
// by a deterministic opportunityScore and returns the top 3.
//
// Scoring inputs (see inline constants):
//   severityScore  — how damaging is the issue?
//   revenueScore   — how much revenue is at stake on this product?
//   effortScore    — how fast can it be fixed?
//   readinessBonus — is it already approved and auto-applicable?
//
// Revenue signal:
//   Primary: latest ProductMetricsSnapshot revenue value.
//   Fallback: computed on-the-fly from OrderLineItem rows when snapshot is
//   missing or zero. No new tables, no background jobs, deterministic.
//
// Eligibility:
//   IN  — active product, non-rejected, non-applied, has a clear CRO fix path
//   OUT — operational blockers that require a business/inventory decision
//         (product_is_draft, all_variants_oos) — these are not CRO opportunities
// ---------------------------------------------------------------------------

const DECISION_SEVERITY_SCORE = { critical: 100, high: 60, medium: 25, low: 10 };
const DECISION_EFFORT_SCORE   = { low: 20, medium: 10, high: 0 };

// Issues excluded from the Decision Engine because they are operational alerts,
// not merchant-actionable CRO opportunities:
//   product_is_draft  — product is not live; content changes have no effect until published
//   all_variants_oos  — requires an inventory/restocking decision, not a conversion fix
const OPERATIONAL_ISSUE_IDS = new Set(['product_is_draft', 'all_variants_oos']);

// Content-related issue IDs that can produce fast, measurable impact within 24–48h.
// These are pure copy/content changes that Shopify applies instantly and shoppers see immediately.
const QUICK_WIN_CONTENT_ISSUE_IDS = new Set([
  'no_description',
  'description_too_short',
  'description_center_aligned',
  'no_risk_reversal',
  'no_social_proof',
  'missing_alt_text',
]);

// Score multiplier applied on top of the base opportunityScore for quick wins.
// Small enough not to invert the revenue/severity hierarchy, large enough to
// surface at least one quick win in the top 2 slots.
const QUICK_WIN_SCORE_BOOST = 0.12;

// An action is a Quick Win when ALL of:
//   1. The issue is a pure content change (copy, formatting, proof — no inventory/dev work)
//   2. canAutoApply = true  → one-click execution, zero friction for the merchant
//   3. The issue is not blocked (reviewStatus !== 'rejected')
//   4. The product has measurable activity (revenue > 0) so the fix can show up in metrics fast
function isQuickWin(action, revenue) {
  return (
    QUICK_WIN_CONTENT_ISSUE_IDS.has(action.issueId) &&
    action.canAutoApply === true &&
    action.reviewStatus !== 'rejected' &&
    revenue > 0
  );
}

function decisionRevenueScore(revenue) {
  if (revenue > 5000) return 40;
  if (revenue > 500)  return 25;
  if (revenue > 0)    return 10;
  return 0;
}

function decisionReadinessBonus(canAutoApply, reviewStatus) {
  if (canAutoApply && reviewStatus === 'approved') return 15;
  if (canAutoApply && reviewStatus === 'pending')  return 5;
  return 0;
}

// Derive a short merchant-facing "why act now" line from scoring context.
function buildWhyNow(action, revenue) {
  if (action.canAutoApply && action.reviewStatus === 'approved') {
    return 'Approved and ready to apply in one click.';
  }
  if (action.severity === 'critical') {
    return 'Critical issue actively blocking conversions on a live product.';
  }
  if (revenue > 5000 && action.severity === 'high') {
    return `High-revenue product (£${Math.round(revenue).toLocaleString()}) with an unresolved high-impact issue.`;
  }
  if (revenue > 0) {
    return `Proven revenue product (£${Math.round(revenue).toLocaleString()}) — fix this before scaling traffic.`;
  }
  if (action.severity === 'high') {
    return 'High-impact conversion issue with a fast, low-effort fix available.';
  }
  return 'Unresolved conversion gap on an active product.';
}

// Surface the most immediately useful action step for the merchant.
function buildRecommendedAction(action) {
  if (action.fix?.action) return action.fix.action;
  if (action.proposedContent) return `Apply generated content fix for "${action.title}".`;
  return action.title;
}

// Impact label — two modes:
//   revenue_informed: label reflects actual revenue at stake
//   signal_only:      label reflects conversion priority, makes no monetary claim
function buildEstimatedImpactLabel(revenue, severity, rankingMode) {
  if (rankingMode === 'revenue_informed') {
    if (revenue > 5000 || severity === 'critical') return 'High revenue opportunity';
    if (revenue > 500  || severity === 'high')     return 'Medium revenue opportunity';
    return 'Low revenue opportunity';
  }
  // signal_only — no fake monetary confidence
  if (severity === 'critical' || severity === 'high') return 'High-priority opportunity';
  if (severity === 'medium')                          return 'Medium-priority opportunity';
  return 'Low-priority opportunity';
}

async function getTopDecisionActions(prisma, shop) {
  const store = await prisma.store.findUnique({
    where:  { shopDomain: shop },
    select: { id: true },
  });
  if (!store) return { success: false, reason: 'store not found' };

  // Only active products are candidates
  const rawProducts = await prisma.product.findMany({
    where:   { storeId: store.id, status: 'active' },
    orderBy: { createdAt: 'desc' },
    take:    50,
    include: PRODUCT_INCLUDE,
  });

  const productIds = rawProducts.map(p => p.id);

  if (productIds.length === 0) {
    return { success: false, reason: 'no active products found for this store' };
  }

  // ── Revenue signal ────────────────────────────────────────────────────────
  // Primary: latest ProductMetricsSnapshot per product.
  const allSnapshots = await prisma.productMetricsSnapshot.findMany({
    where:   { productId: { in: productIds } },
    orderBy: { snapshotDate: 'desc' },
    select:  { productId: true, revenue: true },
  });
  const revenueMap = new Map();
  for (const snap of allSnapshots) {
    if (!revenueMap.has(snap.productId)) {
      revenueMap.set(snap.productId, parseFloat(snap.revenue) || 0);
    }
  }

  // Fallback: for products with no snapshot or zero snapshot revenue,
  // compute directly from OrderLineItem. One batch query, no new schema.
  const needFallback = productIds.filter(id => !revenueMap.has(id) || revenueMap.get(id) === 0);
  if (needFallback.length > 0) {
    const lineItems = await prisma.orderLineItem.findMany({
      where:  { productId: { in: needFallback } },
      select: { productId: true, quantity: true, price: true, totalDiscount: true },
    });
    const fallback = {};
    for (const li of lineItems) {
      fallback[li.productId] = (fallback[li.productId] ?? 0)
        + parseFloat(li.price) * li.quantity
        - parseFloat(li.totalDiscount);
    }
    for (const [id, rev] of Object.entries(fallback)) {
      revenueMap.set(id, rev);
    }
  }

  // Applied executions — exclude already-fixed (product × issue) pairs
  const appliedRows = await prisma.contentExecution.findMany({
    where:  { productId: { in: productIds }, status: 'applied' },
    select: { productId: true, issueId: true },
  });
  const appliedSet = new Set(appliedRows.map(r => `${r.productId}:${r.issueId}`));

  // Completed executions — for executionStatus field in response
  const completedRows = await prisma.contentExecution.findMany({
    where:  { productId: { in: productIds }, status: 'completed' },
    select: { productId: true, issueId: true, createdAt: true },
  });
  const completedMap = new Map(completedRows.map(r => [`${r.productId}:${r.issueId}`, r.createdAt]));

  const candidates = [];

  for (const raw of rawProducts) {
    const actionResult = await getProductActions(raw, { prisma, storeId: store.id });
    const revenue      = revenueMap.get(raw.id) ?? 0;

    for (const action of actionResult.actions) {
      // ── Eligibility gates ────────────────────────────────────────────────
      // Exclude already-fixed pairs
      if (appliedSet.has(`${raw.id}:${action.issueId}`)) continue;
      // Exclude merchant-rejected items
      if (action.reviewStatus === 'rejected') continue;
      // Exclude operational alerts that are not CRO opportunities
      if (OPERATIONAL_ISSUE_IDS.has(action.issueId)) continue;
      // Require a meaningful action path (must have a title and some fix guidance)
      if (!action.title) continue;

      const sScore    = DECISION_SEVERITY_SCORE[action.severity] ?? 0;
      const rScore    = decisionRevenueScore(revenue);
      const eScore    = DECISION_EFFORT_SCORE[action.effort]    ?? 0;
      const rBonus    = decisionReadinessBonus(action.canAutoApply, action.reviewStatus);
      const baseTotal = sScore + rScore + eScore + rBonus;

      const quickWin  = isQuickWin(action, revenue);
      const total     = quickWin ? Math.round(baseTotal * (1 + QUICK_WIN_SCORE_BOOST)) : baseTotal;

      const readyToApply = action.canAutoApply === true && action.reviewStatus === 'approved';

      candidates.push({
        rank:                  0,   // assigned after sort
        opportunityScore:      total,

        productId:             raw.id,
        productTitle:          raw.title,

        issueId:               action.issueId,
        severity:              action.severity,
        revenue:               parseFloat(revenue.toFixed(2)),

        quickWin,
        expectedTimeToImpact:  quickWin ? '24–48h' : '3–7 days',
        earlySignalEligible:   quickWin && revenue > 0,

        readyToApply,
        whyNow:                buildWhyNow(action, revenue),
        recommendedAction:     buildRecommendedAction(action),
        estimatedImpactLabel:  null, // set after rankingMode is determined

        scoreBreakdown: {
          severityScore:  sScore,
          revenueScore:   rScore,
          effortScore:    eScore,
          readinessBonus: rBonus,
        },

        // internal tie-break only — not exposed at top level
        _scoreImpact: action.scoreImpact ?? null,
      });
    }
  }

  if (candidates.length === 0) {
    return { success: false, reason: 'no eligible actions found for this store' };
  }

  // ── Revenue data availability ─────────────────────────────────────────────
  // True when at least one eligible candidate has a real revenue figure > 0.
  // This means order history exists and the revenueScore component is active.
  const revenueDataAvailable = candidates.some(c => c.revenue > 0);

  const rankingMode    = revenueDataAvailable ? 'revenue_informed' : 'signal_only';
  const rankingNotice  = revenueDataAvailable
    ? null
    : 'Revenue data is not available yet, so opportunities are ranked by conversion severity, effort, and readiness.';

  // Rewrite estimatedImpactLabel now that rankingMode is known.
  // (Candidates were built before we could determine the mode.)
  for (const c of candidates) {
    c.estimatedImpactLabel = buildEstimatedImpactLabel(c.revenue, c.severity, rankingMode);
  }

  // Sort: opportunityScore DESC; tie-break: larger |scoreImpact| first
  candidates.sort((a, b) => {
    if (b.opportunityScore !== a.opportunityScore) return b.opportunityScore - a.opportunityScore;
    return Math.abs(b._scoreImpact ?? 0) - Math.abs(a._scoreImpact ?? 0);
  });

  const topActions = candidates.slice(0, 3).map(({ _scoreImpact, ...item }, idx) => {
    const key        = `${item.productId}:${item.issueId}`;
    const executedAt = completedMap.get(key) ?? null;
    return {
      ...item,
      rank:            idx + 1,
      executionStatus: executedAt ? 'completed' : 'pending',
      executedAt,
    };
  });

  return {
    success:       true,
    shop,
    generatedAt:   new Date().toISOString(),
    rankingMode,
    rankingNotice,
    topActions,
  };
}

// ---------------------------------------------------------------------------
// getRevenueDashboard
//
// Aggregates measured ContentExecution results into a single store-level
// revenue impact summary. Delegates all metric comparison to
// getExecutionResultsSummary — no new data sources or tables.
//
// Aggregation rules:
//   totalRevenueImpact   — sum of positive revenueDiff across measured executions
//   revenueGrowthPercent — arithmetic mean of revenueChangePercent (all measured)
//   ordersGrowthPercent  — arithmetic mean of orderCountChangePercent
//   aovChangePercent     — mean of per-execution (after AOV − before AOV) / before AOV
//   productsImproved     — distinct productIds where revenueDiff > 0
//   executionsCount      — total executions with measured (not waiting) status
//   recentImpacts        — last 5 measured executions with non-zero delta, enriched with product title
// ---------------------------------------------------------------------------
async function getRevenueDashboard(prisma, shop) {
  const store = await prisma.store.findUnique({
    where:  { shopDomain: shop },
    select: { id: true },
  });
  if (!store) return { success: false, reason: 'store not found' };

  const executions = await prisma.contentExecution.findMany({
    where:   { storeId: store.id, status: 'applied' },
    select:  { id: true, productId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  const empty = {
    success: true, shop, empty: true,
    totalRevenueImpact: 0, revenueGrowthPercent: null,
    ordersGrowthPercent: null, aovChangePercent: null,
    productsImproved: 0, executionsCount: 0, recentImpacts: [],
  };
  if (executions.length === 0) return empty;

  // Batch-load product titles for the recent impacts list
  const productIds = [...new Set(executions.map(e => e.productId))];
  const products   = await prisma.product.findMany({
    where:  { id: { in: productIds } },
    select: { id: true, title: true },
  });
  const titleMap = new Map(products.map(p => [p.id, p.title]));

  let totalRevenueImpact = 0;
  const revenueChangePcts = [];
  const ordersChangePcts  = [];
  const aovChangePcts     = [];
  const improvedProducts  = new Set();
  let measuredCount       = 0;
  const recentImpactsRaw  = [];

  for (const exec of executions) {
    const result = await getExecutionResultsSummary(prisma, exec.id);
    if (!result.success || result.status !== 'measured' || !result.summary) continue;

    measuredCount++;
    const { revenue, orders } = result.summary;

    if (revenue.diff > 0) {
      totalRevenueImpact += revenue.diff;
      improvedProducts.add(exec.productId);
    }

    if (revenue.changePercent !== null) revenueChangePcts.push(revenue.changePercent);
    if (orders.changePercent  !== null) ordersChangePcts.push(orders.changePercent);

    if (orders.before > 0 && orders.after > 0 && revenue.before > 0) {
      const aovBefore = revenue.before / orders.before;
      const aovAfter  = revenue.after  / orders.after;
      aovChangePcts.push(((aovAfter - aovBefore) / aovBefore) * 100);
    }

    if (revenue.diff !== 0 || orders.diff !== 0) {
      recentImpactsRaw.push({
        productTitle: titleMap.get(exec.productId) ?? 'Unknown product',
        revenueDelta: parseFloat(revenue.diff.toFixed(2)),
        ordersDelta:  orders.diff,
        executedAt:   exec.createdAt,
      });
    }
  }

  if (measuredCount === 0) return empty;

  const avg    = arr => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const r2     = n   => n !== null ? parseFloat(n.toFixed(2)) : null;

  return {
    success:              true,
    shop,
    empty:                false,
    totalRevenueImpact:   parseFloat(totalRevenueImpact.toFixed(2)),
    revenueGrowthPercent: r2(avg(revenueChangePcts)),
    ordersGrowthPercent:  r2(avg(ordersChangePcts)),
    aovChangePercent:     r2(avg(aovChangePcts)),
    productsImproved:     improvedProducts.size,
    executionsCount:      measuredCount,
    recentImpacts:        recentImpactsRaw.slice(0, 5),
  };
}

module.exports = {
  analyzeExecutionOutcome,
  getStoreCROSuggestions,
  captureProductMetricsSnapshot,
  captureWindowedBeforeSnapshot,
  captureWindowedAfterSnapshot,
  compareProductMetrics,
  captureExecutionSnapshots,
  compareExecutionMetrics,
  getExecutionResultsSummary,
  getStoreResultsSummary,
  getStoreExecutionFeed,
  getStoreOverview,
  getTopDecisionActions,
  getRevenueDashboard,
};
