'use strict';

const { getProductActions }           = require('./action-center.service');
const { PRODUCT_INCLUDE }             = require('../lib/product-include');
const { fetchWindowedStoreAnalytics, fetchProductAnalytics } = require('./shopify-admin.service');

// ── Test-order exclusion ─────────────────────────────────────────────────────
// Applied only to merchant-facing proof surfaces (snapshots, attribution,
// decision engine). /debug/order-qa intentionally bypasses these so Internal QA
// can inspect test orders and surface them with explicit warnings.
//
// Matches line-item titles with known test-order suffixes (case-insensitive):
//   -test  _test  -ttest  _ttest
//
// Gate: CRO_EXCLUDE_TEST_ORDERS=false disables exclusion for local testing.
// Default (unset or any other value) keeps exclusion ON — production-safe.
// Prisma silently drops `NOT: undefined`, so callsites need no change.
const _EXCLUDE_TEST_ORDERS = process.env.CRO_EXCLUDE_TEST_ORDERS !== 'false';

const _TEST_LI_TITLE_FILTER = _EXCLUDE_TEST_ORDERS
  ? { OR: ['-test', '_test', '-ttest', '_ttest'].map(f => ({ title: { contains: f, mode: 'insensitive' } })) }
  : undefined;

// For Order-level queries: exclude orders that contain any test line item.
const _TEST_ORDER_FILTER = _EXCLUDE_TEST_ORDERS
  ? { lineItems: { some: _TEST_LI_TITLE_FILTER } }
  : undefined;

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

  // Pull all line items for this product (test orders excluded — see _TEST_LI_TITLE_FILTER)
  const lineItems = await prisma.orderLineItem.findMany({
    where:  { productId, NOT: _TEST_LI_TITLE_FILTER },
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
    select: { id: true, storeId: true, handle: true },
  });
  if (!product) throw new Error(`Product not found: ${productId}`);

  const windowEnd = new Date();
  windowEnd.setUTCHours(0, 0, 0, 0);
  const windowStart = new Date(windowEnd);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);

  const lineItems = await prisma.orderLineItem.findMany({
    where: {
      productId,
      NOT: _TEST_LI_TITLE_FILTER,
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

  // Store-level totals for the same window — used later to compute store AOV before/after.
  // Queries Order directly so product attribution is not required.
  const storeAgg = await prisma.order.aggregate({
    where:  { storeId: product.storeId, createdAt: { gte: windowStart, lt: windowEnd }, NOT: _TEST_ORDER_FILTER },
    _count: { id: true },
    _sum:   { totalPrice: true },
  });
  const storeOrderCount = storeAgg._count.id                        ?? 0;
  const storeRevenue    = parseFloat(storeAgg._sum.totalPrice ?? 0);

  // Store-wide sessions from Shopify Analytics. Null when read_analytics scope is absent or
  // Shopify Analytics returns an error — never blocks snapshot capture.
  const storeObj = await prisma.store.findUnique({
    where:  { id: product.storeId },
    select: { shopDomain: true, accessToken: true },
  });
  const { sessions: storeSessions } = storeObj
    ? await fetchWindowedStoreAnalytics(storeObj, windowStart, windowEnd)
    : { sessions: null };

  const { sessions: productSessions, atcCount: productAtcCount } = storeObj
    ? await fetchProductAnalytics(storeObj, windowStart, windowEnd, product)
    : { sessions: null, atcCount: null };

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
      storeRevenue, storeOrderCount, storeSessions,
      productSessions, productAtcCount,
      latestAppliedExecutionId: latestExecution?.id ?? null,
    },
    create: {
      productId, snapshotDate, phase: 'before',
      orderCount, unitsSold, revenue,
      windowStart, windowEnd,
      storeRevenue, storeOrderCount, storeSessions,
      productSessions, productAtcCount,
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
    select: { id: true, storeId: true, handle: true },
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
      NOT: _TEST_LI_TITLE_FILTER,
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

  const storeAgg = await prisma.order.aggregate({
    where:  { storeId: product.storeId, createdAt: { gte: windowStart, lt: windowEnd }, NOT: _TEST_ORDER_FILTER },
    _count: { id: true },
    _sum:   { totalPrice: true },
  });
  const storeOrderCount = storeAgg._count.id                        ?? 0;
  const storeRevenue    = parseFloat(storeAgg._sum.totalPrice ?? 0);

  const storeObj = await prisma.store.findUnique({
    where:  { id: product.storeId },
    select: { shopDomain: true, accessToken: true },
  });
  const { sessions: storeSessions } = storeObj
    ? await fetchWindowedStoreAnalytics(storeObj, windowStart, windowEnd)
    : { sessions: null };

  const { sessions: productSessions, atcCount: productAtcCount } = storeObj
    ? await fetchProductAnalytics(storeObj, windowStart, windowEnd, product)
    : { sessions: null, atcCount: null };

  const snapshotDate = new Date();
  snapshotDate.setUTCHours(0, 0, 0, 0);

  const afterSnapshot = await prisma.productMetricsSnapshot.upsert({
    where:  { productId_snapshotDate_phase: { productId, snapshotDate, phase: 'after' } },
    update: {
      orderCount, unitsSold, revenue,
      windowStart, windowEnd,
      storeRevenue, storeOrderCount, storeSessions,
      productSessions, productAtcCount,
      baselineExecutionId: executionId,
    },
    create: {
      productId, snapshotDate, phase: 'after',
      orderCount, unitsSold, revenue,
      windowStart, windowEnd,
      storeRevenue, storeOrderCount, storeSessions,
      productSessions, productAtcCount,
      baselineExecutionId: executionId,
    },
  });

  // Lazy backfill: if the linked before snapshot was captured before the store-metrics
  // code was deployed, its storeRevenue/storeOrderCount will be null. Fill them in now
  // using the window dates already stored on that snapshot so the comparison is symmetric.
  const beforeSnap = await prisma.productMetricsSnapshot.findFirst({
    where:  { baselineExecutionId: executionId, phase: 'before', storeRevenue: null, windowStart: { not: null } },
    select: { id: true, windowStart: true, windowEnd: true },
  });
  if (beforeSnap) {
    const beforeAgg = await prisma.order.aggregate({
      where:  { storeId: product.storeId, createdAt: { gte: beforeSnap.windowStart, lt: beforeSnap.windowEnd }, NOT: _TEST_ORDER_FILTER },
      _count: { id: true },
      _sum:   { totalPrice: true },
    });
    await prisma.productMetricsSnapshot.update({
      where: { id: beforeSnap.id },
      data:  {
        storeRevenue:    parseFloat(beforeAgg._sum.totalPrice ?? 0),
        storeOrderCount: beforeAgg._count.id ?? 0,
      },
    });
  }

  return afterSnapshot;
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

function safeAov(revenue, orderCount) {
  if (!orderCount || orderCount === 0) return null;
  return parseFloat((revenue / orderCount).toFixed(2));
}

// CVR expressed as a percentage (e.g. 2.50 = 2.50%). Null when sessions unavailable.
function safeCvr(orderCount, sessions) {
  if (!sessions || sessions === 0) return null;
  return parseFloat((orderCount / sessions * 100).toFixed(4));
}

// Minimum orders required in BOTH the before AND after windows before a win/loss
// outcome label is assigned. Below this threshold, single-product variance is too
// high to distinguish a real lift from noise.
const MIN_ORDERS_PER_WINDOW = 5;

// ATC confidence thresholds — keyed to add-to-cart events per measurement window.
// 20 / 60 / 150 matches the statistical power of 5 / 10 / 30 orders at a
// typical 3–4 % ATC-to-order conversion rate. Used when productAtcCount is
// available from Shopify Analytics; falls back to order thresholds when null.
const MIN_ATC_PER_WINDOW        = 20;   // 'low'    floor
const MIN_ATC_PER_WINDOW_MEDIUM = 60;   // 'medium' floor
const MIN_ATC_PER_WINDOW_HIGH   = 150;  // 'high'   floor

// Minimum distinct sessions that must have seen the changed block before
// confidence is allowed to upgrade above 'insufficient'.
// Only applied when exposureCount is non-null (tracker deployed and returning data).
// Matches MIN_ATC_PER_WINDOW so the gate fires at the same floor as ATC-path 'low'.
const MIN_EXPOSED_SESSIONS = 20;

// Three-tier confidence evaluation:
//   Path A — Shopify Analytics snapshot ATC counts (most plentiful; requires read_analytics)
//   Path B — first-party PdpEvent ATC counts (tracker-based; no scope required)
//   Path C — order counts (ultimate fallback; always available)
//
//  ATC paths (A & B): 'high' ≥ 150 | 'medium' ≥ 60 | 'low' ≥ 20 | 'insufficient'
//  Order path (C):    'high' ≥  30 | 'medium' ≥ 10 | 'low' ≥  5 | 'insufficient'
//
// Path B activates only when at least one window has ≥ 1 first-party ATC event,
// distinguishing zero-observations from tracker-not-loaded.
function deriveConfidence(beforeAtc, afterAtc, beforeFpAtc, afterFpAtc, beforeOrders, afterOrders) {
  // Path A: Shopify Analytics ATC snapshot counts
  if (beforeAtc !== null && beforeAtc !== undefined &&
      afterAtc  !== null && afterAtc  !== undefined) {
    const min = Math.min(beforeAtc, afterAtc);
    if (min >= MIN_ATC_PER_WINDOW_HIGH)   return 'high';
    if (min >= MIN_ATC_PER_WINDOW_MEDIUM) return 'medium';
    if (min >= MIN_ATC_PER_WINDOW)        return 'low';
    return 'insufficient';
  }
  // Path B: first-party PdpEvent ATC counts
  if (beforeFpAtc !== null && afterFpAtc !== null && (beforeFpAtc >= 1 || afterFpAtc >= 1)) {
    const min = Math.min(beforeFpAtc, afterFpAtc);
    if (min >= MIN_ATC_PER_WINDOW_HIGH)   return 'high';
    if (min >= MIN_ATC_PER_WINDOW_MEDIUM) return 'medium';
    if (min >= MIN_ATC_PER_WINDOW)        return 'low';
    return 'insufficient';
  }
  // Path C: order counts
  const min = Math.min(beforeOrders ?? 0, afterOrders ?? 0);
  if (min >= 30) return 'high';
  if (min >= 10) return 'medium';
  if (min >= MIN_ORDERS_PER_WINDOW) return 'low';
  return 'insufficient';
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
    where:  { productId, NOT: _TEST_LI_TITLE_FILTER },
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

  const bStoreOrders   = before.storeOrderCount ?? 0;
  const bStoreRevenue  = parseFloat(before.storeRevenue ?? 0);
  const aStoreOrders   = after.storeOrderCount  ?? 0;
  const aStoreRevenue  = parseFloat(after.storeRevenue  ?? 0);
  const bStoreAov      = safeAov(bStoreRevenue, bStoreOrders);
  const aStoreAov      = safeAov(aStoreRevenue, aStoreOrders);
  const bStoreSessions = before.storeSessions ?? null;
  const aStoreSessions = after.storeSessions  ?? null;
  const bStoreCvr      = safeCvr(bStoreOrders, bStoreSessions);
  const aStoreCvr      = safeCvr(aStoreOrders, aStoreSessions);

  const bProductSessions = before.productSessions ?? null;
  const aProductSessions = after.productSessions  ?? null;
  const bProductAtcCount = before.productAtcCount ?? null;
  const aProductAtcCount = after.productAtcCount  ?? null;
  const bProductCvr      = safeCvr(bOrders, bProductSessions);
  const aProductCvr      = safeCvr(aOrders, aProductSessions);

  return {
    success:     true,
    executionId,
    productId:   before.productId,
    before: {
      snapshotDate:    before.snapshotDate,
      windowStart:     before.windowStart,
      windowEnd:       before.windowEnd,
      orderCount:      bOrders,
      unitsSold:       bUnits,
      revenue:         bRevenue,
      productSessions: bProductSessions,
      productAtcCount: bProductAtcCount,
    },
    after: {
      snapshotDate:    after.snapshotDate,
      windowStart:     after.windowStart,
      windowEnd:       after.windowEnd,
      orderCount:      aOrders,
      unitsSold:       aUnits,
      revenue:         aRevenue,
      productSessions: aProductSessions,
      productAtcCount: aProductAtcCount,
    },
    diff: {
      orderCountDiff:              aOrders  - bOrders,
      unitsSoldDiff:               aUnits   - bUnits,
      revenueDiff:                 parseFloat((aRevenue - bRevenue).toFixed(2)),
      orderCountChangePercent:     safePct(bOrders,  aOrders),
      unitsSoldChangePercent:      safePct(bUnits,   aUnits),
      revenueChangePercent:        safePct(bRevenue, aRevenue),
      productSessionsDiff:         bProductSessions !== null && aProductSessions !== null ? aProductSessions - bProductSessions : null,
      productSessionsChangePercent: safePct(bProductSessions, aProductSessions),
      productAtcCountDiff:         bProductAtcCount !== null && aProductAtcCount !== null ? aProductAtcCount - bProductAtcCount : null,
      productAtcCountChangePercent: safePct(bProductAtcCount, aProductAtcCount),
      productCvrBefore:            bProductCvr,
      productCvrAfter:             aProductCvr,
      productCvrDiff:              bProductCvr !== null && aProductCvr !== null ? parseFloat((aProductCvr - bProductCvr).toFixed(4)) : null,
      productCvrChangePercent:     bProductCvr !== null && aProductCvr !== null ? safePct(bProductCvr, aProductCvr)                  : null,
    },
    store: {
      before: { orderCount: bStoreOrders, revenue: bStoreRevenue, aov: bStoreAov, sessions: bStoreSessions, conversionRate: bStoreCvr },
      after:  { orderCount: aStoreOrders, revenue: aStoreRevenue, aov: aStoreAov, sessions: aStoreSessions, conversionRate: aStoreCvr },
      diff: {
        revenueDiff:             parseFloat((aStoreRevenue - bStoreRevenue).toFixed(2)),
        revenueChangePercent:    safePct(bStoreRevenue, aStoreRevenue),
        orderCountDiff:          aStoreOrders - bStoreOrders,
        orderCountChangePercent: safePct(bStoreOrders,  aStoreOrders),
        aovDiff:                 bStoreAov !== null && aStoreAov !== null ? parseFloat((aStoreAov - bStoreAov).toFixed(2))       : null,
        aovChangePercent:        bStoreAov !== null && aStoreAov !== null ? safePct(bStoreAov, aStoreAov)                        : null,
        sessionsDiff:            bStoreSessions !== null && aStoreSessions !== null ? aStoreSessions - bStoreSessions            : null,
        sessionsChangePercent:   bStoreSessions !== null && aStoreSessions !== null ? safePct(bStoreSessions, aStoreSessions)    : null,
        cvrDiff:                 bStoreCvr !== null && aStoreCvr !== null ? parseFloat((aStoreCvr - bStoreCvr).toFixed(4))       : null,
        cvrChangePercent:        bStoreCvr !== null && aStoreCvr !== null ? safePct(bStoreCvr, aStoreCvr)                        : null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// detectExecutionOverlap
//
// Finds other applied ContentExecutions on the same product whose createdAt
// falls inside the given measurement window. A non-empty result means the
// after-window contains concurrent changes that may confound attribution.
//
// Never throws — returns empty array on any error so it can never block a
// measurement result.
// ---------------------------------------------------------------------------
async function detectExecutionOverlap(prisma, executionId, productId, windowStart, windowEnd) {
  try {
    const rows = await prisma.contentExecution.findMany({
      where: {
        productId,
        id:        { not: executionId },
        status:    'applied',
        createdAt: { gte: windowStart, lt: windowEnd },
      },
      select: { id: true, issueId: true, createdAt: true, status: true },
    });
    return rows.map(r => ({
      executionId: r.id,
      issueId:     r.issueId,
      appliedAt:   r.createdAt,
      status:      r.status,
    }));
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// detectStoreRevenueSpike
//
// Pure — derived from already-fetched before/after comparison data. No query.
// Flags when store revenue in the after-window grew significantly relative to
// the before-window, suggesting a store-wide event (sale, campaign, seasonal
// uplift) that may have inflated product results independent of the content
// change. Returns null when below the threshold or data is insufficient.
// ---------------------------------------------------------------------------
function detectStoreRevenueSpike(beforeRevenue, afterRevenue) {
  if (!beforeRevenue || beforeRevenue < 50) return null;
  const ratio = afterRevenue / beforeRevenue;
  if (ratio > 3.0) return {
    type:     'store_revenue_spike',
    severity: 'high',
    label:    'Large store-wide revenue spike',
    detail:   `Store revenue in the after-window was ${ratio.toFixed(1)}× the before-window — a sale, campaign, or seasonal event may have inflated product results.`,
  };
  if (ratio > 2.0) return {
    type:     'store_revenue_spike',
    severity: 'medium',
    label:    'Store-wide revenue increase',
    detail:   `Store revenue in the after-window was ${ratio.toFixed(1)}× the before-window — a store-wide traffic uplift may have influenced product results.`,
  };
  return null;
}

// ---------------------------------------------------------------------------
// detectProductTrafficSpike
//
// Pure — derived from already-fetched before/after comparison data. No query.
// Flags when product page sessions in the after-window grew significantly,
// suggesting an external traffic source (ad campaign, social post) drove
// extra visitors to this PDP during the measurement window.
// Only fires when Shopify Analytics session data is available (non-null).
// Returns null when sessions are absent or below the noise floor.
// ---------------------------------------------------------------------------
function detectProductTrafficSpike(beforeSessions, afterSessions) {
  if (beforeSessions === null || beforeSessions === undefined) return null;
  if (afterSessions  === null || afterSessions  === undefined) return null;
  if (beforeSessions < 10) return null;
  const ratio = afterSessions / beforeSessions;
  if (ratio > 3.0) return {
    type:     'product_traffic_spike',
    severity: 'high',
    label:    'Product traffic spike',
    detail:   `Product page sessions in the after-window were ${ratio.toFixed(1)}× the before-window — external traffic may have influenced results independently of the content change.`,
  };
  if (ratio > 2.0) return {
    type:     'product_traffic_spike',
    severity: 'medium',
    label:    'Product traffic increase',
    detail:   `Product page sessions in the after-window were ${ratio.toFixed(1)}× the before-window — consider whether a campaign or referral drove this increase.`,
  };
  return null;
}

// ---------------------------------------------------------------------------
// detectInventoryDepletion
//
// Checks current ProductVariant state for this product.
// Flags when variants are out of stock at result-read time, suggesting
// conversion may have been constrained by inventory rather than content
// quality during the measurement window.
// Never throws — returns null on any failure so results always surface.
// ---------------------------------------------------------------------------
async function detectInventoryDepletion(prisma, productId) {
  try {
    const variants = await prisma.productVariant.findMany({
      where:  { productId },
      select: { id: true, availableForSale: true, inventoryQuantity: true },
    });
    if (!variants.length) return null;
    const depleted = variants.filter(
      v => !v.availableForSale || (v.inventoryQuantity !== null && v.inventoryQuantity === 0)
    );
    if (!depleted.length) return null;
    const allDepleted = depleted.length === variants.length;
    return {
      type:     'inventory_depletion',
      severity: allDepleted ? 'high' : 'medium',
      label:    allDepleted ? 'All variants out of stock' : 'Some variants out of stock',
      detail:   allDepleted
        ? 'All product variants are currently out of stock — measurement results may reflect inventory constraints rather than the content change.'
        : `${depleted.length} of ${variants.length} variants are currently out of stock — this may have limited conversion during the measurement window.`,
    };
  } catch (_) {
    return null;
  }
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

// ---------------------------------------------------------------------------
// deriveDecisionSignal
//
// Pure classifier — no DB access, no side effects.
// Returns one of: 'still_measuring' | 'keep' | 'revise' | 'rollback_candidate'
//
// confoundSignals: array of { type, severity } objects from Phase B2 detectors.
// rollback_candidate is suppressed when any confoundSignal has severity='high'
// (in addition to the existing confoundedBy.length === 0 guard).
// ---------------------------------------------------------------------------
function deriveDecisionSignal(resultStatus, confidence, revenueChangePercent, confoundedBy, confoundSignals = []) {
  if (
    resultStatus !== 'measured' ||
    confidence === 'insufficient' ||
    revenueChangePercent === null
  ) return 'still_measuring';

  if (
    (confidence === 'high' || confidence === 'medium') &&
    revenueChangePercent <= -10 &&
    confoundedBy.length === 0 &&
    !confoundSignals.some(s => s.severity === 'high')
  ) return 'rollback_candidate';

  if (revenueChangePercent < 0) return 'revise';

  return 'keep';
}

// ---------------------------------------------------------------------------
// getExecutionExposure
//
// Read-time aggregation of PdpEvent rows for one ContentExecution.
// Window: execution.createdAt → now (block has been live since that moment).
// Never throws — returns null on any failure.
// ---------------------------------------------------------------------------
async function getExecutionExposure(prisma, executionId, productId, windowStart, executionStatus) {
  try {
    // For superseded executions the block was removed at rollback time — cap windowEnd there.
    // For applied (still live) executions windowEnd is now.
    let windowEnd = new Date();
    if (executionStatus === 'superseded') {
      const rollbackRow = await prisma.contentExecution.findFirst({
        where:   { referenceExecutionId: executionId, status: 'rolled_back' },
        select:  { createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
      if (rollbackRow) windowEnd = rollbackRow.createdAt;
    }

    const window = { gte: windowStart, lt: windowEnd };

    const [pdpSessions, exposedRows, blockViewedCount, atcRows, checkoutRows] = await Promise.all([
      prisma.pdpEvent.findMany({
        where:    { productId, event: 'pdp_view',       issuedAt: window },
        select:   { sessionId: true },
        distinct: ['sessionId'],
      }),
      prisma.pdpEvent.findMany({
        where:  { executionId, event: 'block_viewed',   issuedAt: window },
        select: { sessionId: true },
      }),
      prisma.pdpEvent.count({
        where:  { executionId, event: 'block_viewed',   issuedAt: window },
      }),
      prisma.pdpEvent.findMany({
        where:    { productId, event: 'atc_click',      issuedAt: window },
        select:   { sessionId: true },
        distinct: ['sessionId'],
      }),
      prisma.pdpEvent.findMany({
        where:    { productId, event: 'checkout_click', issuedAt: window },
        select:   { sessionId: true },
        distinct: ['sessionId'],
      }),
    ]);

    const pdpSessionCount          = pdpSessions.length;
    const exposedSessions          = new Set(exposedRows.map(r => r.sessionId));
    const exposedSessionCount      = exposedSessions.size;
    const unexposedPdpSessionCount = Math.max(pdpSessionCount - exposedSessionCount, 0);
    const exposureRate             = pdpSessionCount > 0
      ? Math.round((exposedSessionCount / pdpSessionCount) * 10000) / 10000
      : null;

    // ── Funnel comparison ────────────────────────────────────────────────────
    const atcSessionIds      = new Set(atcRows.map(r => r.sessionId));
    const checkoutSessionIds = new Set(checkoutRows.map(r => r.sessionId));

    const unexposedSessionIds = new Set(
      pdpSessions.map(r => r.sessionId).filter(s => !exposedSessions.has(s))
    );

    const rate = (n, d) => d > 0 ? Math.round((n / d) * 10000) / 10000 : null;

    const expAtc      = [...exposedSessions].filter(s => atcSessionIds.has(s)).length;
    const expCheckout = [...exposedSessions].filter(s => checkoutSessionIds.has(s)).length;
    const unxAtc      = [...unexposedSessionIds].filter(s => atcSessionIds.has(s)).length;
    const unxCheckout = [...unexposedSessionIds].filter(s => checkoutSessionIds.has(s)).length;

    const funnel = (exposedSessionCount === 0 && unexposedPdpSessionCount === 0) ? null : {
      exposed: {
        atcSessions:      expAtc,
        checkoutSessions: expCheckout,
        atcRate:          rate(expAtc,      exposedSessionCount),
        checkoutRate:     rate(expCheckout, exposedSessionCount),
      },
      unexposed: {
        atcSessions:      unxAtc,
        checkoutSessions: unxCheckout,
        atcRate:          rate(unxAtc,      unexposedPdpSessionCount),
        checkoutRate:     rate(unxCheckout, unexposedPdpSessionCount),
      },
    };

    return {
      windowStart,
      windowEnd,
      pdpSessionCount,
      exposedSessionCount,
      unexposedPdpSessionCount,
      blockViewedCount,
      exposureRate,
      funnel,
    };
  } catch (err) {
    console.warn('[Metrics] getExecutionExposure failed (non-fatal):', err.message);
    return null;
  }
}

async function getExecutionResultsSummary(prisma, executionId) {
  const execution = await prisma.contentExecution.findUnique({
    where:  { id: executionId },
    select: { id: true, productId: true, issueId: true, status: true, createdAt: true },
  });
  if (!execution) return { success: false, reason: 'execution not found' };

  const [compare, exposure] = await Promise.all([
    compareExecutionMetrics(prisma, executionId),
    getExecutionExposure(prisma, executionId, execution.productId, execution.createdAt, execution.status),
  ]);

  const exposureCount = (exposure?.blockViewedCount ?? 0) > 0 ? (exposure.exposedSessionCount ?? null) : null;
  const exposureRate  = exposure?.exposureRate ?? null;

  if (!compare.success) {
    return {
      success:        true,
      executionId,
      productId:      execution.productId,
      issueId:        execution.issueId,
      status:         'waiting_for_more_data',
      summary:        null,
      store:          null,
      unavailable: {
        storeConversionRate:   'no session data',
        productConversionRate: 'no product-level session data',
      },
      insight:        null,
      exposure,
      exposureCount,
      exposureRate,
      decisionSignal: 'still_measuring',
    };
  }

  const { before, after, diff } = compare;

  // Path B: query first-party ATC counts only when Shopify Analytics ATC is absent
  // from both snapshots. Runs two parallel COUNT queries against PdpEvent using the
  // window boundaries already stored on the snapshots.
  let fpBeforeAtc = null;
  let fpAfterAtc  = null;
  if ((before.productAtcCount === null || before.productAtcCount === undefined) &&
      (after.productAtcCount  === null || after.productAtcCount  === undefined)) {
    if (before.windowStart && before.windowEnd && after.windowStart && after.windowEnd) {
      [fpBeforeAtc, fpAfterAtc] = await Promise.all([
        prisma.pdpEvent.count({
          where: { productId: execution.productId, event: 'atc_click', issuedAt: { gte: before.windowStart, lt: before.windowEnd } },
        }).catch(() => null),
        prisma.pdpEvent.count({
          where: { productId: execution.productId, event: 'atc_click', issuedAt: { gte: after.windowStart,  lt: after.windowEnd  } },
        }).catch(() => null),
      ]);
    }
  }

  const measurementSource =
    (before.productAtcCount !== null && before.productAtcCount !== undefined &&
     after.productAtcCount  !== null && after.productAtcCount  !== undefined)
      ? 'shopify_analytics'
      : (fpBeforeAtc !== null && fpAfterAtc !== null && (fpBeforeAtc >= 1 || fpAfterAtc >= 1))
        ? 'first_party'
        : 'orders';

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

  const sessionsAvailable =
    compare.store?.before?.sessions !== null &&
    compare.store?.before?.sessions !== undefined &&
    compare.store?.after?.sessions  !== null &&
    compare.store?.after?.sessions  !== undefined;

  const productSessionsAvailable =
    compare.before?.productSessions !== null &&
    compare.before?.productSessions !== undefined &&
    compare.after?.productSessions  !== null &&
    compare.after?.productSessions  !== undefined;

  const productSummary = {
    sessions: {
      before:        compare.before.productSessions,
      after:         compare.after.productSessions,
      diff:          compare.diff.productSessionsDiff,
      changePercent: compare.diff.productSessionsChangePercent,
    },
    atcCount: {
      before:        compare.before.productAtcCount,
      after:         compare.after.productAtcCount,
      diff:          compare.diff.productAtcCountDiff,
      changePercent: compare.diff.productAtcCountChangePercent,
    },
    conversionRate: {
      before:        compare.diff.productCvrBefore,
      after:         compare.diff.productCvrAfter,
      diff:          compare.diff.productCvrDiff,
      changePercent: compare.diff.productCvrChangePercent,
    },
  };

  const storeSummary = compare.store ? {
    sessions: {
      before:        compare.store.before.sessions,
      after:         compare.store.after.sessions,
      diff:          compare.store.diff.sessionsDiff,
      changePercent: compare.store.diff.sessionsChangePercent,
    },
    conversionRate: {
      before:        compare.store.before.conversionRate,
      after:         compare.store.after.conversionRate,
      diff:          compare.store.diff.cvrDiff,
      changePercent: compare.store.diff.cvrChangePercent,
    },
    revenue: {
      before:        compare.store.before.revenue,
      after:         compare.store.after.revenue,
      diff:          compare.store.diff.revenueDiff,
      changePercent: compare.store.diff.revenueChangePercent,
    },
    orders: {
      before:        compare.store.before.orderCount,
      after:         compare.store.after.orderCount,
      diff:          compare.store.diff.orderCountDiff,
      changePercent: compare.store.diff.orderCountChangePercent,
    },
    aov: {
      before:        compare.store.before.aov,
      after:         compare.store.after.aov,
      diff:          compare.store.diff.aovDiff,
      changePercent: compare.store.diff.aovChangePercent,
    },
  } : null;

  // Pick the most meaningful metric for the insight line (revenue first, then units)
  const insight =
    buildInsight('Revenue',    diff.revenueChangePercent)   ??
    buildInsight('Units sold', diff.unitsSoldChangePercent) ??
    buildInsight('Orders',     diff.orderCountChangePercent);

  // Run overlap detection and inventory check in parallel — both are non-blocking
  // and never throw, so the result is always available before we build the signal.
  const [confoundedBy, inventoryConfound] = await Promise.all([
    compare.after.windowStart
      ? detectExecutionOverlap(
          prisma,
          executionId,
          execution.productId,
          compare.after.windowStart,
          compare.after.windowEnd,
        )
      : Promise.resolve([]),
    detectInventoryDepletion(prisma, execution.productId),
  ]);

  // Phase B2: derive additional confound signals from already-fetched data.
  // Pure detectors read from the compare object — no additional queries.
  const confoundSignals = [
    detectStoreRevenueSpike(
      parseFloat(compare.store?.before?.revenue ?? 0),
      parseFloat(compare.store?.after?.revenue  ?? 0),
    ),
    detectProductTrafficSpike(
      compare.before.productSessions,
      compare.after.productSessions,
    ),
    inventoryConfound,
  ].filter(Boolean);

  const rawConfidence  = deriveConfidence(
    before.productAtcCount,
    after.productAtcCount,
    fpBeforeAtc,
    fpAfterAtc,
    before.orderCount,
    after.orderCount,
  );
  const confidence     = (exposureCount !== null && exposureCount < MIN_EXPOSED_SESSIONS)
    ? 'insufficient'
    : rawConfidence;
  const decisionSignal = deriveDecisionSignal(
    'measured',
    confidence,
    diff.revenueChangePercent,
    confoundedBy,
    confoundSignals,
  );

  return {
    success:        true,
    executionId,
    productId:      execution.productId,
    issueId:        execution.issueId,
    status:         'measured',
    measurementWindow: {
      before: { start: compare.before.windowStart, end: compare.before.windowEnd },
      after:  { start: compare.after.windowStart,  end: compare.after.windowEnd  },
    },
    summary,
    product:        productSummary,
    store:          storeSummary,
    confidence,
    unavailable: {
      ...(sessionsAvailable       ? {} : { storeConversionRate:   'no session data' }),
      ...(productSessionsAvailable ? {} : { productConversionRate: 'no product-level session data' }),
    },
    insight,
    confoundedBy,
    confoundSignals,
    exposure,
    exposureCount,
    exposureRate,
    decisionSignal,
    measurementSource,
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

  // Batch-load product titles in one query
  const productIds = [...new Set(executions.map(e => e.productId))];
  const products   = await prisma.product.findMany({
    where:  { id: { in: productIds } },
    select: { id: true, title: true },
  });
  const titleMap = new Map(products.map(p => [p.id, p.title]));

  const items = [];

  for (const exec of executions) {
    const result = exec.status === 'applied'
      ? await getExecutionResultsSummary(prisma, exec.id)
      : null;

    const measured = result?.status === 'measured';

    items.push({
      executionId:            exec.id,
      productId:              exec.productId,
      productTitle:           titleMap.get(exec.productId) ?? null,
      issueId:                exec.issueId,
      status:                 exec.status,
      createdAt:              exec.createdAt,
      resultStatus:           result?.status ?? null,
      insight:                measured ? result.insight                           : null,
      revenueChangePercent:   measured ? result.summary.revenue.changePercent     : null,
      unitsSoldChangePercent: measured ? result.summary.unitsSold.changePercent   : null,
      ordersChangePercent:    measured ? result.summary.orders.changePercent      : null,
      // 'high'|'medium'|'low'|'insufficient'|null — gate for measured-lift display
      measurementConfidence:  measured ? result.confidence                        : null,
      decisionSignal:         result?.decisionSignal ?? null,
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
    if (outcome.status === 'pending' || outcome.status === 'insufficient_data') continue;

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

  const confidence = result.confidence ?? deriveConfidence(
    null, null, null, null,
    result.summary.orders.before,
    result.summary.orders.after,
  );
  if (confidence === 'insufficient') {
    return {
      executionId,
      status:         'insufficient_data',
      insight:        `Only ${result.summary.orders.before} order(s) before and ${result.summary.orders.after} after — insufficient data for a reliable result`,
      recommendation: 'Not enough data in this measurement window to draw a reliable conclusion',
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
//   severityScore      — how damaging is the issue?
//   revenueScore       — how much revenue is at stake on this product?
//   effortScore        — how fast can it be fixed?
//   readinessBonus     — is it already approved and auto-applicable?
//   funnelLeakageScore — how severely is the PDP-to-ATC rate underperforming? (Phase B1)
//   productRoleScore   — what share of store revenue does this product represent? (Phase B1)
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

// Minimum first-party pdp_view events in the 14-day lookback window required
// before a product is eligible for a new recommendation.
// Products with zero pdp_view events (tracker not yet deployed) pass through
// unchanged — scored on revenue/severity only, same as today.
const MIN_PDP_VIEWS_FOR_MEASUREMENT = 30;

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

// funnelLeakageScore
// Rewards products where the PDP-to-ATC rate signals visitor friction.
// Only fires when tracker data is reliable (≥30 pdp_view events in 14 days).
// pdpViews = 0 means tracker not yet deployed — score 0, no ranking effect.
function funnelLeakageScore(pdpViews, atcClicks) {
  if (pdpViews < MIN_PDP_VIEWS_FOR_MEASUREMENT) return 0;
  const rate = atcClicks / pdpViews;
  if (rate >= 0.05) return  0;   // healthy — ≥5% ATC rate
  if (rate >= 0.03) return  8;   // below average
  if (rate >= 0.01) return 18;   // poor
  return 25;                     // critical leakage — < 1% ATC rate
}

// productRoleScore
// Rewards products that represent a meaningful share of total store revenue.
// Derived from the in-memory revenueMap — no additional query required.
// storeRevenue = 0 means no order history yet — score 0, no ranking effect.
function productRoleScore(productRevenue, storeRevenue) {
  if (!storeRevenue) return 0;
  const share = productRevenue / storeRevenue;
  if (share >= 0.20) return 15;   // Hero — top revenue contributor
  if (share >= 0.05) return  8;   // Growth — meaningful contributor
  return 0;                       // Tail — minor contributor
}

// Confidence thresholds — mirror phase2-config CONFIDENCE_* constants (inlined to avoid
// cross-service import; keep in sync if phase2-config thresholds are ever tuned).
const CONF_SAMPLE_LOW    = 2;
const CONF_SAMPLE_MEDIUM = 5;
const CONF_SAMPLE_HIGH   = 10;

// computeConfidenceTier
// Pure function. Maps a raw measured-outcome count to a four-level tier.
// "Measured outcome" = a ContentExecution that has a captured after-snapshot,
// scoped to this store's products.
function computeConfidenceTier(n) {
  if (n < CONF_SAMPLE_LOW)    return 'unproven';
  if (n < CONF_SAMPLE_MEDIUM) return 'low';
  if (n < CONF_SAMPLE_HIGH)   return 'medium';
  return 'high';
}

// decisionConfidenceAdjustment
// Pure function. Converts a confidenceTier to a flat score delta applied on top
// of the base opportunityScore. Range is deliberately narrow (−4 to +8) so
// confidence can break ties and influence prioritisation without ever overriding
// the primary severity / revenue / effort signals. Quick-win multiplier is
// applied before this adjustment so it remains independent of that boost.
function decisionConfidenceAdjustment(tier) {
  if (tier === 'high')    return  8;
  if (tier === 'medium')  return  4;
  if (tier === 'low')     return  1;
  if (tier === 'unproven') return -4;
  return 0; // null / unknown — conservative neutral
}

// Derive a short merchant-facing "why act now" line from scoring context.
function buildWhyNow(action, revenue, fScore) {
  if (action.canAutoApply && action.reviewStatus === 'approved') {
    return 'Approved and ready to apply in one click.';
  }
  if (fScore >= 18) {
    return 'Weak PDP-to-ATC rate detected — visitors are landing but not adding to cart. This fix directly addresses the copy or trust gap driving the drop-off.';
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
      where:  { productId: { in: needFallback }, NOT: _TEST_LI_TITLE_FILTER },
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

  // storeRevenue — sum of all active products' revenues for product role classification.
  // Computed in-memory from the fully-built revenueMap. No additional query.
  const storeRevenue = [...revenueMap.values()].reduce((sum, r) => sum + r, 0);

  // Applied executions — exclude already-fixed (product × issue) pairs
  const appliedRows = await prisma.contentExecution.findMany({
    where:  { productId: { in: productIds }, status: 'applied' },
    select: { id: true, productId: true, issueId: true, afterReadyAt: true },
  });
  const appliedSet = new Set(appliedRows.map(r => `${r.productId}:${r.issueId}`));

  // ── Phase 3b: open measurement window signal ──────────────────────────────
  // Products with at least one applied execution whose after-window has not yet
  // closed. Null afterReadyAt rows (legacy) are excluded by the > now check.
  // Map value = latest afterReadyAt across all open windows for that product,
  // so the caller knows the earliest point when applying again is safe.
  const _now = new Date();
  const openWindowMap = new Map(); // productId → latest afterReadyAt
  for (const r of appliedRows) {
    if (r.afterReadyAt && r.afterReadyAt > _now) {
      const existing = openWindowMap.get(r.productId);
      if (!existing || r.afterReadyAt > existing) {
        openWindowMap.set(r.productId, r.afterReadyAt);
      }
    }
  }

  // Completed executions — for executionStatus field in response.
  // A pair is only considered completed if the LATEST relevant execution for that
  // productId+issueId has status 'completed'. A subsequent rolled_back, superseded,
  // or other non-completed row means the pair is actionable again.
  const recentExecRows = await prisma.contentExecution.findMany({
    where:  {
      productId: { in: productIds },
      status: { in: ['completed', 'rolled_back', 'superseded', 'applied', 'failed', 'previewed'] },
    },
    select: { productId: true, issueId: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  const latestByPair = new Map();
  for (const r of recentExecRows) {
    const key = `${r.productId}:${r.issueId}`;
    if (!latestByPair.has(key)) latestByPair.set(key, r);
  }
  const completedMap = new Map();
  for (const [key, r] of latestByPair) {
    if (r.status === 'completed') completedMap.set(key, r.createdAt);
  }

  // ── Phase 2B: ProductPerformanceProfile batch load ────────────────────────
  // One query for all products; first row per productId is the latest (ORDER BY capturedAt DESC).
  const allProfiles = await prisma.productPerformanceProfile.findMany({
    where:   { productId: { in: productIds } },
    orderBy: { capturedAt: 'desc' },
    select:  { productId: true, archetype: true, archetypeConf: true },
  });
  const profileMap = new Map();
  for (const p of allProfiles) {
    if (!profileMap.has(p.productId)) profileMap.set(p.productId, p);
  }

  // ── Phase 2B: pattern confidence via measured outcomes ────────────────────
  // For each (issueId × archetype) pair, count ContentExecution rows that have
  // a captured after-snapshot — the only form of measured lift this system
  // produces. No after-snapshot = not yet measured, regardless of apply count.
  const appliedIdToMeta = new Map(
    appliedRows.map(r => [r.id, { issueId: r.issueId, productId: r.productId }])
  );
  const measuredOutcomeMap = new Map(); // key: `${issueId}_${archetype}` → count
  if (appliedIdToMeta.size > 0) {
    const afterSnapshots = await prisma.productMetricsSnapshot.findMany({
      where:  { baselineExecutionId: { in: [...appliedIdToMeta.keys()] }, phase: 'after' },
      select: { baselineExecutionId: true },
    });
    for (const snap of afterSnapshots) {
      const meta    = appliedIdToMeta.get(snap.baselineExecutionId);
      if (!meta) continue;
      const archKey = profileMap.get(meta.productId)?.archetype ?? 'unclassified';
      const key     = `${meta.issueId}_${archKey}`;
      measuredOutcomeMap.set(key, (measuredOutcomeMap.get(key) ?? 0) + 1);
    }
  }

  // ── Traffic suitability + funnel signal — 14-day first-party PdpEvent counts ──
  // Two groupBy queries run in parallel; never throws so the function degrades
  // gracefully when the pdpEvent table is empty or the tracker is not yet deployed.
  // pdpViewMap  — used for the existing measurement-power gate (unchanged).
  // atcClickMap — new Phase B1 signal; used only for funnelLeakageScore below.
  const _trafficLookback  = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const _pdpEventWhere    = (event) => ({ productId: { in: productIds }, event, issuedAt: { gte: _trafficLookback } });
  let pdpViewMap  = new Map();
  let atcClickMap = new Map();
  try {
    const [pdpViewGroups, atcClickGroups] = await Promise.all([
      prisma.pdpEvent.groupBy({ by: ['productId'], where: _pdpEventWhere('pdp_view'),  _count: { id: true } }),
      prisma.pdpEvent.groupBy({ by: ['productId'], where: _pdpEventWhere('atc_click'), _count: { id: true } }),
    ]);
    pdpViewMap  = new Map(pdpViewGroups.map(r => [r.productId, r._count.id]));
    atcClickMap = new Map(atcClickGroups.map(r => [r.productId, r._count.id]));
  } catch (_) {}

  const candidates = [];

  for (const raw of rawProducts) {
    const profile = profileMap.get(raw.id) ?? null;
    // Gate: traffic_problem products cannot benefit from content CRO — skip entirely.
    // unclassified (no session data) passes through unchanged.
    if (profile?.archetype === 'traffic_problem') continue;
    // Gate: tracker has data for this product but below measurement-power floor.
    // pdpViewCount === 0 means no tracker data — pass through (original behaviour).
    const pdpViewCount = pdpViewMap.get(raw.id) ?? 0;
    if (pdpViewCount > 0 && pdpViewCount < MIN_PDP_VIEWS_FOR_MEASUREMENT) continue;

    const actionResult = await getProductActions(raw, { prisma, storeId: store.id });
    const revenue      = revenueMap.get(raw.id) ?? 0;

    // Phase B1: per-product funnel and role signals — computed once, applied to all actions.
    const atcClicks = atcClickMap.get(raw.id) ?? 0;
    const fScore    = funnelLeakageScore(pdpViewCount, atcClicks);
    const pScore    = productRoleScore(revenue, storeRevenue);

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
      const baseTotal = sScore + rScore + eScore + rBonus + fScore + pScore;

      const quickWin  = isQuickWin(action, revenue);
      const baseScore = quickWin ? Math.round(baseTotal * (1 + QUICK_WIN_SCORE_BOOST)) : baseTotal;

      const readyToApply = action.canAutoApply === true && action.reviewStatus === 'approved';

      const outcomeKey   = `${action.issueId}_${profile?.archetype ?? 'unclassified'}`;
      const outcomeCount = measuredOutcomeMap.get(outcomeKey) ?? 0;
      const confAdj      = decisionConfidenceAdjustment(computeConfidenceTier(outcomeCount));

      const openMeasurementWindow        = openWindowMap.has(raw.id);
      const openMeasurementWindowReadyAt = openWindowMap.get(raw.id) ?? null;
      const openWindowAdj                = openMeasurementWindow ? -25 : 0;
      const total                        = baseScore + confAdj + openWindowAdj;

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
        whyNow:                buildWhyNow(action, revenue, fScore),
        recommendedAction:     buildRecommendedAction(action),
        estimatedImpactLabel:  null, // set after rankingMode is determined

        openMeasurementWindow,
        openMeasurementWindowReadyAt,

        scoreBreakdown: {
          severityScore:       sScore,
          revenueScore:        rScore,
          effortScore:         eScore,
          readinessBonus:      rBonus,
          funnelLeakageScore:  fScore,
          productRoleScore:    pScore,
          confidenceAdj:       confAdj,
          openWindowAdj,
        },

        // internal tie-break only — not exposed at top level
        _scoreImpact: action.scoreImpact ?? null,

        applyType: action.applyType,

        archetype:     profile?.archetype     ?? null,
        archetypeConf: profile?.archetypeConf ?? null,

        confidenceTier:       computeConfidenceTier(outcomeCount),
        confidenceSampleSize: outcomeCount,
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
    productsImproved: 0, executionsCount: 0, measuredCount: 0,
    insufficientDataCount: 0, recentImpacts: [],
  };
  if (executions.length === 0) return empty;

  // Batch-load product titles for the recent impacts list
  const productIds = [...new Set(executions.map(e => e.productId))];
  const products   = await prisma.product.findMany({
    where:  { id: { in: productIds } },
    select: { id: true, title: true },
  });
  const titleMap = new Map(products.map(p => [p.id, p.title]));

  let totalRevenueImpact    = 0;
  const revenueChangePcts   = [];
  const ordersChangePcts    = [];
  const unitsSoldChangePcts = [];
  const aovChangePcts       = [];
  const improvedProducts    = new Set();
  let measuredCount         = 0;
  let insufficientDataCount = 0;
  const recentImpactsRaw    = [];
  const r2 = n => n !== null && n !== undefined ? parseFloat(n.toFixed(2)) : null;

  for (const exec of executions) {
    const result = await getExecutionResultsSummary(prisma, exec.id);
    if (!result.success || result.status !== 'measured' || !result.summary) continue;

    measuredCount++;
    const { revenue, orders, unitsSold } = result.summary;

    if (result.confidence === 'insufficient') {
      insufficientDataCount++;
      continue; // window complete but too few orders — exclude from all aggregates
    }

    totalRevenueImpact += revenue.diff;
    if (revenue.diff > 0) improvedProducts.add(exec.productId);

    if (revenue.changePercent  !== null) revenueChangePcts.push(revenue.changePercent);
    if (orders.changePercent   !== null) ordersChangePcts.push(orders.changePercent);
    if (unitsSold.changePercent !== null) unitsSoldChangePcts.push(unitsSold.changePercent);

    if (orders.before > 0 && orders.after > 0 && revenue.before > 0) {
      const aovBefore = revenue.before / orders.before;
      const aovAfter  = revenue.after  / orders.after;
      aovChangePcts.push(((aovAfter - aovBefore) / aovBefore) * 100);
    }

    if (revenue.diff !== 0 || orders.diff !== 0 || unitsSold.diff !== 0) {
      recentImpactsRaw.push({
        productTitle:  titleMap.get(exec.productId) ?? 'Unknown product',
        revenueDelta:  parseFloat(revenue.diff.toFixed(2)),
        ordersDelta:   orders.diff,
        unitsSoldDelta: unitsSold.diff,
        executedAt:    exec.createdAt,
        roi:           parseFloat(revenue.diff.toFixed(2)),
      });
    }
  }

  if (measuredCount === 0) return empty;

  const avg = arr => arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

  // recentImpacts — chronological (most recent first, capped at 10)
  const recentImpacts = recentImpactsRaw.slice(0, 10);

  // topWins — same items sorted by revenue delta descending, capped at 5
  const topWins = [...recentImpactsRaw]
    .sort((a, b) => b.revenueDelta - a.revenueDelta)
    .slice(0, 5);

  const reliableCount = measuredCount - insufficientDataCount;

  return {
    success:                true,
    shop,
    empty:                  false,
    totalRevenueImpact:     parseFloat(totalRevenueImpact.toFixed(2)),
    revenueGrowthPercent:   r2(avg(revenueChangePcts)),
    ordersGrowthPercent:    r2(avg(ordersChangePcts)),
    unitsSoldGrowthPercent: r2(avg(unitsSoldChangePcts)),
    aovChangePercent:       r2(avg(aovChangePcts)),
    productsImproved:       improvedProducts.size,
    executionsCount:        executions.length,
    measuredCount,
    insufficientDataCount,
    avgRevenuePerExecution: r2(reliableCount > 0 ? totalRevenueImpact / reliableCount : null),
    recentImpacts,
    topWins,
  };
}

// ---------------------------------------------------------------------------
// getAttributedRevenueSummary
//
// Line-item-level attribution layer for the dashboard.
// Splits store revenue into two buckets:
//   improvedProductRevenue — line items where the product had a live applied
//                             execution at the time of the order
//   unattributedRevenue    — all other line items
//
// Attribution rule (all three must hold for a line item to be credited):
//   1. productId is non-null (linked to a known product)
//   2. At least one ContentExecution exists for that productId with
//      status='applied' and createdAt < order.createdAt
//   3. That execution was NOT rolled back before the order
//      (no rolled_back row referencing it with createdAt < order.createdAt)
//
// Double-counting prevention:
//   Each OrderLineItem.id is counted at most once regardless of how many
//   executions exist for the same product.
// ---------------------------------------------------------------------------
async function getAttributedRevenueSummary(prisma, storeId, windowStart, windowEnd) {
  // 1. Load all applied executions for this store
  const appliedExecs = await prisma.contentExecution.findMany({
    where:  { storeId, status: 'applied' },
    select: { id: true, productId: true, createdAt: true },
  });

  // 2. Load all rolled_back rows that reference an applied execution
  const rolledBackExecs = await prisma.contentExecution.findMany({
    where:  { storeId, status: 'rolled_back', referenceExecutionId: { not: null } },
    select: { referenceExecutionId: true, createdAt: true },
  });

  // Map: applied execution id → time it was rolled back
  const rolledBackAt = new Map();
  for (const rb of rolledBackExecs) {
    rolledBackAt.set(rb.referenceExecutionId, rb.createdAt);
  }

  // productId → list of { appliedAt, rolledBackAt (or null) }
  const productHistory = new Map();
  for (const exec of appliedExecs) {
    const rb = rolledBackAt.get(exec.id) ?? null;
    if (!productHistory.has(exec.productId)) productHistory.set(exec.productId, []);
    productHistory.get(exec.productId).push({ appliedAt: exec.createdAt, rolledBackAt: rb });
  }

  // True if product has a live improvement at orderTime
  function isImprovedAt(productId, orderTime) {
    const history = productHistory.get(productId);
    if (!history) return false;
    return history.some(h =>
      h.appliedAt < orderTime &&
      (h.rolledBackAt === null || h.rolledBackAt >= orderTime)
    );
  }

  // 3. Fetch orders in window with line items
  const orders = await prisma.order.findMany({
    where:  { storeId, createdAt: { gte: windowStart, lt: windowEnd }, NOT: _TEST_ORDER_FILTER },
    select: {
      id: true,
      currency: true,
      totalPrice: true,
      createdAt: true,
      lineItems: {
        select: { id: true, productId: true, quantity: true, price: true, totalDiscount: true },
      },
    },
  });

  // 4. Attribute each line item
  let storeRevenue           = 0;
  let improvedProductRevenue = 0;
  let improvedProductUnits   = 0;
  let unattributedRevenue    = 0;
  const improvedOrderIds     = new Set();
  const countedLineItemIds   = new Set(); // prevent any double-count

  for (const order of orders) {
    storeRevenue += parseFloat(order.totalPrice);
    for (const li of order.lineItems) {
      if (countedLineItemIds.has(li.id)) continue;
      countedLineItemIds.add(li.id);
      const lineRevenue = parseFloat(li.price) * li.quantity - parseFloat(li.totalDiscount);
      if (li.productId && isImprovedAt(li.productId, order.createdAt)) {
        improvedProductRevenue += lineRevenue;
        improvedProductUnits  += li.quantity;
        improvedOrderIds.add(order.id);
      } else {
        unattributedRevenue += lineRevenue;
      }
    }
  }

  return {
    windowStart,
    windowEnd,
    currency:               orders[0]?.currency ?? null,
    storeRevenue:           parseFloat(storeRevenue.toFixed(2)),
    storeOrderCount:        orders.length,
    improvedProductRevenue: parseFloat(improvedProductRevenue.toFixed(2)),
    improvedProductOrders:  improvedOrderIds.size,
    improvedProductUnits,
    unattributedRevenue:    parseFloat(unattributedRevenue.toFixed(2)),
  };
}

// ---------------------------------------------------------------------------
// getMonthlyStatement
//
// Rolling-window (default 30 days) revenue statement.
// Only counts executions applied within the window. Delegates all per-execution
// metric comparison to getExecutionResultsSummary — no new data sources.
//
// Aggregation rules mirror getRevenueDashboard:
//   totalRevenueImpact — sum of revenue.diff for executions with confidence ≠ insufficient
//   measuredCount      — windows that completed (confidence may be insufficient)
//   waitingCount       — windows still open (waiting_for_more_data)
//   insufficientDataCount — windows complete but below minimum order threshold
// ---------------------------------------------------------------------------
async function getMonthlyStatement(prisma, shop, windowDays = 30) {
  const store = await prisma.store.findUnique({
    where:  { shopDomain: shop },
    select: { id: true },
  });
  if (!store) return { success: false, reason: 'store not found' };

  const windowEnd = new Date();
  windowEnd.setUTCHours(0, 0, 0, 0);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + 1); // include today
  const windowStart = new Date(windowEnd);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);

  const executions = await prisma.contentExecution.findMany({
    where:   { storeId: store.id, status: 'applied', createdAt: { gte: windowStart } },
    select:  { id: true, productId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  const emptyResult = {
    success: true, shop, windowDays,
    windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(),
    executionsCount: 0, measuredCount: 0, waitingCount: 0,
    insufficientDataCount: 0, totalRevenueImpact: 0, productsImproved: 0, topWins: [],
  };
  if (executions.length === 0) return emptyResult;

  const productIds = [...new Set(executions.map(e => e.productId))];
  const products   = await prisma.product.findMany({
    where:  { id: { in: productIds } },
    select: { id: true, title: true },
  });
  const titleMap = new Map(products.map(p => [p.id, p.title]));

  let totalRevenueImpact    = 0;
  let measuredCount         = 0;
  let waitingCount          = 0;
  let insufficientDataCount = 0;
  const improvedProducts    = new Set();
  const topWinCandidates    = [];

  for (const exec of executions) {
    const result = await getExecutionResultsSummary(prisma, exec.id);
    if (!result.success) continue;

    if (result.status === 'waiting_for_more_data') { waitingCount++; continue; }
    if (result.status !== 'measured' || !result.summary) continue;

    measuredCount++;
    if (result.confidence === 'insufficient') { insufficientDataCount++; continue; }

    const { revenue, orders, unitsSold } = result.summary;
    totalRevenueImpact += revenue.diff;
    if (revenue.diff > 0) improvedProducts.add(exec.productId);

    topWinCandidates.push({
      productTitle:  titleMap.get(exec.productId) ?? 'Unknown product',
      revenueDelta:  parseFloat(revenue.diff.toFixed(2)),
      ordersDelta:   orders.diff,
      unitsSoldDelta: unitsSold.diff,
      executedAt:    exec.createdAt,
    });
  }

  const topWins = [...topWinCandidates]
    .sort((a, b) => b.revenueDelta - a.revenueDelta)
    .slice(0, 3);

  return {
    success:              true,
    shop,
    windowDays,
    windowStart:          windowStart.toISOString(),
    windowEnd:            windowEnd.toISOString(),
    executionsCount:      executions.length,
    measuredCount,
    waitingCount,
    insufficientDataCount,
    totalRevenueImpact:   parseFloat(totalRevenueImpact.toFixed(2)),
    productsImproved:     improvedProducts.size,
    topWins,
  };
}

// ---------------------------------------------------------------------------
// getNewProductsDigest
//
// Returns active products created in the last windowDays that have never had
// a review decision recorded (zero ActionItem rows for that productId).
//
// Detection rule:
//   Product.status = 'active'
//   Product.createdAt >= now - windowDays (UTC midnight boundary)
//   No ActionItem rows exist for (storeId, productId)
//
// Never throws. Returns { success: false } when store is not found.
// ---------------------------------------------------------------------------
async function getNewProductsDigest(prisma, shop, windowDays = 30) {
  const store = await prisma.store.findUnique({
    where:  { shopDomain: shop },
    select: { id: true },
  });
  if (!store) return { success: false, reason: 'store not found' };

  const windowStart = new Date();
  windowStart.setUTCHours(0, 0, 0, 0);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);

  const [newProducts, reviewedItems] = await Promise.all([
    prisma.product.findMany({
      where:   { storeId: store.id, status: 'active', createdAt: { gte: windowStart } },
      select:  { id: true, shopifyProductId: true, title: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.actionItem.findMany({
      where:  { storeId: store.id },
      select: { productId: true },
    }),
  ]);

  const reviewedIds = new Set(reviewedItems.map(r => r.productId));
  const products    = newProducts
    .filter(p => !reviewedIds.has(p.id))
    .map(p => ({
      id:               p.id,
      shopifyProductId: p.shopifyProductId,
      title:            p.title,
      createdAt:        p.createdAt,
    }));

  return {
    success:    true,
    shop,
    windowDays,
    count:      products.length,
    products,
  };
}

// ---------------------------------------------------------------------------
// deriveNextActionLabel — pure, local helper for getMeasurementReadyDigest.
// Maps existing decisionSignal + confidence to a merchant-facing action label.
// Uses only values already produced by deriveDecisionSignal / getExecutionResultsSummary.
// ---------------------------------------------------------------------------
function deriveNextActionLabel(decisionSignal, confidence) {
  if (confidence === 'insufficient') return 'Result ready — review carefully';
  switch (decisionSignal) {
    case 'rollback_candidate': return 'Underperforming — review for rollback';
    case 'revise':             return 'Mixed result — review and revise';
    case 'keep':               return 'Likely winner — review result';
    default:                   return 'Result ready — review carefully';
  }
}

// ---------------------------------------------------------------------------
// getMeasurementReadyDigest
//
// Returns a compact list of applied ContentExecutions whose measurement window
// has recently closed and whose results are ready for merchant review.
//
// Detection rule:
//   ContentExecution.status = 'applied'
//   afterReadyAt <= now  (window has elapsed)
//   afterReadyAt >= now - windowDays  (within the lookback period)
//   getExecutionResultsSummary returns status = 'measured'
//
// Calls getExecutionResultsSummary for each candidate — reuses existing logic
// exactly, no new measurement or decision logic introduced.
//
// Never throws. Returns { success: false } when store is not found.
// ---------------------------------------------------------------------------
async function getMeasurementReadyDigest(prisma, shop, windowDays = 30, limit = 5) {
  const store = await prisma.store.findUnique({
    where:  { shopDomain: shop },
    select: { id: true },
  });
  if (!store) return { success: false, reason: 'store not found' };

  const now         = new Date();
  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);

  // Over-fetch to allow for executions that are not yet measured
  // (scheduler lag between afterReadyAt and after-snapshot capture).
  const executions = await prisma.contentExecution.findMany({
    where: {
      storeId:      store.id,
      status:       'applied',
      afterReadyAt: { lte: now, gte: windowStart },
    },
    select:  { id: true, productId: true, afterReadyAt: true },
    orderBy: { afterReadyAt: 'desc' },
    take:    limit * 3,
  });

  if (executions.length === 0) {
    return { success: true, shop, windowDays, count: 0, items: [] };
  }

  const productIds = [...new Set(executions.map(e => e.productId))];
  const products   = await prisma.product.findMany({
    where:  { id: { in: productIds } },
    select: { id: true, title: true },
  });
  const titleMap = new Map(products.map(p => [p.id, p.title]));

  const items = [];

  for (const exec of executions) {
    if (items.length >= limit) break;

    let result;
    try {
      result = await getExecutionResultsSummary(prisma, exec.id);
    } catch (_) {
      continue;
    }

    if (!result.success || result.status !== 'measured') continue;

    items.push({
      executionId:     exec.id,
      productId:       exec.productId,
      productTitle:    titleMap.get(exec.productId) ?? null,
      afterReadyAt:    exec.afterReadyAt,
      decisionSignal:  result.decisionSignal,
      confidence:      result.confidence,
      revenueDelta:    result.summary?.revenue?.diff != null
                         ? parseFloat(result.summary.revenue.diff.toFixed(2))
                         : null,
      nextActionLabel: deriveNextActionLabel(result.decisionSignal, result.confidence),
    });
  }

  return {
    success:    true,
    shop,
    windowDays,
    count:      items.length,
    items,
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
  getAttributedRevenueSummary,
  getMonthlyStatement,
  getNewProductsDigest,
  getMeasurementReadyDigest,
};
