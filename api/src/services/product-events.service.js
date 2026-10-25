'use strict';

// ---------------------------------------------------------------------------
// product-events.service.js  —  Web Pixel product events → product funnel
//
// Pure, deterministic, no-I/O processing of Shopify Web Pixel customer events
// (product_viewed, product_added_to_cart, checkout_completed) into per-product
// measurement windows that ProductOpportunityScore can consume.
//
//   normalizeProductEvents(envelopes, storeContext) → { facts, rejected, stats }
//   aggregateProductEvents(facts, window)           → store + per-product measurement
//   toScoringFunnels(aggregate)                     → POS-compatible funnel per product
//
// Measurement contract (never mixed with other sources or units):
//   - source 'web_pixel', unit 'viewer_day': one pseudonymous visitor on one
//     store-local calendar day (UTC when the store time zone is unknown). It is
//     NOT a Shopify session; one event is never one session.
//   - cohort 'same_day_after_view': ATC and purchases count only when they
//     happen on the same viewer-day AT OR AFTER that day's first view. Rates
//     are therefore same-day, view-anchored proxies — not session CVR, not
//     multi-day cohort conversion and not confirmed-order conversion. A view
//     today and a purchase tomorrow is reported as outside the cohort.
//   - viewDays     = viewer-days with a product_viewed for the product.
//   - atcDays      = those viewer-days with an ATC at/after the first view.
//   - purchaseDays = those viewer-days with a completed checkout containing the
//     product at/after the first view. Pixel checkouts are observations only;
//     Admin orders/revenue are never added to them. Admin order refs are used
//     solely to measure how much of the store's checkout volume the pixel saw.
//
// Guarantees:
//   - No I/O: no Prisma, no Shopify, no network, no env, no clock (time comes
//     from envelope.receivedAt and the window), no side effects.
//   - Never mutates inputs. Raw browser identifiers are never read or copied:
//     callers pass an already-pseudonymized visitorKey.
//   - Unknown stays null; data-quality problems are explicit flags. No
//     confidence level is assigned here — scoring decides from the evidence.
// ---------------------------------------------------------------------------

const MEASUREMENT_SOURCE = 'web_pixel';
const MEASUREMENT_UNIT = 'viewer_day';
const MEASUREMENT_COHORT = 'same_day_after_view';

const EVENT_KINDS = {
  product_viewed: 'view',
  product_added_to_cart: 'atc',
  checkout_completed: 'purchase',
};

const DEFAULTS = {
  maxIdLength: 256,
  maxFutureSkewMs: 5 * 60 * 1000,      // client clock ahead of receipt
  maxAgeMs: 72 * 60 * 60 * 1000,       // retried/replayed events older than this are dropped
  maxQuantity: 10000,
  maxFactsPerVisitorDay: 500,          // above this a viewer-day is treated as automated
  minCoverageDays: 7,
};

const DAY_MS = 24 * 60 * 60 * 1000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round4 = (v) => Math.round(v * 10000) / 10000;

function boundedString(v, max) {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
}

function toTime(v) {
  if (v == null || v === '') return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

// Numeric Shopify id from a plain id or a gid of one of the allowed types.
// Returns { id } on success, { missing: true } or { invalid: true } otherwise.
function parseShopifyId(value, types) {
  if (value == null || value === '') return { missing: true };
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? { id: String(value) } : { invalid: true };
  }
  if (typeof value !== 'string' || value.length > DEFAULTS.maxIdLength) return { invalid: true };
  if (/^[1-9]\d*$/.test(value)) return { id: value };
  const m = /^gid:\/\/shopify\/([A-Za-z]+)\/([1-9]\d*)$/.exec(value);
  return m && types.includes(m[1]) ? { id: m[2] } : { invalid: true };
}

function productLookup(storeContext) {
  const entries = storeContext.products instanceof Map
    ? [...storeContext.products.entries()]
    : Object.entries(storeContext.products || {});
  const map = new Map();
  for (const [shopifyProductId, p] of entries) {
    if (!p || p.productId == null) continue;
    map.set(String(shopifyProductId), {
      productId: p.productId,
      variantIds: new Set([...(p.variantIds || [])].map(String)),
    });
  }
  return map;
}

// Resolve product + optional variant against this store's catalog.
function resolveMerchandise(productValue, variantValue, products) {
  const pid = parseShopifyId(productValue, ['Product']);
  if (pid.missing) return { reason: 'missing_product_id' };
  if (pid.invalid) return { reason: 'invalid_product_id' };
  const product = products.get(pid.id);
  if (!product) return { reason: 'unknown_product' };

  const vid = parseShopifyId(variantValue, ['ProductVariant']);
  if (vid.invalid) return { reason: 'invalid_variant_id' };
  if (vid.id && !product.variantIds.has(vid.id)) return { reason: 'variant_product_mismatch' };
  return { productId: product.productId, shopifyProductId: pid.id, variantId: vid.id || null };
}

function validQuantity(q, max) {
  return Number.isInteger(q) && q >= 1 && q <= max;
}

// Checkout references: the order id and/or the checkout token. Either one
// identifies the same checkout, so both are used for de-duplication.
function checkoutRefsOf(checkout) {
  const order = parseShopifyId(checkout.order && checkout.order.id, ['Order', 'OrderIdentity']);
  const token = boundedString(checkout.token, DEFAULTS.maxIdLength);
  return {
    orderRef: order.id ? `order:${order.id}` : null,
    tokenRef: token ? `token:${token}` : null,
  };
}

// Calendar-day key in the store's time zone (YYYY-MM-DD), or UTC when unknown.
function dayKeyFn(timeZone) {
  if (timeZone == null) return (t) => new Date(t).toISOString().slice(0, 10);
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch (_) {
    throw new TypeError(`normalizeProductEvents: invalid storeContext.timeZone "${timeZone}"`);
  }
  return (t) => fmt.format(new Date(t));
}

// ---------------------------------------------------------------------------
// normalizeProductEvents(envelopes, storeContext, options?)
//
// envelope = {
//   shop:             '<store>.myshopify.com' the event was received for,
//   receivedAt:       server receipt time (ISO or ms),
//   visitorKey:       pseudonymous visitor key derived by the caller (never the
//                     raw clientId),
//   analyticsAllowed: true only when the visitor allowed analytics processing,
//   event:            the Web Pixel event ({ id, name, timestamp, data }).
// }
// storeContext = {
//   storeId, shopDomain, active,
//   timeZone: optional IANA zone of the store (day boundaries); UTC if absent,
//   products: Map|object shopifyProductId → { productId, variantIds[] },
// }
//
// Returns { facts[], rejected[{ eventId, reason, line? }], stats }.
// A checkout_completed yields one purchase fact per product in the order.
// ---------------------------------------------------------------------------
function normalizeProductEvents(envelopes, storeContext, options = {}) {
  if (!isObj(storeContext) || !storeContext.storeId || !storeContext.shopDomain) {
    throw new TypeError('normalizeProductEvents: storeContext.storeId and shopDomain are required');
  }
  const cfg = { ...DEFAULTS, ...options };
  const list = Array.isArray(envelopes) ? envelopes : [];
  const shopDomain = String(storeContext.shopDomain).toLowerCase();
  const products = productLookup(storeContext);
  const dayKey = dayKeyFn(storeContext.timeZone);
  const dayBasis = storeContext.timeZone || 'UTC';

  const facts = [];
  const rejected = [];
  const seenEventIds = new Set();
  // One group per checkout, reachable through any of its refs. The group's
  // ref is the order id once known (upgraded from a token-only first event).
  const checkoutByRef = new Map();
  let duplicates = 0;

  const reject = (eventId, reason, extra) => rejected.push({ eventId: eventId ?? null, reason, ...(extra || {}) });

  for (const env of list) {
    if (!isObj(env) || !isObj(env.event)) { reject(null, 'malformed_envelope'); continue; }
    const ev = env.event;
    const eventId = boundedString(ev.id, cfg.maxIdLength);

    if (typeof env.shop !== 'string' || env.shop.toLowerCase() !== shopDomain) { reject(eventId, 'store_mismatch'); continue; }
    if (storeContext.active !== true) { reject(eventId, 'store_inactive'); continue; }
    if (env.analyticsAllowed !== true) { reject(eventId, 'no_analytics_consent'); continue; }
    if (!eventId) { reject(null, 'missing_event_id'); continue; }

    const kind = EVENT_KINDS[ev.name];
    if (!kind) { reject(eventId, 'unsupported_event'); continue; }

    const visitorKey = boundedString(env.visitorKey, cfg.maxIdLength);
    if (!visitorKey) { reject(eventId, 'missing_visitor_key'); continue; }

    const occurredAt = toTime(ev.timestamp);
    const receivedAt = toTime(env.receivedAt);
    if (occurredAt == null || receivedAt == null) { reject(eventId, 'invalid_timestamp'); continue; }
    if (occurredAt - receivedAt > cfg.maxFutureSkewMs) { reject(eventId, 'timestamp_in_future'); continue; }
    if (receivedAt - occurredAt > cfg.maxAgeMs) { reject(eventId, 'timestamp_too_old'); continue; }

    if (seenEventIds.has(eventId)) { duplicates += 1; reject(eventId, 'duplicate_event'); continue; }
    seenEventIds.add(eventId);

    const base = {
      storeId: storeContext.storeId,
      eventId,
      visitorKey,
      day: dayKey(occurredAt),
      dayBasis,
      occurredAt: new Date(occurredAt).toISOString(),
    };
    const data = isObj(ev.data) ? ev.data : {};

    if (kind === 'view') {
      const pv = isObj(data.productVariant) ? data.productVariant : {};
      const m = resolveMerchandise(pv.product && pv.product.id, pv.id, products);
      if (m.reason) { reject(eventId, m.reason); continue; }
      facts.push({ ...base, kind, productId: m.productId, shopifyProductId: m.shopifyProductId, variantId: m.variantId });
      continue;
    }

    if (kind === 'atc') {
      const line = isObj(data.cartLine) ? data.cartLine : null;
      if (!line) { reject(eventId, 'missing_cart_line'); continue; }
      const merch = isObj(line.merchandise) ? line.merchandise : {};
      const m = resolveMerchandise(merch.product && merch.product.id, merch.id, products);
      if (m.reason) { reject(eventId, m.reason); continue; }
      if (!validQuantity(line.quantity, cfg.maxQuantity)) { reject(eventId, 'invalid_quantity'); continue; }
      facts.push({ ...base, kind, productId: m.productId, shopifyProductId: m.shopifyProductId, variantId: m.variantId, quantity: line.quantity });
      continue;
    }

    // purchase (checkout_completed)
    const checkout = isObj(data.checkout) ? data.checkout : null;
    if (!checkout) { reject(eventId, 'missing_checkout'); continue; }
    const { orderRef, tokenRef } = checkoutRefsOf(checkout);
    if (!orderRef && !tokenRef) { reject(eventId, 'missing_order_ref'); continue; }
    const lines = Array.isArray(checkout.lineItems) ? checkout.lineItems : [];
    if (lines.length === 0) { reject(eventId, 'missing_line_items'); continue; }

    // One fact per product per order; quantities of several lines are summed.
    const byProduct = new Map();
    lines.forEach((li, i) => {
      const variant = isObj(li) && isObj(li.variant) ? li.variant : {};
      const m = resolveMerchandise(variant.product && variant.product.id, variant.id, products);
      if (m.reason) { reject(eventId, m.reason, { line: i }); return; }
      if (!validQuantity(li.quantity, cfg.maxQuantity)) { reject(eventId, 'invalid_quantity', { line: i }); return; }
      const prev = byProduct.get(m.productId);
      if (prev) prev.quantity += li.quantity;
      else byProduct.set(m.productId, { ...base, kind, productId: m.productId, shopifyProductId: m.shopifyProductId, variantId: m.variantId, quantity: li.quantity });
    });

    let group = (orderRef && checkoutByRef.get(orderRef)) || (tokenRef && checkoutByRef.get(tokenRef));
    if (!group) group = { ref: orderRef || tokenRef, facts: [], productIds: new Set() };
    if (orderRef && group.ref !== orderRef && group.ref.startsWith('token:')) {
      group.ref = orderRef;
      for (const f of group.facts) f.orderRef = orderRef;
    }
    if (orderRef) checkoutByRef.set(orderRef, group);
    if (tokenRef) checkoutByRef.set(tokenRef, group);

    let added = 0;
    let repeated = 0;
    for (const fact of byProduct.values()) {
      if (group.productIds.has(fact.productId)) { repeated += 1; continue; }
      group.productIds.add(fact.productId);
      fact.orderRef = group.ref;
      group.facts.push(fact);
      facts.push(fact);
      added += 1;
    }
    if (added === 0 && repeated > 0) { duplicates += 1; reject(eventId, 'duplicate_order'); }
  }

  return {
    facts,
    rejected,
    stats: {
      received: list.length,
      facts: facts.length,
      rejected: rejected.length,
      duplicates,
    },
  };
}

// ---------------------------------------------------------------------------
// aggregateProductEvents(facts, window, options?)
//
// window = {
//   storeId, windowStart, windowEnd            — half-open [start, end), UTC
//   collectionStartedAt                         — when this store's pixel began
//                                                 collecting (null = unknown)
//   adminOrderRefs                              — optional: Shopify order ids
//                                                 created in the window (Admin
//                                                 sync), used ONLY for coverage
// }
// ---------------------------------------------------------------------------
function aggregateProductEvents(facts, window, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (!isObj(window) || !window.storeId) throw new TypeError('aggregateProductEvents: window.storeId is required');
  const start = toTime(window.windowStart);
  const end = toTime(window.windowEnd);
  if (start == null || end == null || end <= start) {
    throw new TypeError('aggregateProductEvents: windowStart must be before windowEnd');
  }
  const list = Array.isArray(facts) ? facts : [];

  const excluded = { foreignStore: 0, outOfWindow: 0, suspicious: 0 };
  const inWindow = [];
  for (const f of list) {
    if (!isObj(f) || f.storeId !== window.storeId) { excluded.foreignStore += 1; continue; }
    const t = toTime(f.occurredAt);
    if (t == null || t < start || t >= end) { excluded.outOfWindow += 1; continue; }
    inWindow.push(f);
  }

  // Viewer-days with implausible volume are excluded entirely, not trimmed.
  const perVisitorDay = new Map();
  for (const f of inWindow) {
    const k = `${f.visitorKey}|${f.day}`;
    perVisitorDay.set(k, (perVisitorDay.get(k) || 0) + 1);
  }
  const suspiciousKeys = new Set([...perVisitorDay].filter(([, n]) => n > cfg.maxFactsPerVisitorDay).map(([k]) => k));
  const usable = inWindow.filter((f) => {
    if (!suspiciousKeys.has(`${f.visitorKey}|${f.day}`)) return true;
    excluded.suspicious += 1;
    return false;
  });

  // Per product and viewer-day: first view time, last ATC time, last purchase
  // time. An ATC/purchase is in the cohort when its last occurrence that day is
  // at or after the day's first view (i.e. at least one happened after a view).
  const byProduct = new Map();
  const pixelOrderRefs = new Set();
  const dayBases = new Set();
  const keepMin = (map, k, t) => { if (!map.has(k) || t < map.get(k)) map.set(k, t); };
  const keepMax = (map, k, t) => { if (!map.has(k) || t > map.get(k)) map.set(k, t); };
  for (const f of usable) {
    let p = byProduct.get(f.productId);
    if (!p) {
      p = { firstView: new Map(), lastAtc: new Map(), lastPurchase: new Map(), orders: new Set() };
      byProduct.set(f.productId, p);
    }
    dayBases.add(f.dayBasis || 'UTC');
    const viewerDay = `${f.visitorKey}|${f.day}`;
    const t = toTime(f.occurredAt);
    if (f.kind === 'view') keepMin(p.firstView, viewerDay, t);
    else if (f.kind === 'atc') keepMax(p.lastAtc, viewerDay, t);
    else if (f.kind === 'purchase') {
      keepMax(p.lastPurchase, viewerDay, t);
      p.orders.add(f.orderRef);
      pixelOrderRefs.add(f.orderRef);
    }
  }

  const products = [...byProduct.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([productId, p]) => {
      const inCohort = (lastByDay) => new Set([...lastByDay]
        .filter(([k, t]) => p.firstView.has(k) && t >= p.firstView.get(k))
        .map(([k]) => k));
      const atcCohort = inCohort(p.lastAtc);
      const purchaseCohort = inCohort(p.lastPurchase);
      const viewDays = p.firstView.size;
      const atcDays = atcCohort.size;
      const purchaseDays = purchaseCohort.size;
      const atcOutsideCohortDays = p.lastAtc.size - atcDays;
      const purchaseOutsideCohortDays = p.lastPurchase.size - purchaseDays;
      const purchaseWithoutAtcDays = [...purchaseCohort].filter((k) => !atcCohort.has(k)).length;
      const dataQuality = [];
      if (atcOutsideCohortDays > 0) dataQuality.push('atc_outside_cohort');
      if (purchaseOutsideCohortDays > 0) dataQuality.push('purchase_outside_cohort');
      if (purchaseWithoutAtcDays > 0) dataQuality.push('purchase_without_atc');
      if (purchaseDays > atcDays) dataQuality.push('purchase_exceeds_atc');
      return {
        productId,
        viewDays,
        atcDays,
        purchaseDays,
        sameDayAtcRate: viewDays > 0 ? round4(atcDays / viewDays) : null,
        sameDayPurchaseRate: viewDays > 0 ? round4(purchaseDays / viewDays) : null,
        atcOutsideCohortDays,       // no earlier view that day (next-day, quick-add, ATC before view)
        purchaseOutsideCohortDays,  // e.g. viewed yesterday, bought today
        purchaseWithoutAtcDays,     // buy-now / express checkout inside the cohort
        checkoutOrders: p.orders.size, // observation only, never a funnel input
        dataQuality,
      };
    });

  // Coverage: how much of the window the pixel was collecting.
  const dataQuality = [];
  const collectionStart = toTime(window.collectionStartedAt);
  let coverageDays = null;
  let partialWindow = null;
  if (collectionStart == null) {
    dataQuality.push('collection_start_unknown');
  } else {
    coverageDays = Math.max(0, Math.floor((end - Math.max(start, collectionStart)) / DAY_MS));
    partialWindow = collectionStart > start;
    if (partialWindow) dataQuality.push('partial_window');
  }
  if (coverageDays != null && coverageDays < cfg.minCoverageDays) dataQuality.push('insufficient_coverage');

  // Observed share of Admin orders (consent / delivery coverage), when known.
  // Only order-id refs can be matched; checkout tokens cannot.
  let observedOrderShare = null;
  let pixelOrdersNotInAdmin = null;
  const pixelOrderIds = new Set([...pixelOrderRefs].filter((r) => r.startsWith('order:')));
  const tokenOnly = pixelOrderRefs.size - pixelOrderIds.size;
  if (tokenOnly > 0) dataQuality.push('unmatched_checkout_tokens');
  if (Array.isArray(window.adminOrderRefs)) {
    const admin = new Set();
    for (const r of window.adminOrderRefs) {
      const parsed = parseShopifyId(r, ['Order']);
      if (parsed.id) admin.add(`order:${parsed.id}`);
    }
    const matched = [...pixelOrderIds].filter((r) => admin.has(r)).length;
    pixelOrdersNotInAdmin = pixelOrderIds.size - matched;
    observedOrderShare = admin.size > 0 ? round4(matched / admin.size) : null;
    if (pixelOrdersNotInAdmin > 0) dataQuality.push('pixel_orders_not_in_admin');
    if (observedOrderShare != null && observedOrderShare < 0.5) dataQuality.push('low_observed_order_share');
  } else {
    dataQuality.push('admin_orders_unavailable');
  }
  if (excluded.suspicious > 0) dataQuality.push('suspicious_activity_excluded');
  const dayBasis = dayBases.size === 1 ? [...dayBases][0] : (dayBases.size === 0 ? null : 'mixed');
  if (dayBasis === 'UTC') dataQuality.push('utc_day_boundary');
  if (dayBasis === 'mixed') dataQuality.push('mixed_day_basis');

  return {
    storeId: window.storeId,
    measurement: { source: MEASUREMENT_SOURCE, unit: MEASUREMENT_UNIT, cohort: MEASUREMENT_COHORT, dayBasis },
    window: {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      days: Math.round((end - start) / DAY_MS),
    },
    coverage: {
      collectionStartedAt: collectionStart != null ? new Date(collectionStart).toISOString() : null,
      coverageDays,
      partialWindow,
      pixelCheckoutOrders: pixelOrderRefs.size,
      observedOrderShare,
      pixelOrdersNotInAdmin,
    },
    excluded,
    dataQuality,
    products,
  };
}

// ---------------------------------------------------------------------------
// toScoringFunnels(aggregate) → [{ productId, eligible, reasons, measurement, funnel }]
//
// `funnel` uses the field names ProductOpportunityScore reads from a profile
// (sessions / atcCount / atcRate / orderCount), all in viewer-days of one
// same-day cohort; atcRate is the same-day rate. `measurement` carries
// source/unit/cohort/coverage alongside — never in dataGaps, which scoring
// penalizes. Ineligible products get a null funnel so scoring reads them as
// insufficient rather than guessing.
//
// purchase_exceeds_atc blocks scoring because the engine's ATC→purchase step
// divides cohort purchases by cohort ATCs; with buy-now/express checkout that
// ratio would be overstated. This suppresses such products (fail-closed) until
// scoring can read an ATC-cohort purchase count.
// ---------------------------------------------------------------------------
const STORE_BLOCKERS = ['collection_start_unknown', 'insufficient_coverage', 'mixed_day_basis'];
const PRODUCT_BLOCKERS = ['purchase_exceeds_atc'];

function toScoringFunnels(aggregate) {
  if (!isObj(aggregate) || !isObj(aggregate.measurement) ||
      aggregate.measurement.source !== MEASUREMENT_SOURCE || aggregate.measurement.unit !== MEASUREMENT_UNIT ||
      aggregate.measurement.cohort !== MEASUREMENT_COHORT) {
    throw new TypeError('toScoringFunnels: expected a web_pixel / viewer_day / same_day_after_view aggregate');
  }
  const storeReasons = (aggregate.dataQuality || []).filter((q) => STORE_BLOCKERS.includes(q));
  const measurement = {
    source: aggregate.measurement.source,
    unit: aggregate.measurement.unit,
    cohort: aggregate.measurement.cohort,
    dayBasis: aggregate.measurement.dayBasis,
    windowStart: aggregate.window.start,
    windowEnd: aggregate.window.end,
    windowDays: aggregate.window.days,
    coverageDays: aggregate.coverage.coverageDays,
  };

  return (aggregate.products || []).map((p) => {
    const reasons = [...storeReasons, ...p.dataQuality.filter((q) => PRODUCT_BLOCKERS.includes(q))];
    const eligible = reasons.length === 0;
    return {
      productId: p.productId,
      eligible,
      reasons,
      measurement,
      funnel: eligible
        ? { sessions: p.viewDays, atcCount: p.atcDays, atcRate: p.sameDayAtcRate, orderCount: p.purchaseDays }
        : { sessions: null, atcCount: null, atcRate: null, orderCount: null },
    };
  });
}

module.exports = {
  MEASUREMENT_SOURCE,
  MEASUREMENT_UNIT,
  MEASUREMENT_COHORT,
  DEFAULTS,
  parseShopifyId,
  normalizeProductEvents,
  aggregateProductEvents,
  toScoringFunnels,
};
