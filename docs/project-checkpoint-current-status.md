# CRODoctor — Project Checkpoint: Current Status (after PR #7)

**Checkpoint date:** 2026-07-19
**Verified main HEAD:** `c3e0bb6` (Merge PR #7)
**Full API test suite:** 245/245 passing
**Overall verdict:** `PR_7_POST_MERGE_VERIFIED`

Main is clean. All four hardening PRs below are merged and post-merge verified.

---

## Approved merged work

### PR #4 — LLM Call Hardening
- **Merge commit:** `ca6304b`
- **Status:** Merged, post-merge verified — `PR_4_POST_MERGE_VERIFIED`
- **What changed:** Hardened LLM generator calls (retry helper usage where needed); added top-level system messages to the relevant LLM generators.
- **What did NOT change:** No Shopify write path change. No Action Center runtime change. No Apply/Rollback change.
- **Tests after merge:** green (186/186 at that stage).

### PR #5 — ProductOpportunityScore v1
- **Merge commit:** `a6c1b9c`
- **Status:** Merged, post-merge verified — `PR_5_POST_MERGE_VERIFIED`
- **What changed:** Added `ProductOpportunityScore v1` as a pure backend service plus tests only.
- **What did NOT change:** No runtime wiring. No customer-facing behavior change. No Shopify write path change.
- **Tests after merge:** 201/201.
- **Note:** Still NOT wired into runtime.

### PR #6 — Output Contract Validator PR 1A
- **Merge commit:** `ac82ec8`
- **Status:** Merged, post-merge verified — `PR_6_POST_MERGE_VERIFIED`
- **What changed:** Added the Output Contract Validator as a pure helper (`validateGeneratorOutputContract`) + contracts registry (`output-contracts.js`) + tests only.
- **What did NOT change:** No runtime wiring. No customer-facing behavior change. No Shopify write path change. No Action Center runtime change.
- **Tests after merge:** 231/231.

### PR #7 — Output Contract Validator PR 1B (generation-time wiring)
- **Merge commit:** `c3e0bb6`
- **Key commits:** `acdd3df` (wire output contract validation into generation flow), `240244a` (move test to standard `__tests__` directory)
- **Status:** Merged, post-merge verified — `PR_7_POST_MERGE_VERIFIED`
- **What changed:**
  - Added `acceptGeneratorOutput(issueType, output, validatorOverride)` helper in `action-center.service.js` (pure, synchronous, never throws, no logging, no mutation).
  - Wired five generation call sites: `no_risk_reversal`, `no_trust_bullets`, `no_description`, `description_too_short`, `weak_desire_creation`.
  - `weak_desire_creation` validates only the LLM side of `??`; `generateDesireBlock(rawProduct, copyPlan)` remains the untouched terminal fallback.
  - Behavior: valid/warn LLM output passes through unchanged; invalid output → `null` → existing template fallback; validator throw → fail open to current behavior.
  - Added test file `api/src/__tests__/output-contract-wiring.test.js` (14 cases).
- **What did NOT change:** No Shopify write path change. No Apply/Rollback change. No `validateContentSafety` change. No `buildResultContent` / `wrapIssueContent` change. No generator logic change. No template fallback validation. No logging. No refactor.
- **Tests after merge:** 245/245.

---

## Current production safety state
- Shopify write path: **unchanged** by PR #5/#6/#7.
- Apply/Rollback: **unchanged** by PR #5/#6/#7.
- `validateContentSafety`: **unchanged** by PR #7.
- `buildResultContent` / `wrapIssueContent`: **unchanged** by PR #7.
- DB / schema / migrations: **unchanged**.
- Frontend: **unchanged**.
- Dependencies / lockfiles: **unchanged**.

---

## Important notes
- The Output Contract Validator is now wired at **generation-time only**. It is **not** wired at apply-time. Because preview and apply both read the same `generatedFix` source, the generation-time gate already protects both — no apply-time guard was added.
- `ProductOpportunityScore v1` is still **not** wired into runtime.
- **Known deferred:** the validator checks `bestGuess` and `variants[0]`; variants beyond index 0 are not deeply contract-checked. Not a blocker — candidate for a future scoped planning task (PR 1C), not part of this checkpoint.
