# Store Baseline Engine — Architecture Plan (Planning Only)

Status: **planning only — nothing implemented, no runtime change, no schema
change.** This document defines how CRODoctor should compute a trustworthy
**store baseline** that ProductOpportunityScore (and later the Proof Engine) can
depend on — without inventing confidence the data does not support.

## 1. Why this exists

`ProductOpportunityScore` (merged, internal-only behind
`PRODUCT_OPPORTUNITY_DIAGNOSTICS`, PR #10 / `eed382b`) cannot become reliable
merchant-facing prioritization until it can answer: *is this product actually
underperforming, or just low-traffic?* That requires a **store baseline** — what
"normal" looks like for this specific store. Today the score's `storeBaseline`
input is **omitted** because no runtime code computes it (confirmed: `storeCvr`/
`storeRpv`/`storeAov`/`storeAtcRate` are referenced only inside
`product-opportunity.service.js`, never produced anywhere).

The baseline is foundational for: ProductOpportunityScore v2, Measurement
Readiness, Proof Engine, Confounder Detection, Revenue Impact Reports, and the
Store Memory Layer.

## 2. Current data reality (read-only findings)

### What already exists (Prisma models on `main`)

| Source | Grain | Fields relevant to baseline | Caveat |
| --- | --- | --- | --- |
| `ProductMetricsSnapshot` | per-product per-window | `orderCount`, `unitsSold`, `revenue`, `windowStart/End`, **store totals** `storeRevenue`, `storeOrderCount`, `storeSessions`, and product `productSessions`, `productAtcCount` | session/atc fields are **nullable** — populated only when `read_analytics` scope is present |
| `ProductPerformanceProfile` | per-product rolling 28d, `@@index([storeId, capturedAt])` | `sessions`, `atcCount`, `atcRate`, `orderCount`, `refundCount`, `refundRate`, `archetype`, `dataGaps[]` | `sessions`/`atcCount`/`atcRate` nullable until product-analytics available |
| `PdpEvent` | append-only first-party events, `@@index([storeId, issuedAt])` | `event` ∈ {`pdp_view`, `atc_click`, `checkout_click`, …}, `sessionId`, `visitorId`, `productId` | **scope-independent first-party funnel**, but coverage depends on storefront pixel install; limited history (Phase 4A); exposure anchors (Phase 4B) not done |
| `Order` / `OrderLineItem` | per-order | revenue, orderNumber, line items, `quantity`, `price` | **always reliable** (webhook-sourced) — ground truth for revenue/AOV |

### What is reliably computable **now**

- **AOV** (`revenue / orderCount`) — always, from Orders/snapshots. No denominator-of-sessions needed.
- **Store order volume & revenue** over a window — always.
- **View→ATC / ATC→checkout funnel** at store level — **when** `PdpEvent` coverage exists (first-party, scope-independent).
- **Store CVR / RPV** — **only when** a sessions denominator exists: either `read_analytics` (`storeSessions` in snapshots / `sessions` in profiles) **or** sufficient `PdpEvent` `pdp_view` volume.

### What is missing / must not be invented

- A reliable **sessions/views denominator for every store**. Absent both analytics scope and pixel coverage, CVR/RPV/view→ATC are **not computable** and must be reported as `missingData`, never faked.
- **`leakStage` tagging** on issues (separate gap; not solved here).
- Per-window **confounder context** (promo/media/inventory spikes) — future Confounder Detection, not baseline.

### Hard blockers

- None for a conservative, on-demand baseline. The data to compute a *labeled* baseline exists today.
- The only real blocker is **honesty**: many stores will have AOV but not CVR/RPV. The engine must degrade gracefully, not fabricate.

## 3. Store baseline definition (for CRODoctor)

A **traffic-weighted, windowed, reliability-labeled** summary of "normal" store
performance, computed by aggregating existing per-product data to store level.

**Metrics (each independently nullable + labeled):**
- `averageOrderValue` (always when orders>0)
- `revenuePerProductView` (RPV) — needs views denominator
- `productViewToAtcRate` — needs views + atc (analytics or PdpEvent)
- `atcToPurchaseRate` — needs atc + orders
- `productViewToPurchaseRate` (store CVR) — needs views + orders
- `revenuePerSession` — needs sessions
- Distribution context: **median / percentile** product performance within the store, and **traffic-weighted** averages (so a few high-traffic products don't skew the mean, and low-traffic products aren't over-counted).

**Thresholds (below → "insufficient", not a low score):**
- `minProductViews` (e.g. store-level views over window), `minOrders` (e.g. ≥ some N for trustworthy AOV/CVR), `minDays` (window maturity), `minProductsWithData` (enough products to form a distribution).

**Reliability labels:** `good | usable | weak | insufficient`, each with explicit `reasons[]`, `missingData[]`, and `sourcesUsed[]` (analytics vs first-party vs orders-only). **Missing-data policy:** any metric lacking its denominator is `null` + listed in `missingData`; the baseline is still returned (partial), never blocked, never faked.

## 4. Architecture options

### Option A — Pure on-demand baseline helper, internal only (RECOMMENDED first)
- **Description:** a pure aggregation helper that reads already-fetched rows (snapshots/profiles/PdpEvent counts/orders) and returns a labeled baseline at request time. No new table.
- **Data requirements:** existing tables only.
- **Future files likely touched:** new `api/src/services/store-baseline.service.js` (pure compute given data) + a thin loader (in the existing diagnostics route or metrics service). Tests.
- **DB/schema needed:** **no**.
- **Risk:** low (read-only, internal, flag-gated).
- **Pros:** shippable now; dark-launchable; honest labeling; unblocks ProductOpportunityScore input; no migration.
- **Cons:** recomputes each call (cost/latency at scale); limited to what current data supports.
- **Recommended:** **yes — first PR.**

### Option B — Cached internal baseline snapshot
- **Description:** persist a computed baseline per `(shop, window)` for reuse; refresh on a schedule.
- **Data requirements:** same inputs as A + a store table.
- **Future files:** new Prisma model + migration + scheduled aggregation job + read path.
- **DB/schema needed:** **yes**.
- **Risk:** medium (schema, scheduler, staleness).
- **Pros:** scalable, low-latency, seeds Store Memory Layer.
- **Cons:** schema/migration; premature before the compute logic is proven.
- **Recommended:** **later — Phase 2**, only after A's math is validated on real data.

### Option C — Full Measurement/Proof baseline foundation
- **Description:** baseline as part of a Change→Outcome + Proof Engine data foundation (windowed, versioned, confounder-aware).
- **Data requirements:** A + B + confounder inputs + holdout wiring.
- **Future files:** multiple new models/migrations, scheduled aggregation, Proof Engine services.
- **DB/schema needed:** **yes (significant)**.
- **Risk:** high; large surface.
- **Pros:** strongest long-term architecture; underpins Proof Engine.
- **Cons:** not a first PR; over-engineered before A proves value.
- **Recommended:** **not now — 12–24 mo direction.**

## 5. Recommended path

**Start with Option A**, dark and internal, then graduate to B once the compute is
trusted on real data.

- **First implementation PR scope:** a **pure** `store-baseline.service.js` that, given already-loaded store data, returns the labeled baseline contract (Section 6). A thin read-only loader may compute it inside the **existing** `opportunity-diagnostics` flow (same `PRODUCT_OPPORTUNITY_DIAGNOSTICS` flag) **for observation only** — surfaced in the diagnostics payload, **not** fed into the score yet.
- **Feature flag:** reuse `PRODUCT_OPPORTUNITY_DIAGNOSTICS` (no new flag needed for internal observation).
- **New endpoint:** **no** — piggyback the existing internal diagnostics endpoint.
- **Internal only:** **yes** — nothing merchant-facing.
- **Feed ProductOpportunityScore immediately?** **No.** First observe baseline output vs reality (diagnostics only). Only after it's validated does a *later* PR pass `storeBaseline` into the adapter's input (a separate, reviewed change).
- **Tests to add:** pure unit tests for the helper (Section 9).
- **What not to touch:** the ProductOpportunityScore formula, the diagnostics endpoint's flag-off 404 behavior, Shopify write path, Apply/Rollback, Output Contract Validator, generators, Prisma schema, dependencies, frontend.
- **Must be true before merchant-facing exposure:** baseline reliability calibrated against Shopify actuals; `insufficient`/`weak` labels behave correctly; ProductOpportunityScore consuming it produces sane, non-fake results on real stores.

## 6. Proposed output contract (definition only)

```
{
  shop,
  timeWindow: { start, end, days },
  generatedAt,
  sampleSize: { products, productsWithViews, orders, views, sessions },
  metrics: {
    productViewToAtcRate,      // null if no views/atc denominator
    atcToPurchaseRate,         // null if no atc
    productViewToPurchaseRate, // store CVR; null if no views
    revenuePerProductView,     // RPV; null if no views
    averageOrderValue,         // reliable when orders > 0
    revenuePerSession          // null if no sessions
  },
  distribution: {              // within-store context, traffic-weighted
    medianProductCvr, p25ProductCvr, p75ProductCvr,   // null when insufficient
    trafficWeighted: true
  },
  thresholds: { minProductViews, minOrders, minDays, minProductsWithData },
  reliability: {
    level,                     // good | usable | weak | insufficient
    reasons: [],
    missingData: [],           // e.g. ["storeSessions", "pdp_view coverage"]
    sourcesUsed: [],           // e.g. ["orders", "pdp_events"] / ["shopify_analytics"]
    confoundersKnown: false    // baseline does not yet model confounders
  },
  notes
}
```

Rules: every metric independently nullable; missing denominator → `null` +
`missingData`; baseline is always returned (partial ok); **never** fabricate a
value; `averageOrderValue` is the one metric expected to be reliable most often.

## 7. Integration with ProductOpportunityScore

- **What improves:** `leakage` and `revenueUpside` sub-scores gain a real reference; `detectPrimaryLeak` can distinguish "underperforms vs store" from "just low-traffic"; `estimatedRevenueUpside` becomes grounded (baseline RPV − product RPV) × views instead of blind.
- **dataConfidence:** should be **capped by** baseline reliability — if baseline is `insufficient`, product `dataConfidence` cannot exceed `weak`. This is the anti-fake-confidence guard.
- **estimatedRevenueUpside:** only produced when baseline RPV is non-null and reliable; otherwise `null` (honest).
- **Fake-opportunity avoidance:** a product only reads as a real opportunity when the store baseline it's compared against is itself reliable.
- **Interaction with missing `leakStage`:** independent gap — baseline does **not** fix `interventionFit`; that stays neutral until leakStage tagging exists. Do not conflate the two.
- **Should ProductOpportunityScore stay internal until baseline is reliable?** **Yes.** Baseline reliability is a precondition for any merchant-facing score.

## 8. Testing plan (future implementation)

Pure unit tests, node:test, no DB/Shopify/Anthropic/network:
- happy path: full data → correct labeled metrics, traffic-weighted.
- missing sessions/views → CVR/RPV `null`, `missingData` populated, AOV still present.
- insufficient sample (below thresholds) → `reliability.level = insufficient`, no fabricated metrics.
- zero-denominator (0 sessions / 0 orders / 0 atc) → `null`, no division error.
- outlier product (one huge-traffic product) → traffic-weighting prevents skew; median/percentile sane.
- determinism: same input → same output; no `Date.now()` inside the pure helper (timestamp injected by caller).
- no mutation of inputs.
- ProductOpportunityScore **integration** tests only **after** the baseline helper is stable and only in the later PR that actually wires `storeBaseline` in.

## 9. Non-goals

No merchant-facing exposure; no uplift claims; no schema/migration in the first PR;
no new dependency; no new flag; no confounder modeling; no `leakStage` fix; no
change to the ProductOpportunityScore formula or the diagnostics endpoint contract.

## 10. Explicit "do not touch" list

Shopify write path · Apply/Rollback · content-execution · content-safety-validator
· Output Contract Validator · generators · ProductOpportunityScore formula ·
`opportunity-diagnostics` flag-off 404 behavior · Prisma schema · migrations ·
dependencies/lockfiles · frontend.

## 11. Open questions

1. What `PdpEvent` coverage % across real stores makes first-party funnel a
   trustworthy denominator (vs relying on `read_analytics`)?
2. Minimum thresholds: what `minOrders` / `minProductViews` / `minDays` make AOV and
   CVR trustworthy for our ICP (growing Shopify stores)?
3. Window length: fixed 28d (align with `ProductPerformanceProfile`) or configurable?
4. Should baseline blend sources (analytics + first-party) or pick the single most
   reliable source per metric and label it?
5. At what scale does on-demand (Option A) latency force the move to cached
   (Option B)?
