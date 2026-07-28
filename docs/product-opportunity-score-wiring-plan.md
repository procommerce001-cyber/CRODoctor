# ProductOpportunityScore — Wiring Architecture Plan (Planning Only)

Status: **planning only — nothing implemented.** This document proposes how to
wire the existing pure service `api/src/services/product-opportunity.service.js`
into runtime **safely, behind a flag, with no default behavior change**.

## 1. Current state

- `product-opportunity.service.js` exists (PR #5, merge `a6c1b9c`) and is a
  **pure, deterministic, no-I/O** module. It touches no Prisma, Shopify, network,
  or env.
- Exports: `computeProductOpportunity(input)`, `detectPrimaryLeak(input)`,
  `rankProductOpportunities(inputs)`.
- Fully unit-tested: `api/src/__tests__/product-opportunity.test.js` (12 tests),
  part of the 245/245 suite on `main` (`c3e0bb6`).
- **Not wired into any route, service, or UI.** It is the scoring brain only.

### Service contract (as-built)

Input (plain object, all fields optional / null-safe):

| Group | Fields |
| --- | --- |
| identity | `productId`, `product.{id,status,updatedAt}` |
| snapshot | `productSessions`, `productAtcCount`, `orderCount`, `revenue`, `unitsSold`, plus optional store totals `storeSessions`, `storeOrderCount`, `storeRevenue` |
| profile | `sessions`, `atcRate`, `refundRate`, `dataGaps[]`, `archetype` |
| storeBaseline | `storeCvr`, `storeRpv`, `storeAtcRate`, `storeAov` |
| eligibleIssues | `[{ issueId, leakStage, riskLevel, canRollback }]` |
| variants | `[{ availableForSale }]` |
| other | `confoundFlags[]`, `midMeasurement` |

Output: `{ productId, opportunityScore (0–100), band (top|good|monitor|not_yet),
subScores {traffic,revenueUpside,leakage,dataQuality,interventionFit}(0–1),
estimatedRevenueUpside, primaryLeak, riskPenalty, excludedReason, dataConfidence
(insufficient|weak|usable|good), recommendedFocus, explanation }`.

Scoring: `100 * (0.30·revenueUpside + 0.25·leakage + 0.20·traffic +
0.15·dataQuality + 0.10·interventionFit)`, then `× (1 − riskPenalty)`; hard
exclusions (out of stock, draft/archived, mid-measurement, severe confound,
sessions < 50) force score 0 / band `not_yet`.

primaryLeak labels: `low_view_to_atc`, `low_atc_to_purchase`,
`high_interest_low_purchase`, `low_revenue_per_view`, `good_conversion_low_aov`,
`no_clear_leak`, `insufficient_data`.

## 2. Runtime map (read-only findings)

| Concern | Where it lives today |
| --- | --- |
| Product metrics snapshot | `metrics.service.js` — `captureProductMetricsSnapshot`, `compareProductMetrics` |
| Product performance profile | `product-performance.service.js` — `getLatestProductPerformanceProfile` (sessions/atcRate can be null) |
| Recommendation assembly (rules, no LLM) | `action-center.service.js` — `getProductActions`, `getStoreQueue` |
| Store queue (per-product aggregate) | `action-center.service.js` — `getStoreQueue` → returns `optimizationScore` per product |
| Dashboard/queue API | `routes/action-center.routes.js` — `GET /queue`; `routes/dashboard.routes.js` — `/selection`, `/recommendations` |
| Frontend consumption | `web/lib/api.ts`, `web/components/dashboard/*` |
| Confound flags | `metrics.service.js` (decisionV2 `confoundFlags` vocabulary) |

### Data-availability gaps (important — these bound v1 usefulness)

1. **No store baseline exists anywhere.** No code computes `storeCvr` / `storeRpv`
   / `storeAov` / `storeAtcRate`. `leakage` and `revenueUpside` sub-scores depend
   on baseline; without it many products resolve to `no_clear_leak` /
   `insufficient`. A baseline would need to be aggregated (store totals over a
   window) — read-only, but new code.
2. **`leakStage` is not tagged on any issue.** It exists only inside the
   opportunity service's own `LEAK_TO_STAGE` map. Real `eligibleIssues` from
   `getProductActions` carry no `leakStage`, so `interventionFit` will sit at its
   neutral 0.5 until a mapping is added.
3. **Product-level sessions/atcRate are frequently null** (per
   `product-performance.service.js` comment), pushing products toward
   `insufficient_data`.

**Conclusion:** the real work of wiring is a **pure input adapter** that assembles
the service input from existing loaders — plus discovering, on real data, how much
of that input can actually be populated. That is exactly what a dark, internal
diagnostics pass is for. It argues strongly for Option A first.

### Uncertainty / unknowns

- Whether enough live data exists to make the score meaningful (baseline + product
  sessions) is unknown until observed on real stores.
- Exact confound-flag availability per product at queue time (vs. only
  post-execution) needs confirmation during PR A implementation.

## 3. Wiring options

### Option A — Backend internal diagnostics only (RECOMMENDED)

Compute the score server-side and expose it **only** when a flag is on, via a
**new, dedicated, read-only diagnostics endpoint** that returns `404` when the
flag is off. Existing `/queue`, `/selection`, `/recommendations` responses are
**byte-identical** whether the flag is on or off.

- Files touched: new `api/src/services/product-opportunity-input.adapter.js`
  (pure mapper), new route handler in `routes/action-center.routes.js` (or a small
  new `routes/diagnostics.routes.js`), new tests. Optionally a store-baseline
  read helper.
- Risk: **very low.** No existing contract changes; new surface is inert when flag
  off.
- Pros: fully dark-deployable; lets us observe real inputs/outputs before trusting
  them; zero merchant-facing risk; no DB/schema.
- Cons: not merchant-visible (by design); requires the adapter + possibly a
  baseline helper.
- Tests: adapter mapping (pure), endpoint returns 404 when flag off, returns
  ranked results when flag on, no mutation of existing responses.
- Recommended: **yes.**

### Option B — Dashboard read-only internal panel

Render the score in an internal-only/debug panel in the dashboard; no ranking or
recommendation change.

- Files touched: everything in A **plus** `web/lib/api.ts` and a new gated
  `web/components/dashboard/*` panel.
- Risk: low, but now touches frontend and a user-visible surface (even if
  internal-gated).
- Pros: human-readable diagnostics.
- Cons: larger surface; frontend review needed; still no real decision value until
  data gaps closed.
- Recommended: **only after A**, as PR B.

### Option C — Recommendation ranking assist (disabled by default)

Use the score to sort candidate products/issues in `getStoreQueue`, behind a
**separate** flag, default off.

- Files touched: `action-center.service.js` ordering logic + adapter + stronger
  tests.
- Risk: **medium** — mutates the ordering of an existing runtime response when the
  flag is on; must be proven not to touch Shopify write path, Apply/Rollback, or
  generator output (it only reorders read-only listing data).
- Pros: the actual product goal (optimize highest-impact product first).
- Cons: only safe **after** real-data validation from A; needs regression tests
  proving flag-off ordering is unchanged.
- Recommended: **only after A validates the data**, as PR C, behind its own flag.

## 4. Recommended path

**Option A — backend internal diagnostics behind a flag.** Verified against the
code: the service is ready but its input has real assembly work and data gaps, so
the safest first step is a dark, observable diagnostics pass.

- **Feature flag:** `PRODUCT_OPPORTUNITY_DIAGNOSTICS` (opt-in), read as
  `process.env.PRODUCT_OPPORTUNITY_DIAGNOSTICS === 'true'` — matching the existing
  opt-in convention (`RATE_LIMIT_ENABLED`, `CRO_EXCLUDE_TEST_ORDERS`). Default
  **off**.
- **API location when on:** a new read-only endpoint, e.g.
  `GET /action-center/opportunity-diagnostics?shop=…`, returning
  `{ ranked: [ …computeProductOpportunity output… ] }`. Returns `404` (or `403`)
  when the flag is off. It **does not** modify `/queue`, `/selection`, or
  `/recommendations`.
- **Frontend:** **unchanged** in PR A.
- **No DB/schema:** the adapter only consumes already-fetched Prisma rows +
  read-only aggregates; no new tables, columns, or migrations.
- **No Shopify write path:** the endpoint is read-only and never calls Shopify or
  Anthropic.
- **Verify flag off:** `/queue` response is byte-identical to `main`; the
  diagnostics endpoint 404s. Add a test asserting both.
- **Verify flag on:** the diagnostics endpoint returns ranked results; adapter
  unit tests prove the mapping.

### Files to touch (PR A)

- add `api/src/services/product-opportunity-input.adapter.js` (pure)
- add gated handler in `api/src/routes/action-center.routes.js` (or new
  `diagnostics.routes.js`)
- optionally add a read-only store-baseline helper (in `metrics.service.js` as a
  new additive function, not a change to existing ones)
- add `api/src/__tests__/product-opportunity-wiring.test.js`
- update `api/package.json` only if a new test file needs listing in the `test`
  script

### Files NOT to touch

`content-execution.service.js`, `content-safety-validator.js`, output contract
validator runtime, generator output logic, Apply/Rollback functions
(`applyContentChange`, `rollbackContentChange`, `executeTwoPhaseWrite`),
`checkApplyGate`, IssueRouter behavior, Prisma schema, any migration, Shopify
services, existing `getStoreQueue` ordering (that is PR C, not PR A).

## 5. PR plan

- **PR A — internal diagnostics behind flag.** Pure adapter + gated read-only
  endpoint + tests. No frontend, no DB, no Shopify, no ordering change.
  **Approval gate → B/C:** confirm on real data that inputs populate meaningfully
  (baseline present, sessions present) and outputs look sane.
- **PR B — internal dashboard visibility (optional).** Gated internal panel
  consuming PR A's endpoint. Still no Shopify/ordering impact.
  **Approval gate → C:** merchant/internal reviewer confirms the diagnostics are
  trustworthy.
- **PR C — ranking assist (optional).** Separate flag, default off; reorders
  read-only queue listing only, with regression tests proving flag-off ordering is
  unchanged and no write-path/Apply-Rollback impact.

## 6. Non-goals (this plan)

No merchant-facing behavior change; no automatic Shopify writes; no Apply/Rollback
change; no recommendation mutation; no schema/migrations; no new dependencies; no
deployment.

## 7. Risks

- **Low-signal outputs** until the store-baseline and `leakStage` gaps are closed —
  handled by keeping A dark/internal.
- **Scope creep** into `getStoreQueue` ordering — explicitly deferred to PR C.
- **Accidental contract drift** on `/queue` — prevented by using a *separate*
  endpoint and a flag-off regression test.

## 8. Explicit "do not touch" list

Shopify write path · Apply/Rollback · content-execution · content-safety-validator
· Output Contract Validator runtime · generator output · Action Center behavior
(ordering/response shape) · IssueRouter · DB schema · migrations · dependencies ·
deploy.
