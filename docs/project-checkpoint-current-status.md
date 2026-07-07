# Project Checkpoint — Current Status

_Last updated: 2026-07-07 (after PR #6 merge + post-merge verification)_

Rolling engineering checkpoint. Records what is merged, what is
implemented-but-unwired, and the production-safety state. Companion docs:

- [Release History — Approved Work](./release-history-approved-work.md)
- [Output Contract Validator PR 1A Summary](./output-contract-validator-pr1a-summary.md)
- [Next Steps Roadmap](./next-steps-roadmap.md)

## Verified main status

- **HEAD:** `ac82ec8` (Merge PR #6), == `origin/main`, working tree clean.
- **Full API test suite:** **231/231 passing, 0 failures.**

## Approved merged work

### PR #4 — LLM Call Hardening
- **Status:** merged + post-merge verified — **PR_4_POST_MERGE_VERIFIED**
- **Commits:** orig `66baa79`, merge `ca6304b`
- **What changed:** three raw-`fetch` generators moved to `callAnthropicWithRetry`; top-level `system: CRO_SYSTEM_MESSAGE` added to all five relevant generators; new `system-message.js` + `llm-call-hardening.test.js`.
- **What did NOT change:** no Shopify write path, no `action-center.service.js`, no Apply/Rollback, no DB/schema, no deps/lockfile.
- **Tests:** 186/186 at merge.

### PR #5 — ProductOpportunityScore v1
- **Status:** merged + post-merge verified — **PR_5_POST_MERGE_VERIFIED**
- **Commits:** `b19bc50`, `ae62ce0`, sync `ab22786`; merge `a6c1b9c`
- **What changed:** `product-opportunity.service.js` (pure scoring service) + `product-opportunity.test.js` (15 tests); package.json test-line.
- **What did NOT change:** no runtime wiring, no customer-facing behavior, no Shopify write path, no Action Center, no Apply/Rollback, no DB/schema.
- **Tests:** 201/201 after merge.

### PR #6 — Output Contract Validator PR 1A
- **Status:** merged + post-merge verified — **PR_6_POST_MERGE_VERIFIED**
- **Commits:** orig `f2a2709`, merge `ac82ec8`
- **What changed:** `cro/output-contracts.js` (registry), `cro/output-contract-validator.js` (pure `validateGeneratorOutputContract`), `output-contract-validator.test.js` (30 tests); package.json test-line.
- **What did NOT change:** **no runtime wiring**, no `action-center.service.js`, no `content-execution.service.js`, no `content-safety-validator.js`, no generators, no Shopify write path, no Apply/Rollback, no DB/schema, no deps/lockfile.
- **Tests:** 231/231 (30 new).

## Production-safety state

- No Shopify write-path changes from PR #4 / #5 / #6.
- No Action Center changes from PR #5 / #6.
- No Apply/Rollback changes from PR #4 / #5 / #6.
- No DB / schema / migration changes across these PRs.
- No frontend changes from PR #5 / #6.
- The existing fail-closed write-path safety gate (`validateContentSafety` →
  `buildResultContent` → `wrapIssueContent` → orphan-safe two-phase write) is
  untouched and remains the sole apply-time gate.

## Important note

**The Output Contract Validator (PR 1A) is NOT wired into runtime yet.** It is a
pure helper + registry + tests only. Wiring is a separate, future PR 1B that must
be planned, scoped, audited, and merge-verified on its own. See the roadmap.

> Test-dir note: all suites live under `api/src/__tests__/` (the repo's real test
> directory + `npm test` wiring), not `api/src/tests/`.
