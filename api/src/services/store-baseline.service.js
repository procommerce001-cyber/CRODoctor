'use strict';

// ---------------------------------------------------------------------------
// store-baseline.service.js  —  Store Baseline Engine, Option A (internal only)
//
// Pure, deterministic, no-I/O store-baseline computation. Given ALREADY-FETCHED
// per-product rows (sessions / views / atc / orders / revenue), it aggregates a
// store-level baseline — "what normal looks like for this store" — with honest
// reliability labelling.
//
// See docs/store-baseline-engine-plan.md. This is OBSERVATION-ONLY: it does NOT
// feed ProductOpportunityScore scoring, does NOT change ranking, and is exposed
// only inside the internal PRODUCT_OPPORTUNITY_DIAGNOSTICS diagnostics flow.
//
// Guarantees:
//   - No I/O: no Prisma, no Shopify, no network, no env, no side effects.
//   - Never mutates inputs.
//   - Missing denominator -> metric is null AND listed in reliability.missingData.
//   - Zero denominator never throws and never yields NaN/Infinity.
//   - Never fabricates sessions/views/atc/orders/revenue.
//   - Baseline may be partial; AOV can be reliable even when CVR/RPV is not.
//   - Deterministic except `generatedAt`, which is injectable via input.now.
// ---------------------------------------------------------------------------

// Default thresholds — tunable later; conservative for "growing Shopify stores".
const DEFAULT_THRESHOLDS = {
  minProductViews: 100, // store-level views/sessions denominator for trustworthy rates
  minOrders: 10,        // orders needed before AOV/CVR are trustworthy
  minDays: 7,           // window maturity
  minProductsWithData: 3, // enough products to form a distribution
};

const RAW_INPUTS = ['sessions', 'productViews', 'atc', 'orders', 'revenue'];

// Finite non-negative number, else null. Never returns NaN/Infinity.
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// Safe rate: null unless numerator is a finite number and denominator > 0.
function computeRate(numerator, denominator, digits = 4) {
  const n = num(numerator);
  const d = num(denominator);
  if (n == null || d == null || d === 0) return null;
  const r = n / d;
  if (!Number.isFinite(r)) return null;
  const f = Math.pow(10, digits);
  return Math.round(r * f) / f;
}

function median(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map(num)
    .filter((v) => v != null)
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  const m = nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  return Math.round(m * 10000) / 10000;
}

// Sum of a field across product rows; null when no product supplied a value.
function sumField(products, field) {
  let sum = 0;
  let seen = false;
  for (const p of products) {
    const v = num(p && p[field]);
    if (v != null) { sum += v; seen = true; }
  }
  return seen ? sum : null;
}

function summarizeBaselineSources(input) {
  if (input && Array.isArray(input.sources) && input.sources.length > 0) {
    return input.sources.slice();
  }
  return []; // caller did not declare a source
}

// Decide reliability level + reasons + which raw inputs are missing.
function classifyBaselineReliability({ sums, sampleSize, thresholds, timeWindow }) {
  const reasons = [];
  const missingData = [];

  for (const key of RAW_INPUTS) {
    const s = sums[key];
    if (s == null || s === 0) missingData.push(key);
  }

  const hasSessions = num(sums.sessions) != null && sums.sessions > 0;
  const hasViews    = num(sums.productViews) != null && sums.productViews > 0;
  const hasOrders   = num(sums.orders) != null && sums.orders > 0;
  const hasRevenue  = num(sums.revenue) != null && sums.revenue > 0;
  const hasDenominator = hasSessions || hasViews;

  const days = timeWindow && num(timeWindow.days) != null ? timeWindow.days : null;

  const enoughProducts = sampleSize.productsWithData >= thresholds.minProductsWithData;
  const enoughTraffic =
    (num(sums.productViews) ?? 0) >= thresholds.minProductViews ||
    (num(sums.sessions) ?? 0) >= thresholds.minProductViews;
  const enoughOrders = (num(sums.orders) ?? 0) >= thresholds.minOrders;
  const enoughDays = days == null ? true : days >= thresholds.minDays;

  if (!enoughProducts) reasons.push(`productsWithData below minProductsWithData (${thresholds.minProductsWithData})`);
  if (!hasDenominator) reasons.push('no session/view denominator — conversion/revenue-per-view not computable');
  if (!hasRevenue) reasons.push('no revenue data — AOV / revenue-per-view / revenue-per-session not computable');
  if (!enoughOrders) reasons.push(`orders below minOrders (${thresholds.minOrders})`);
  if (!enoughTraffic) reasons.push(`traffic below minProductViews (${thresholds.minProductViews})`);
  if (!enoughDays) reasons.push(`window shorter than minDays (${thresholds.minDays})`);

  let level;
  if (!enoughProducts || (!hasDenominator && !hasOrders)) {
    level = 'insufficient';
  } else if (enoughProducts && enoughTraffic && enoughOrders && enoughDays && hasRevenue && hasDenominator) {
    level = 'good';
  } else if (hasDenominator && hasOrders) {
    level = 'usable';
  } else {
    level = 'weak';
  }

  return { level, reasons, missingData };
}

// ---------------------------------------------------------------------------
// buildStoreBaseline(input) → full baseline contract (pure, null-safe).
//
// input = {
//   shop, timeWindow: { start, end, days } | null, now (ISO, injectable),
//   products: [{ sessions, productViews, atc, orders, revenue }], // all nullable
//   sources: string[]?, thresholds: {...}?
// }
// ---------------------------------------------------------------------------
function buildStoreBaseline(input = {}) {
  const shop = (input && input.shop) ?? null;
  const timeWindow = (input && input.timeWindow) || null;
  const generatedAt = (input && input.now) || new Date().toISOString();
  const products = Array.isArray(input && input.products) ? input.products : [];
  const thresholds = { ...DEFAULT_THRESHOLDS, ...((input && input.thresholds) || {}) };

  const sums = {
    sessions:     sumField(products, 'sessions'),
    productViews: sumField(products, 'productViews'),
    atc:          sumField(products, 'atc'),
    orders:       sumField(products, 'orders'),
    revenue:      sumField(products, 'revenue'),
    // Dedicated AOV-only pair — a SAME-WINDOW revenue/orders pair (e.g. one
    // ProductMetricsSnapshot row). Used ONLY for averageOrderValue, never for
    // funnel metrics, so cumulative snapshot data can never contaminate CVR/
    // ATC→purchase (which stay on the rolling-window `orders`/`sessions`/`atc`).
    aovRevenue:   sumField(products, 'aovRevenue'),
    aovOrders:    sumField(products, 'aovOrders'),
  };

  const productsWithData = products.filter((p) =>
    RAW_INPUTS.some((f) => num(p && p[f]) != null && p[f] > 0)
  ).length;
  const productsWithRevenue = products.filter((p) => (num(p && p.revenue) ?? 0) > 0).length;

  const productsWithAovPair = products.filter(
    (p) => (num(p && p.aovRevenue) ?? 0) > 0 && (num(p && p.aovOrders) ?? 0) > 0
  ).length;

  const sampleSize = {
    products: products.length,
    productsWithData,
    productsWithRevenue,
    productsWithAovPair,
    sessions: sums.sessions,
    productViews: sums.productViews,
    atc: sums.atc,
    orders: sums.orders,
    aovRevenue: sums.aovRevenue,
    aovOrders: sums.aovOrders,
  };

  // Store-level metrics are traffic-weighted by construction (ratios of sums).
  // AOV prefers the dedicated same-window AOV pair; falls back to legacy
  // same-window revenue/orders (used by existing unit tests). It NEVER uses the
  // funnel `orders`, and the funnel metrics NEVER use the AOV pair.
  // revenuePerSession / revenuePerProductView deliberately use only `revenue`
  // (the same-window-as-funnel revenue), which is absent in the snapshot-AOV
  // feed — so they stay null rather than mixing a cumulative numerator.
  const averageOrderValue =
    computeRate(sums.aovRevenue, sums.aovOrders, 2) ??
    computeRate(sums.revenue, sums.orders, 2);
  const metrics = {
    averageOrderValue,
    revenuePerSession:     computeRate(sums.revenue, sums.sessions, 4),
    revenuePerProductView: computeRate(sums.revenue, sums.productViews, 4),
    storeConversionRate:   computeRate(sums.orders, sums.sessions, 4),
    productViewToAtcRate:  computeRate(sums.atc, sums.productViews, 4),
    atcToPurchaseRate:     computeRate(sums.orders, sums.atc, 4),
  };

  // Distribution context is per-product (equal-weight) — deliberately distinct
  // from the traffic-weighted store metrics above.
  const perProductRpv = products.map((p) => computeRate(p && p.revenue, p && p.productViews, 4));
  const perProductAtc = products.map((p) =>
    computeRate(p && p.atc, (num(p && p.productViews) != null ? p.productViews : p && p.sessions), 4)
  );
  const distribution = {
    medianRevenuePerView: median(perProductRpv),
    medianAtcRate: median(perProductAtc),
    trafficWeighted: true, // refers to the store-level `metrics` block
  };

  const reliability = {
    ...classifyBaselineReliability({ sums, sampleSize, thresholds, timeWindow }),
    sourcesUsed: summarizeBaselineSources(input),
    confoundersKnown: false, // baseline does not model confounders yet
  };

  // Honest AOV signal: when AOV could not be computed, record which side is
  // missing (no fabricated confidence).
  if (averageOrderValue == null) {
    if (sums.aovRevenue == null && sums.revenue == null && !reliability.missingData.includes('aov_revenue')) {
      reliability.missingData.push('aov_revenue');
    }
    if (sums.aovOrders == null && sums.orders == null && !reliability.missingData.includes('aov_orders')) {
      reliability.missingData.push('aov_orders');
    }
  }

  const notes =
    'Internal observation-only store baseline. Not used for ProductOpportunityScore ' +
    'scoring or any merchant-facing ranking. Metrics without a denominator are null ' +
    'and listed in reliability.missingData; values are never fabricated.';

  return {
    shop,
    timeWindow,
    generatedAt,
    sampleSize,
    metrics,
    distribution,
    thresholds,
    reliability,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Pure assembly helpers — merge already-fetched contexts (profile funnel data)
// with already-fetched ProductMetricsSnapshot rows (AOV-only revenue/orders)
// into rows for buildStoreBaseline. No Prisma / Shopify / network / mutation.
// ---------------------------------------------------------------------------

// Coerce a value that may be a number, numeric string, bigint, or a Prisma
// Decimal-like object (has toString) into a finite, non-negative JS number.
// Anything invalid (NaN, Infinity, negative, non-numeric, null) → null.
function coerceNonNegativeNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (typeof value === 'string') {
    const t = value.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (typeof value === 'object' && typeof value.toString === 'function') {
    const n = Number(value.toString());
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return null;
}

// Pick the latest snapshot per productId. Latest = max snapshotDate; on a tie
// the first-seen row wins (deterministic given a stable input order).
function selectLatestSnapshotsByProductId(snapshots) {
  const map = new Map();
  for (const s of (Array.isArray(snapshots) ? snapshots : [])) {
    if (!s || s.productId == null) continue;
    const prev = map.get(s.productId);
    if (!prev) { map.set(s.productId, s); continue; }
    const cur = new Date(s.snapshotDate ?? 0).getTime();
    const old = new Date(prev.snapshotDate ?? 0).getTime();
    if (Number.isFinite(cur) && cur > old) map.set(s.productId, s);
  }
  return map;
}

// Merge contexts (rawProduct + ProductPerformanceProfile) with snapshots into
// baseline rows. Funnel fields (sessions/atc/orders) come from the profile
// (rolling window). AOV pair (aovRevenue/aovOrders) comes from the latest
// snapshot (cumulative) — kept separate so it can never touch funnel metrics.
// productViews stays null in this PR (PdpEvent deferred). Never mutates inputs.
function assembleStoreBaselineRows(contexts, snapshots, _options = {}) {
  const ctxs = Array.isArray(contexts) ? contexts : [];
  const latest = selectLatestSnapshotsByProductId(snapshots);

  return ctxs.map((c) => {
    const rawProduct = (c && c.rawProduct) || {};
    const profile = (c && c.profile) || null;
    const productId = rawProduct.id ?? null;
    const snap = productId != null ? (latest.get(productId) || null) : null;

    // Funnel-window fields (ProductPerformanceProfile). Left null when absent.
    const sessions = profile ? profile.sessions : null;
    const atc      = profile ? profile.atcCount : null;
    const orders   = profile ? profile.orderCount : null;

    // AOV-only same-source pair (ProductMetricsSnapshot), coerced safely.
    const aovRevenue = snap ? coerceNonNegativeNumber(snap.revenue) : null;
    const aovOrders  = snap ? coerceNonNegativeNumber(snap.orderCount) : null;
    const unitsSold  = snap ? coerceNonNegativeNumber(snap.unitsSold) : null;

    return {
      productId,
      // funnel-window fields
      sessions,
      atc,
      orders,
      // deferred to a later PR — never fabricated here
      productViews: null,
      // AOV-only same-window snapshot pair
      aovRevenue,
      aovOrders,
      unitsSold,
      sourceFlags: {
        hasProfile: !!profile,
        hasSnapshot: !!snap,
        hasSnapshotRevenue: aovRevenue != null,
        hasSnapshotOrders: aovOrders != null,
        hasPdpEvents: false,
      },
      windowLabels: {
        funnel: 'profile_28d',
        aov: 'snapshot_standalone_cumulative',
      },
      snapshotDate: snap ? (snap.snapshotDate ?? null) : null,
    };
  });
}

module.exports = {
  buildStoreBaseline,
  computeRate,
  classifyBaselineReliability,
  summarizeBaselineSources,
  coerceNonNegativeNumber,
  selectLatestSnapshotsByProductId,
  assembleStoreBaselineRows,
  DEFAULT_THRESHOLDS,
};
