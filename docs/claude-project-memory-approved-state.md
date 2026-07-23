# CRODoctor — Claude/Project Handoff Memory (Approved State)

Concise handoff for future Claude sessions. Point-in-time; verify against current
code before asserting as fact.

## Project
- **Name:** CRODoctor
- **Repo path:** `/Users/dekelhilel/Desktop/CRODoctor`
- **Verified main HEAD:** `c3e0bb6` (after PR #7)
- **Test status:** 245/245 (full API suite, `cd api && npm test`)
- **Tests directory:** `api/src/__tests__/` (each test file is enumerated in `api/package.json` `test` script — a new test file must be added there or it won't run).

## Approved completed PRs
- **PR #4** — LLM Call Hardening — merge `ca6304b` — `PR_4_POST_MERGE_VERIFIED`.
- **PR #5** — ProductOpportunityScore v1 — merge `a6c1b9c` — `PR_5_POST_MERGE_VERIFIED`. Pure service, NOT wired.
- **PR #6** — Output Contract Validator PR 1A — merge `ac82ec8` — `PR_6_POST_MERGE_VERIFIED`. Pure helper + registry, NOT wired.
- **PR #7** — Output Contract Validator PR 1B — merge `c3e0bb6` (commits `acdd3df`, `240244a`) — `PR_7_POST_MERGE_VERIFIED`. Generation-time wiring via `acceptGeneratorOutput` in `action-center.service.js`; 5 call sites wired.

## Current safety status
- Output Contract Validator wired at **generation-time only** (not apply-time).
- ProductOpportunityScore still **not** wired into runtime.
- Shopify write path **unchanged**.
- Apply/Rollback **unchanged**.
- `validateContentSafety` **unchanged**.
- No DB / schema / migration / frontend / dependency / lockfile changes.

## Known deferred
- Validator deeply checks `bestGuess` + `variants[0]` only; variants beyond index 0
  not deeply checked. Possible future scoped "PR 1C" (planning first; needs validator change).

## Current next-step rule
- Do **not** implement further runtime changes without a separate planning approval / explicit prompt.

## Standing safety rules
- Small, audited PRs only.
- No broad refactors.
- No unapproved Shopify write-path changes.
- No unapproved DB / schema / migration / env / dependency / frontend changes.
- Always run: branch audit → merge safety check → post-merge verification.
