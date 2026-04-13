'use strict';

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

module.exports = {
  captureProductMetricsSnapshot,
  compareProductMetrics,
  captureExecutionSnapshots,
  compareExecutionMetrics,
  getExecutionResultsSummary,
  getStoreResultsSummary,
  getStoreExecutionFeed,
  getStoreOverview,
};
