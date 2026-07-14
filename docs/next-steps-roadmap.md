# Next Steps Roadmap

_Last updated: 2026-07-14. Approved next-step candidates only — planning, not implementation._

## Current checkpoint

- PR #4, PR #5, PR #6 are merged and post-merge verified. Main `ac82ec8`, 231/231.
- Output Contract Validator PR 1A and ProductOpportunityScore v1 both exist on main but are **inert** (not runtime-wired).

## Next likely planning task

1. **Review current system state and prioritize** next tasks against the external audit.

## Likely next engineering candidate (planning only)

2. **Output Contract Validator — PR 1B (generation-time wiring).** Implement only
   after a separate planning review approves exact scope. Constraints:
   - **Generation-time wiring only** (validate generator output in
     `action-center.service.js` before it becomes `generatedFix`; fall back to
     template on `severity:'fallback'`; `warn` logs only; a validator throw must
     be caught and never block generation).
   - **Must NOT** touch the Shopify write path.
   - **Must NOT** change Apply/Rollback.
   - **Must preserve preview/apply parity.**
   - Must have its own planning prompt, implementation prompt, audit, merge-safety
     check, and post-merge verification.

## Deferred

3. **Apply-time validator guard (PR 1C):** deferred / likely unnecessary — the apply
   path already fail-closes via `validateContentSafety` and catches
   `buildResultContent` errors. Only revisit if a PR 1B review proves generation-time
   validation is insufficient.

4. **ProductOpportunityScore runtime wiring:** separate track; if implemented, keep
   behind a **flag / internal mode** (no auto-apply, no dashboard/public until QA).

## Standing rules

- Do **not** proceed to any runtime wiring without a new explicit prompt.
- Small, audited PRs only; no Shopify-write-path changes without explicit approval;
  no broad refactors; no unapproved DB/schema/migration/env/dependency/frontend changes.
