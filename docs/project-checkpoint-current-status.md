# Project Checkpoint — Current Approved State

Short, docs-only record of completed + verified work merged and safe on `main`.

## Latest checkpoint — after PR #12 (2026-08-05)

**`main` at merge commit `01d305f`.**

### PR #12 — Add internal Store Baseline Engine helper

- **Merge commit:** `01d305f`
- **Merged branch:** `data/store-baseline-engine-option-a`
- **Branch commit:** `8724b73` — Add internal Store Baseline Engine helper
- **Changed files (4):**
  - `api/package.json` (registers the new test file only)
  - `api/src/routes/action-center.routes.js` (observation-only baseline attach)
  - `api/src/services/store-baseline.service.js` (new pure service)
  - `api/src/__tests__/store-baseline.test.js` (new tests)

### Purpose

First internal **Store Baseline Engine — Option A** implementation (from the merged
plan `docs/store-baseline-engine-plan.md`): a pure, on-demand, internal-only
baseline helper with honest missing-data handling and reliability labels.

### Feature flag

- Reuses the existing **`PRODUCT_OPPORTUNITY_DIAGNOSTICS`** flag (no new flag);
  default **OFF**.
- **Endpoint:** `GET /action-center/opportunity-diagnostics?shop=...`
- Flag OFF → endpoint returns `404` before any DB/work (unchanged).

### Behavior

- `storeBaseline` attached as **observation-only** metadata to the diagnostics
  response.
- No ProductOpportunityScore scoring change · no ranking change · no `/queue`
  change · no merchant-facing UI change.

### Service contract

- Metrics: `averageOrderValue`, `revenuePerSession`, `revenuePerProductView`,
  `storeConversionRate`, `productViewToAtcRate`, `atcToPurchaseRate` (traffic-
  weighted), plus per-product `distribution`.
- Reliability labels: `good | usable | weak | insufficient` with `reasons[]`,
  `missingData[]`, `sourcesUsed[]`, `confoundersKnown`.
- Missing denominator → metric `null` + listed in `reliability.missingData`; zero
  denominator → `null`; no NaN/Infinity; empty input does not throw; never
  fabricates data.

### Safety

- Pure service — no Prisma/Shopify/Anthropic/network/`process.env` imports; no
  input mutation; deterministic except injectable `generatedAt`.
- Does not import or call ProductOpportunityScore.
- No schema/migration · no frontend · no dependencies · no Shopify write-path ·
  no Apply/Rollback · no Output Contract Validator impact.

### Verification (post-merge, on `main`)

- `8724b73` reachable from `main`: yes
- `node --check` passed for service, route, and test file
- Store-baseline tests: **11/11** · diagnostics tests: **14/14**
- Full suite: **270/270 passing**
- No DB connection · no SQL · no Shopify · no Anthropic · no external calls · no
  manual deploy

**Verdict:** `PR_12_POST_MERGE_VERIFIED`.

### Current honest limitation

The diagnostics route currently maps only `ProductPerformanceProfile` fields
(`sessions`, `atcCount`, `orderCount`). It does **not** yet feed `revenue` or raw
product `views`, so in the live diagnostics response revenue/raw-view-dependent
metrics (AOV, RPV, view→ATC) correctly return `null` + `missingData`. Acceptable by
design — a future PR can feed revenue/views from `ProductMetricsSnapshot`/`Order`
into `buildStoreBaseline` **without changing the pure service**.

### Next recommended work (planning first)

- Feed revenue/views from `ProductMetricsSnapshot`/`Order` into `buildStoreBaseline`
  (plan or small implementation).
- Baseline reliability calibration plan (vs Shopify actuals).
- ProductOpportunityScore v2 integration **only after** baseline reliability is
  proven; keep the score internal until then.
