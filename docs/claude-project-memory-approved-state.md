# Claude Project Memory — Approved State (Handoff)

_Last updated: 2026-07-14. Concise handoff for future Claude sessions._

- **Project:** CRODoctor
- **Repo path:** `/Users/dekelhilel/Desktop/CRODoctor`
- **Main verified state:** `ac82ec8` (after PR #6). No commits after it.

## Approved completed PRs

- **PR #4 — LLM Call Hardening** — merge `ca6304b` (orig `66baa79`), `PR_4_POST_MERGE_VERIFIED`.
- **PR #5 — ProductOpportunityScore v1** — merge `a6c1b9c`, `PR_5_POST_MERGE_VERIFIED`.
- **PR #6 — Output Contract Validator PR 1A** — merge `ac82ec8` (orig `f2a2709`), `PR_6_POST_MERGE_VERIFIED`.

## Current test status

- **231/231** passing after PR #6. Tests live under `api/src/__tests__/`.

## Current safety status

- **No runtime wiring** for Output Contract Validator (PR 1A) — inert.
- **No runtime wiring** for ProductOpportunityScore v1 — inert.
- No Shopify write-path changes.
- No Action Center changes from PR #5 / #6.
- No Apply/Rollback changes.

## Next-step rule

- **Do not implement PR 1B** (Output Contract Validator generation-time wiring)
  until a separate planning review approves the exact scope.

## Standing safety rules

- Small, audited PRs only.
- No runtime wiring without explicit approval.
- No Shopify write-path changes without explicit approval.
- No broad refactors.
- No unapproved DB / schema / migration / env / dependency / frontend changes.

## Prior docs checkpoints (pushed, unmerged, no PR)

- `docs/project-checkpoint-after-pr6` — `8168f40`
- `docs/project-checkpoint-approved-state-2026-07-14` — this checkpoint
