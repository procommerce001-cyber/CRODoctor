# Project Checkpoint — Current Approved State

Short, docs-only record of completed + verified work merged and safe on `main`.

## Latest checkpoint — after PR #10 (2026-08-03)

**`main` at merge commit `eed382b`.**

### PR #10 — Add ProductOpportunityScore diagnostics flag

- **Merge commit:** `eed382b`
- **Merged branch:** `data/product-opportunity-diagnostics-flag`
- **Branch commit:** `bbe60ea` — Add ProductOpportunityScore diagnostics flag
- **Changed files (4):**
  - `api/package.json` (registers the new test file only)
  - `api/src/routes/action-center.routes.js` (new flag-gated route + imports)
  - `api/src/services/product-opportunity-input.adapter.js` (new pure adapter)
  - `api/src/__tests__/product-opportunity-diagnostics.test.js` (new tests)

### Purpose

First safe runtime wiring for `ProductOpportunityScore` as **internal diagnostics
only** (Option A of the merged wiring plan). Makes the score observable internally
without any merchant-facing or ranking behavior change.

### Feature flag

- **`PRODUCT_OPPORTUNITY_DIAGNOSTICS`** — OFF by default; enabled only when
  `process.env.PRODUCT_OPPORTUNITY_DIAGNOSTICS === 'true'` (exact string).
- **Endpoint:** `GET /action-center/opportunity-diagnostics?shop=...`

### Safety

- Flag OFF → endpoint returns `404` **before** any DB access / `resolveStore` /
  query / expensive work.
- Read-only diagnostics; uses the LLM-free `listProductRecommendations` path.
- No Shopify call · no Anthropic call · no DB writes.
- No `/queue` ordering or ranking change · no merchant-facing UI change.
- No Shopify write-path · no Apply/Rollback · no Output Contract Validator · no
  generator · no ProductOpportunityScore formula change.
- No Prisma schema/migration · no dependency/lockfile change · no manual deploy.
- Honestly surfaces the two runtime data gaps (no store baseline computed; issues
  not tagged with `leakStage`); does not fake confidence.

### Verification (post-merge, on `main`)

- `bbe60ea` reachable from `main`: yes
- `node --check` passed for adapter, route, and test file
- Targeted diagnostics tests: **14/14 passing**
- Full suite: **259/259 passing**
- No DB connection · no SQL · no external calls

**Verdict:** `PR_10_POST_MERGE_VERIFIED`.

### Remaining notes (non-blocking)

- Route-level integration test deferred (repo uses pure unit tests; no
  Express/supertest harness). Flag gate + adapter are unit-tested.
- Add an optional admin/internal-only guard **before enabling the flag in a
  shared/production environment**.
- ProductOpportunityScore should remain **internal** until the store-baseline and
  `leakStage` gaps are addressed.

### Next recommended work (planning only)

- **Store Baseline Engine** — architecture plan only (closes data gap #1).
- **Change→Outcome Data Model** — architecture plan only (foundation of the data
  moat).
- **Measurement Readiness / Data Honesty** — planning only.
