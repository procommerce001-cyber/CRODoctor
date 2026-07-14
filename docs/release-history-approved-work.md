# Release History — Approved Work

_Last updated: 2026-07-14. Chronological record of merged, post-merge-verified work._

## PR #4 — LLM Call Hardening
- **Branch:** `hardening/llm-retry-system-messages` · **Merge:** `ca6304b` (orig `66baa79`)
- **Status:** merged — **PR_4_POST_MERGE_VERIFIED**
- **Key files:** LLM generators (raw fetch → `callAnthropicWithRetry`; top-level `system`); new `system-message.js`; `llm-call-hardening.test.js`; `package.json` (test-line).
- **Test count:** 186/186 at merge.
- **Safety summary:** call reliability + system-prompt guardrails only. No Shopify write path, Action Center, Apply/Rollback, DB, or dependency changes.

## PR #5 — ProductOpportunityScore v1
- **Branch:** `data/product-opportunity-score-v1` · **Merge:** `a6c1b9c`
- **Status:** merged — **PR_5_POST_MERGE_VERIFIED**
- **Key files:** `product-opportunity.service.js` (pure service), `product-opportunity.test.js` (15 tests), `package.json` (test-line).
- **Test count:** 201/201 after merge.
- **Safety summary:** pure backend intelligence; no runtime wiring, no customer-facing behavior, no Shopify write path, no Action Center, no DB/schema change.

## PR #6 — Output Contract Validator PR 1A
- **Branch:** `hardening/output-contract-validator-pr-1a` · **Merge:** `ac82ec8` (orig `f2a2709`)
- **Status:** merged — **PR_6_POST_MERGE_VERIFIED**
- **Key files:** `cro/output-contracts.js` (registry), `cro/output-contract-validator.js` (pure validator), `output-contract-validator.test.js` (30 tests), `package.json` (test-line).
- **Test count:** 231/231 (30 new).
- **Safety summary:** pure, validate-only helper; no runtime wiring; complements — does not replace — `validateContentSafety`; no write-path / Action Center / Apply-Rollback / DB changes.

## Docs checkpoint after PR #6
- **Branch:** `docs/project-checkpoint-after-pr6` · **Commit:** `8168f40` — "Document project checkpoint after output contract validator"
- **Status:** pushed to GitHub as a docs-only checkpoint branch. No PR opened, no merge, no deploy.

## Cumulative test growth
186 (PR #4) → 201 (PR #5) → 231 (PR #6).
