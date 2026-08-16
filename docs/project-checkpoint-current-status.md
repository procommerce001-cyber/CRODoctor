# Project Checkpoint — Current Approved State

Single source of truth for approved, merged, and verified work on `main`.

## Current approved main status (after PR #14, 2026-08-16)

- **Approved main commit:** `df1fa76`
- **Latest verified PR:** #14 — Add controlled beta write kill switch
- **Latest verification verdict:** `PR_14_POST_MERGE_VERIFIED`
- **Latest full suite:** **297/297 passing**
- No manual deploy · no DB/SQL · no live Shopify · no Anthropic · no external calls during verification.

## Completed approved milestones

### PR #10 — ProductOpportunityScore diagnostics flag
- Internal diagnostics only, behind `PRODUCT_OPPORTUNITY_DIAGNOSTICS`, default OFF.
- No merchant-facing behavior change · no Apply/Rollback change · no Shopify write-path change.

### PR #11 — Store Baseline Engine architecture plan
- Docs/architecture plan approved; internal-first baseline strategy; no runtime behavior change.

### PR #12 — Store Baseline internal helper
- Internal Store Baseline service added; observation-only; no scoring/ranking change; no merchant-facing change.

### PR #13 — Snapshot AOV feed into Store Baseline diagnostics
- Merge commit `3bd709f`; branch commit `6b251fb`.
- Snapshot `revenue`/`orderCount` feeds **AOV only** via a dedicated `aovRevenue`/`aovOrders` pair.
- `ProductMetricsSnapshot` used only for AOV; `ProductPerformanceProfile` remains the funnel source.
- `productViews` null · PdpEvent unused · `revenuePerSession` null · `revenuePerProductView` null.
- ProductOpportunityScore unchanged · `/queue` unchanged · diagnostics default-off behind `PRODUCT_OPPORTUNITY_DIAGNOSTICS`.
- Verified **281/281** after PR #13.

### PR #14 — Controlled Beta Write Kill Switch
- Merge commit `df1fa76`; branch commits `e772a9f` (add kill switch) + `76b4ac5` (true chokepoint guard).
- Added `api/src/services/beta-safety.service.js` (pure, fail-closed).
- Guarded the **true Shopify product-write chokepoint** `action-center.service.js:updateProductDescription` (blocks before fetch).
- Guarded `shopify-admin.service.js` mutating requests (PUT/POST/PATCH/DELETE) before Shopify fetch.
- Guarded Action Center dangerous routes: `POST /action-center/products/:id/apply`, `.../rollback`, `/batch-apply-safe`, `/batch-apply-selected`.
- Guarded Decision Engine dangerous route: `POST /decision-engine/actions/execute`.
- Added beta-safety tests. Full suite after PR #14: **297/297 passing**.
- Behavior unchanged when flags are off; kill switch **inert unless flags are explicitly enabled**; no merchant-facing behavior change.

## Current approved product architecture status

**Internal intelligence layer**
- ProductOpportunityScore exists internally; **not merchant-facing**; **not** connected to customer-facing ranking.
- Store Baseline exists internally; can now include **AOV** from snapshots where supported; remains **observation-only**.
- Missing data is preserved honestly; **no fake confidence** is to be introduced.

**Diagnostics**
- `PRODUCT_OPPORTUNITY_DIAGNOSTICS` exists; diagnostics remain **default OFF**, internal.
- Diagnostics alone are **not enough** for a real-store beta without a store allowlist.

**Controlled Beta safety**
- Beta 0 read-only write protection is now **enforceable in code** after PR #14.
- Shopify writes are blocked when `CONTROLLED_BETA_READ_ONLY=true`, `DISABLE_SHOPIFY_WRITES=true`, or `APPLY_DISABLED=true` (route-level Apply/Rollback).
- True write chokepoint guarded before fetch; dangerous routes guarded before DB/Shopify work.
- Normal production behavior unchanged when flags are off.

## Current limitations / NOT ready yet

- **We are NOT ready to connect a real client store.** PR #14 is necessary but **not sufficient**.
- Still required before Beta 0:
  1. **Store allowlist / beta enrollment guard — PR B**
  2. **Ops checklist / runbook**
  3. **Controlled Beta 0 approval process**
- `PRODUCT_OPPORTUNITY_DIAGNOSTICS` alone is not enough; store allowlist + ops checklist are required before real stores.
- No real store connected until PR B and the ops checklist are complete.
- No merchant-facing uplift claims yet · no ProductOpportunityScore merchant-facing exposure yet.
- No Apply/Auto-Apply in Beta 0 · no automatic writes to customer stores in Beta 0.

## Recommended next steps (prioritized)

- **P0 — Save this checkpoint** (docs-only memory checkpoint after PR #14). *(this document)*
- **P1 — PR B: Store allowlist / beta enrollment guard.** Diagnostics require global flag **+** explicit store allowlist; non-allowlisted stores cannot run diagnostics; fail closed. No write-path changes; no ProductOpportunityScore formula changes; no Store Baseline logic changes.
- **P2 — Controlled Beta Ops Checklist / Runbook.** Exactly how to connect the first real store safely: flags, operator steps, stop conditions, monitoring, allowed/forbidden. Read-only only.
- **P3 — Beta 0 on one real store, read-only only.** Allowed: connect approved store, run diagnostics internally, inspect ProductOpportunityScore + Store Baseline internally, compare vs manual CRO review. Forbidden: Apply, Rollback, Auto-Apply, product updates, theme updates, cart/checkout changes, merchant-facing uplift claims.
- **P4 — PdpEvent productViews feed plan** (architecture plan only first; single `groupBy`; coverage labels; no fake confidence).
- **P5 — Change→Outcome Data Model plan** (architecture plan only first; needed for Proof Engine and Store Memory).
- **P6 — Measurement Readiness + Data Honesty** (plan first; needed before merchant-facing impact claims).

## Explicit safety rules going forward

- Every Shopify write-path PR requires: pre-PR safety review → PR open only → merge safety review → post-merge verification → checkpoint if significant.
- No direct merge without review.
- No production deploy unless explicitly requested.
- No real-store beta without allowlist + ops checklist.
- No ProductOpportunityScore merchant-facing exposure before baseline reliability and `leakStage` are stronger.
- No uplift claims without Change→Outcome + measurement readiness.
