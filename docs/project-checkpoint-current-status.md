# Project Checkpoint — Current Approved State

Short, docs-only record of completed + verified work merged and safe on `main`.

## Latest checkpoint — after PR #13 (2026-08-12)

**`main` at merge commit `3bd709f`.**

### PR #13 — Feed snapshot revenue into Store Baseline diagnostics

- **Merge commit:** `3bd709f`
- **Merged branch:** `data/store-baseline-snapshot-aov-feed`
- **Branch commit:** `6b251fb`
- **Changed files (4):**
  - `api/src/services/store-baseline.service.js`
  - `api/src/routes/action-center.routes.js`
  - `api/src/__tests__/store-baseline-assembly.test.js`
  - `api/package.json` (registers the new test file only)

### Purpose

Feed latest standalone `ProductMetricsSnapshot` revenue/orders into Store Baseline
diagnostics to unlock **`averageOrderValue` only** — without contaminating the
rolling-window funnel metrics.

### Feature flag

- Reuses **`PRODUCT_OPPORTUNITY_DIAGNOSTICS`** (no new flag); default **OFF**.
- **Endpoint:** `GET /action-center/opportunity-diagnostics?shop=...`

### Behavior

- `storeBaseline` remains **observation-only** metadata.
- AOV can now use `ProductMetricsSnapshot` `revenue`/`orderCount`.
- No `revenuePerSession` unlock · no `revenuePerProductView` unlock.
- `productViews` remain null · PdpEvent deferred.
- No scoring change · no ranking change · no `/queue` change · no merchant-facing
  UI change.

### Service changes

- New pure helpers: `assembleStoreBaselineRows(contexts, snapshots, options)`,
  `coerceNonNegativeNumber(value)`, `selectLatestSnapshotsByProductId(snapshots)`.
- New dedicated AOV-only row fields: `aovRevenue`, `aovOrders`.
- `buildStoreBaseline` computes AOV from `sum(aovRevenue) / sum(aovOrders)` when
  present (legacy same-window `revenue`/`orders` fallback preserved).

### Safety

- `aovRevenue`/`aovOrders` used **only** for AOV.
- Snapshot orders kept separate from profile funnel orders; CVR and ATC→Purchase
  remain profile-window based — **no fake window mixing**.
- Snapshot cumulative revenue never creates `revenuePerSession`/`revenuePerProductView`.
- Decimal/string/bigint/Decimal-like revenue coercion safe; invalid/negative/NaN/
  Infinity → null.
- Pure service — no Prisma/Shopify/Anthropic/network imports; does not
  import/call ProductOpportunityScore.
- No schema/migration · no frontend · no dependencies · no Shopify write-path ·
  no Apply/Rollback impact.
- Snapshot query is a single `findMany` (minimal fields, `phase:'standalone'`);
  no N+1.

### Verification (post-merge, on `main`)

- `6b251fb` reachable from `main`: yes
- `node --check` passed for service, route, and both test files
- Store-baseline tests: **11/11** · assembly tests: **11/11** · diagnostics tests:
  **14/14**
- Full suite: **281/281 passing**
- No DB connection · no SQL · no Shopify · no Anthropic · no external calls · no
  manual deploy

**Verdict:** `PR_13_POST_MERGE_VERIFIED`.

### Current limitation

- `productViews` still null; PdpEvent not yet used.
- `revenuePerSession`/`revenuePerProductView` remain unavailable until same-window
  denominators exist.
- ProductOpportunityScore is still **not** fed by the baseline.

### Next recommended work (planning first)

- Architecture plan only for a PdpEvent `productViews` feed (single `groupBy` +
  coverage labels).
- Or a baseline reliability calibration plan before any ProductOpportunityScore
  integration.
- Do **not** connect the baseline to ProductOpportunityScore scoring yet.
