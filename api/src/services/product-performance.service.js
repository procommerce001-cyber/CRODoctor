'use strict';

const { classifyArchetype }    = require('./cro/classifyArchetype');
const cfg                      = require('./cro/phase2-config');
const { fetchProductAnalytics } = require('./shopify-admin.service');

// ---------------------------------------------------------------------------
// Test-order exclusion — mirrors the same gate in metrics.service.js.
// Applied to every line-item query so QA orders never skew profiling metrics.
// CRO_EXCLUDE_TEST_ORDERS=false disables exclusion for local testing only.
// Prisma silently drops `NOT: undefined`, so the query shape never changes.
// ---------------------------------------------------------------------------
const _EXCLUDE_TEST_ORDERS = process.env.CRO_EXCLUDE_TEST_ORDERS !== 'false';
const _TEST_LI_TITLE_FILTER = _EXCLUDE_TEST_ORDERS
  ? { OR: ['-test', '_test', '-ttest', '_ttest'].map(f => ({ title: { contains: f, mode: 'insensitive' } })) }
  : undefined;

// ---------------------------------------------------------------------------
// Traffic source bucketing constants
// ---------------------------------------------------------------------------
const SOCIAL_DOMAINS = ['facebook.com', 'instagram.com', 'tiktok.com', 'pinterest.com', 'twitter.com', 'x.com'];
const SEARCH_DOMAINS = ['google.com', 'bing.com', 'yahoo.com', 'duckduckgo.com', 'baidu.com', 'yandex.com'];

// ---------------------------------------------------------------------------
// _bucketTrafficSource — pure, no I/O.
// Maps one order's landing + referring URLs to a single traffic bucket.
// Only called for orders where at least one field is non-null.
// ---------------------------------------------------------------------------
function _bucketTrafficSource(landingSite, referringSite) {
  const landing    = (landingSite   || '').toLowerCase();
  const referring  = (referringSite || '').toLowerCase();

  // Paid signals in the landing URL query string
  if (/[?&]utm_medium=(cpc|paid|paidsearch|ppc)/i.test(landing)) return 'paid';
  if (/[?&](gclid|msclkid|fbclid)=/i.test(landing))              return 'paid';

  // Social referrers
  if (SOCIAL_DOMAINS.some(d => referring.includes(d))) return 'social';

  // Organic search referrers
  if (SEARCH_DOMAINS.some(d => referring.includes(d))) return 'organic';

  // Navigated directly to the store URL — has a landing page but no referrer
  if (!referring && landing) return 'direct';

  return 'other';
}

// ---------------------------------------------------------------------------
// _computeOrderMetrics — all DB reads for one product window.
// Returns a plain object of computed signals; never writes to DB.
// ---------------------------------------------------------------------------
async function _computeOrderMetrics(prisma, product, windowStart, windowEnd) {
  const lineItems = await prisma.orderLineItem.findMany({
    where: {
      productId: product.id,
      NOT:       _TEST_LI_TITLE_FILTER,
      order: {
        cancelledAt: null,
        createdAt:   { gte: windowStart, lt: windowEnd },
      },
    },
    select: { orderId: true, variantId: true, quantity: true },
  });

  if (!lineItems.length) {
    return {
      orderCount:     0,
      refundCount:    0,
      refundRate:     null,
      variantSkewPct: null,
      variantOrdersN: 0,
      trafficOrganic: 0,
      trafficPaid:    0,
      trafficSocial:  0,
      trafficDirect:  0,
      trafficOther:   0,
      trafficOrdersN: 0,
    };
  }

  const orderIds = [...new Set(lineItems.map(li => li.orderId))];

  const orders = await prisma.order.findMany({
    where:  { id: { in: orderIds } },
    select: { id: true, financialStatus: true, landingSite: true, referringSite: true },
  });

  const orderCount = orders.length;

  // Refund metrics
  const refundedStatuses = new Set(['refunded', 'partially_refunded']);
  const refundCount      = orders.filter(o => refundedStatuses.has(o.financialStatus)).length;
  const refundRate       = orderCount >= cfg.REFUND_MIN_ORDERS
    ? refundCount / orderCount
    : null;

  // Variant skew — fraction of orders containing the cheapest variant
  const variants = await prisma.productVariant.findMany({
    where:  { productId: product.id },
    select: { id: true, price: true },
  });

  let variantSkewPct = null;
  const liWithVariant  = lineItems.filter(li => li.variantId !== null);
  const variantOrderIds = new Set(liWithVariant.map(li => li.orderId));
  const variantOrdersN  = variantOrderIds.size;

  if (variants.length > 0 && variantOrdersN > 0) {
    const cheapestId = variants
      .slice()
      .sort((a, b) => parseFloat(a.price) - parseFloat(b.price))[0].id;

    const cheapestOrderCount = new Set(
      liWithVariant.filter(li => li.variantId === cheapestId).map(li => li.orderId)
    ).size;

    variantSkewPct = cheapestOrderCount / variantOrdersN;
  }

  // Traffic source breakdown — only orders with at least one attributable field
  const attributable   = orders.filter(o => o.landingSite || o.referringSite);
  const trafficOrdersN = attributable.length;
  const buckets        = { organic: 0, paid: 0, social: 0, direct: 0, other: 0 };
  for (const o of attributable) {
    buckets[_bucketTrafficSource(o.landingSite, o.referringSite)]++;
  }

  const frac = trafficOrdersN > 0 ? trafficOrdersN : 1; // avoid /0; fractions stay 0 when no data
  return {
    orderCount,
    refundCount,
    refundRate,
    variantSkewPct,
    variantOrdersN,
    trafficOrganic: buckets.organic / frac,
    trafficPaid:    buckets.paid    / frac,
    trafficSocial:  buckets.social  / frac,
    trafficDirect:  buckets.direct  / frac,
    trafficOther:   buckets.other   / frac,
    trafficOrdersN,
  };
}

// ---------------------------------------------------------------------------
// getLatestProductPerformanceProfile
// Returns the most recent profile row for a product, or null if none exists.
// ---------------------------------------------------------------------------
async function getLatestProductPerformanceProfile(prisma, productId) {
  return prisma.productPerformanceProfile.findFirst({
    where:   { productId },
    orderBy: { capturedAt: 'desc' },
  });
}

// ---------------------------------------------------------------------------
// captureProductPerformanceProfile
//
// Computes and upserts a fresh ProductPerformanceProfile for one product.
//
// opts.windowDays — rolling window length (default: cfg.PROFILE_WINDOW_DAYS = 28)
// opts.capturedAt — capture timestamp (default: now). Pass a day-truncated UTC
//                   Date for one-per-day scheduler semantics.
//
// sessions / atcCount / atcRate are null until a product-level analytics
// helper is available. classifyArchetype handles sessions=null via Gate 0.
// ---------------------------------------------------------------------------
async function captureProductPerformanceProfile(prisma, productId, opts = {}) {
  const windowDays  = opts.windowDays ?? cfg.PROFILE_WINDOW_DAYS;
  const capturedAt  = opts.capturedAt  ?? new Date();
  const windowEnd   = new Date(capturedAt);
  const windowStart = new Date(capturedAt);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDays);

  const product = await prisma.product.findUniqueOrThrow({
    where:  { id: productId },
    select: { id: true, storeId: true, handle: true },
  });

  const store = await prisma.store.findUniqueOrThrow({
    where:  { id: product.storeId },
    select: { shopDomain: true, accessToken: true },
  });

  const previous          = await getLatestProductPerformanceProfile(prisma, productId);
  const previousArchetype = previous?.archetype ?? null;

  const metrics = await _computeOrderMetrics(prisma, product, windowStart, windowEnd);

  // trafficQualified: null when no attributable orders exist (unknown traffic source)
  let trafficQualified = null;
  if (metrics.trafficOrdersN > 0) {
    trafficQualified =
      (metrics.trafficOrganic + metrics.trafficDirect) >= cfg.QUALIFIED_TRAFFIC_THRESHOLD;
  }

  // Fetch product-level page analytics; falls back to all-null when unavailable.
  // classifyArchetype receives sessions=null → Gate 0 when analytics cannot be read.
  const { sessions, atcCount, atcRate } = await fetchProductAnalytics(
    store, windowStart, windowEnd, product
  );

  const { archetype, archetypeConf, archetypeSignals, dataGaps } = classifyArchetype({
    sessions,
    atcRate,
    orderCount:       metrics.orderCount,
    refundRate:       metrics.refundRate,
    variantSkewPct:   metrics.variantSkewPct,
    trafficQualified,
    previousArchetype,
  });

  const profileData = {
    windowDays, windowStart, windowEnd,
    sessions, atcCount, atcRate,
    trafficOrganic: metrics.trafficOrganic,
    trafficPaid:    metrics.trafficPaid,
    trafficSocial:  metrics.trafficSocial,
    trafficDirect:  metrics.trafficDirect,
    trafficOther:   metrics.trafficOther,
    trafficOrdersN: metrics.trafficOrdersN,
    orderCount:     metrics.orderCount,
    refundCount:    metrics.refundCount,
    refundRate:     metrics.refundRate,
    variantSkewPct: metrics.variantSkewPct,
    variantOrdersN: metrics.variantOrdersN,
    archetype, archetypeConf, archetypeSignals, dataGaps,
  };

  return prisma.productPerformanceProfile.upsert({
    where:  { productId_capturedAt: { productId, capturedAt } },
    update: profileData,
    create: { productId, storeId: product.storeId, capturedAt, ...profileData },
  });
}

module.exports = {
  captureProductPerformanceProfile,
  getLatestProductPerformanceProfile,
};
