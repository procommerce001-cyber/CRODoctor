# CRODoctor — Release History (Approved Work)

Chronological record of approved, merged, and post-merge-verified work. Current
verified main: `c3e0bb6` (after PR #7), full suite 245/245.

---

## PR #4 — LLM Call Hardening
- **Branch:** `hardening/llm-retry-system-messages`
- **Merge commit:** `ca6304b`
- **Status:** Merged, post-merge verified — `PR_4_POST_MERGE_VERIFIED`
- **High-level files:** LLM generators + retry helper + system-message support + `llm-call-hardening.test.js`.
- **Tests:** 186/186 at that stage.
- **Safety summary:** No Shopify write path, Action Center runtime, or Apply/Rollback change.

## PR #5 — ProductOpportunityScore v1
- **Branch:** `data/product-opportunity-score-v1`
- **Merge commit:** `a6c1b9c`
- **Status:** Merged, post-merge verified — `PR_5_POST_MERGE_VERIFIED`
- **High-level files:** `product-opportunity.service.js` (pure) + tests.
- **Tests:** 201/201.
- **Safety summary:** Pure backend service, NOT runtime-wired. No customer-facing or Shopify write path change.

## PR #6 — Output Contract Validator PR 1A
- **Branch:** `hardening/output-contract-validator-pr-1a`
- **Merge commit:** `ac82ec8` (PR commit `f2a2709`)
- **Status:** Merged, post-merge verified — `PR_6_POST_MERGE_VERIFIED`
- **High-level files:** `cro/output-contracts.js` (registry) + `cro/output-contract-validator.js` (pure helper) + validator tests.
- **Tests:** 231/231.
- **Safety summary:** Pure helper + registry, NOT runtime-wired. No customer-facing, Action Center runtime, or Shopify write path change.

## PR #7 — Output Contract Validator PR 1B (generation-time wiring)
- **Branch:** `hardening/output-contract-validator-pr-1b`
- **Merge commit:** `c3e0bb6`
- **Key commits:** `acdd3df` (wire), `240244a` (move test to `__tests__`)
- **Status:** Merged, post-merge verified — `PR_7_POST_MERGE_VERIFIED`
- **High-level files:** `action-center.service.js` (require + `acceptGeneratorOutput` helper + 5 call-site wraps + additive export); `api/src/__tests__/output-contract-wiring.test.js` (14 cases); `package.json` (test-script path only).
- **Tests:** 245/245.
- **Safety summary:** Generation-time wiring only. Invalid LLM output falls back to existing template behavior; valid/warn passes unchanged; validator throw fails open. No Shopify write path, Apply/Rollback, `validateContentSafety`, `buildResultContent`/`wrapIssueContent`, or generator change. No logging, no refactor.

---

## Docs checkpoints
- `docs/project-checkpoint-after-pr6` — commit `8168f40`.
- `docs/project-checkpoint-approved-state-2026-07-14` — commit `ea2ed24`.
- `docs/project-checkpoint-after-pr7-2026-07-19` — this checkpoint (docs-only, saved after PR #7 verification).
