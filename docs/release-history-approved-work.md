# Release History — Approved Work

_Last updated: 2026-07-07. Chronological record of merged, post-merge-verified PRs._

## PR #4 — LLM Call Hardening
- **Branch:** `hardening/llm-retry-system-messages`
- **Merge status:** merged (`ca6304b`), orig commit `66baa79` — **PR_4_POST_MERGE_VERIFIED**
- **Key files:** `cro/generators/description-llm.js`, `desire-block-llm.js`, `short-description-llm.js` (raw fetch → `callAnthropicWithRetry`); those + `risk-reversal-llm.js`, `trust-bullets-llm.js` (top-level `system`); new `cro/generators/system-message.js`; `__tests__/llm-call-hardening.test.js`; `package.json` (test-line).
- **Test count:** 186/186 at merge.
- **Safety summary:** LLM call reliability + system-prompt guardrails only. No Shopify write path, Action Center, Apply/Rollback, DB, or dependency changes.

## PR #5 — ProductOpportunityScore v1
- **Branch:** `data/product-opportunity-score-v1`
- **Merge status:** merged (`a6c1b9c`), commits `b19bc50` + `ae62ce0` + sync `ab22786` — **PR_5_POST_MERGE_VERIFIED**
- **Key files:** `services/product-opportunity.service.js` (pure scoring service), `__tests__/product-opportunity.test.js` (15 tests), `package.json` (test-line).
- **Test count:** 201/201 after merge.
- **Safety summary:** pure backend intelligence service; no runtime wiring, no customer-facing behavior, no Shopify write path, no Action Center, no DB/schema change.

## PR #6 — Output Contract Validator PR 1A
- **Branch:** `hardening/output-contract-validator-pr-1a`
- **Merge status:** merged (`ac82ec8`), orig commit `f2a2709` — **PR_6_POST_MERGE_VERIFIED**
- **Key files:** `services/cro/output-contracts.js` (registry), `services/cro/output-contract-validator.js` (pure validator), `__tests__/output-contract-validator.test.js` (30 tests), `package.json` (test-line).
- **Test count:** 231/231 (30 new).
- **Safety summary:** pure, validate-only helper; no runtime wiring; complements — does not replace — `validateContentSafety`; no write-path/Action Center/Apply-Rollback/DB changes.

## Cumulative test growth
186 (PR #4) → 201 (PR #5) → 231 (PR #6).
