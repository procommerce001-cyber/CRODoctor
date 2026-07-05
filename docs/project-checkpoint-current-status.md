# Project Checkpoint — Current Status

_Last updated: 2026-07-05 (after PR #4 merge + post-merge verification)_

This is a rolling engineering checkpoint. It records what is merged, what is
implemented-but-unmerged, and the immediate next task, so state is not lost
between sessions. See companion docs:

- [LLM Pipeline External Audit Summary](./llm-pipeline-external-audit-summary.md)
- [Production Readiness Roadmap](./production-readiness-roadmap.md)

---

## A. Merged and verified on `main`

| Item | Ref | Status |
|------|-----|--------|
| PR #4 — LLM Call Hardening (retry helper + system prompts) | commit `66baa79`, merge `ca6304b` | **PR_4_POST_MERGE_VERIFIED** |
| DATA #2B — honest measurement labels (no schema) | PR #3 (`8db2b08`) | merged |
| Root redirect → dashboard | PR #2 (`eb9b965`) | merged |
| UX Apply/Rollback clarity Phase 1 | PR #1 (`00a365d`) | merged |

### PR #4 — LLM Call Hardening (detail)

- **Branch:** `hardening/llm-retry-system-messages` (not deleted)
- **Original commit:** `66baa79` — "Harden LLM calls with retry helper and system prompts"
- **Merge commit on main:** `ca6304b`
- **Post-merge verdict:** `PR_4_POST_MERGE_VERIFIED`
- **Tests at merge:** 186/186 passing on `main`.

What it changed:

- Refactored three raw-`fetch` generators to use `callAnthropicWithRetry`:
  - `api/src/services/cro/generators/description-llm.js`
  - `api/src/services/cro/generators/desire-block-llm.js`
  - `api/src/services/cro/generators/short-description-llm.js`
- Added a top-level `system: CRO_SYSTEM_MESSAGE` field to all five relevant generators
  (the three above plus `risk-reversal-llm.js` and `trust-bullets-llm.js`).
  Passed as the Messages API top-level `system` field — **not** as a `{ role: 'system' }` message.
- Added:
  - `api/src/services/cro/generators/system-message.js` (exports `CRO_SYSTEM_MESSAGE`)
  - `api/src/__tests__/llm-call-hardening.test.js` (structural/static tests)
- Updated `api/package.json` — **test file list only**.

Confirmed non-changes (safety boundaries held): no Shopify write-path change, no
`action-center.service.js` change, no Apply/Rollback change, no DB/schema/migration
change, no env/settings change, no dependency/lockfile change.

> Note: tests live under `api/src/__tests__/` (the repo's actual test directory),
> not `api/src/tests/` as some task briefs phrase it.

---

## B. Implemented but NOT yet merged

### ProductOpportunityScore v1

- **Branch:** `data/product-opportunity-score-v1`
- **Commits:**
  - `b19bc50` — Add product opportunity scoring service
  - `ae62ce0` — Align product opportunity tests with API suite
- **Sync commit:** `ab22786` — merged latest `main` (incl. PR #4) into the branch.
- **Files:**
  - `api/src/services/product-opportunity.service.js` (pure service)
  - `api/src/__tests__/product-opportunity.test.js` (15 tests)
  - `api/package.json` (test list only)
- **Scope:** pure service + tests only. **Not wired into runtime.** No Action Center
  integration, no Dashboard integration, no Shopify/Apply/Rollback behavior change.
- **Status:** synced with `main`, audited, ready for final audit → PR.

**package.json conflict (resolved):** both PR #4 and this branch appended to the
`npm test` file list. The correct synced state includes **both** test files:

```
... src/__tests__/llm-call-hardening.test.js src/__tests__/product-opportunity.test.js
```

Post-sync full suite: **201/201 passing** (186 + 15 product-opportunity).

---

## C. Next approved task

**Sync is done.** Next: final audit of `data/product-opportunity-score-v1`, then open
PR (pure service + tests only, no runtime wiring). See the roadmap for full priority order.
