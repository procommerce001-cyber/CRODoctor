# Project Checkpoint — Current Status

_Last updated: 2026-07-14 (approved-state checkpoint after PR #6)_

Rolling engineering checkpoint. Companion docs:
[Release History](./release-history-approved-work.md) ·
[Output Contract Validator PR 1A](./output-contract-validator-pr1a-summary.md) ·
[Next Steps Roadmap](./next-steps-roadmap.md) ·
[Claude Memory / Handoff](./claude-project-memory-approved-state.md)

## Verified main status

- **HEAD:** `ac82ec8` (Merge PR #6), == `origin/main`, working tree clean.
- **No commits on main after `ac82ec8`.**
- **Full API test suite:** **231/231** (verified at PR #6 merge).
- **Previous docs checkpoint:** branch `docs/project-checkpoint-after-pr6`, commit `8168f40` (pushed, no PR).

## Approved merged work

### PR #4 — LLM Call Hardening
- **Branch:** `hardening/llm-retry-system-messages` · **Merge:** `ca6304b` (orig `66baa79`)
- **Status / verdict:** merged, **PR_4_POST_MERGE_VERIFIED**
- **Changed:** 3 raw-`fetch` generators → `callAnthropicWithRetry`; top-level `system: CRO_SYSTEM_MESSAGE` on all 5 generators; new `system-message.js` + `llm-call-hardening.test.js`.
- **Did NOT change:** Shopify write path, Action Center, Apply/Rollback, DB/schema, deps/lockfile.
- **Tests:** 186/186 at merge.

### PR #5 — ProductOpportunityScore v1
- **Branch:** `data/product-opportunity-score-v1` · **Merge:** `a6c1b9c`
- **Status / verdict:** merged, **PR_5_POST_MERGE_VERIFIED**
- **Changed:** pure `product-opportunity.service.js` + 15 tests; package.json test-line.
- **Did NOT change:** runtime wiring, customer-facing behavior, Shopify write path, Action Center, Apply/Rollback, DB/schema.
- **Tests:** 201/201 after merge.

### PR #6 — Output Contract Validator PR 1A
- **Branch:** `hardening/output-contract-validator-pr-1a` · **Merge:** `ac82ec8` (orig `f2a2709`)
- **Status / verdict:** merged, **PR_6_POST_MERGE_VERIFIED**
- **Changed:** `cro/output-contracts.js` (registry), `cro/output-contract-validator.js` (pure validator), `output-contract-validator.test.js` (30 tests); package.json test-line.
- **Did NOT change:** runtime wiring, action-center, content-execution, content-safety-validator, generators, Shopify write path, Apply/Rollback, DB/schema, deps/lockfile.
- **Tests:** 231/231.

## Production-safety state

- No Shopify write-path changes from PR #5 / #6.
- No Action Center runtime changes from PR #5 / #6.
- No Apply/Rollback changes from PR #4 / #5 / #6.
- No DB / schema / migration changes across these PRs.
- No frontend changes from PR #5 / #6.
- Existing fail-closed apply-time gate (`validateContentSafety` → `buildResultContent` → `wrapIssueContent` → orphan-safe two-phase write) untouched.

## Important note

- **Output Contract Validator PR 1A is NOT wired into runtime yet.**
- **ProductOpportunityScore v1 is NOT wired into runtime yet.**
- No next implementation is approved. Wiring requires a new explicit prompt.

> Test-dir note: suites live under `api/src/__tests__/` (repo convention + `npm test` wiring), not `api/src/tests/`.
