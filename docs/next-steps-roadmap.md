# Next Steps Roadmap

_Last updated: 2026-07-07. Approved next-step candidates only — planning, not implementation._

## Immediate

1. **Accept the PR #6 post-merge result as the current finalized checkpoint.**
   Main is `ac82ec8`, 231/231 green, Output Contract Validator PR 1A merged and inert.

## Next likely task (planning only)

2. **Output Contract Validator — PR 1B (generation-time wiring).** Planning first;
   implement only after a new explicit prompt. Constraints for PR 1B:
   - **Generation-time wiring only** — validate generator output where the fix is
     built in `action-center.service.js` (the ~L518–694 per-issue enrichment
     blocks that already fall back to template), before it becomes `generatedFix`.
   - On `severity:'fallback'` → use the existing template fallback. On `warn` →
     log only. A validator throw must be caught and never block generation.
   - **Must NOT** touch the Shopify write path.
   - **Must NOT** change Apply/Rollback.
   - **Must preserve preview/apply parity** (both read `generatedFix`).

## Deferred

3. **Apply-time validator guard (PR 1C):** deferred / likely unnecessary. The
   apply path already fail-closes via `validateContentSafety` and already catches
   `buildResultContent` errors. Only revisit if a PR 1B architecture review proves
   generation-time validation is insufficient. If ever built: extremely narrow,
   `warn`/log-first, must not duplicate `validateContentSafety`.

4. **ProductOpportunityScore runtime wiring:** separate track. If implemented,
   keep it behind a **flag / internal mode** — no auto-apply, no dashboard/public
   behavior until QA. Currently pure service only.

## Standing rules

- Do **not** proceed to any runtime wiring without a new explicit prompt.
- One scoped change per PR; every Shopify-write-path or runtime change must be
  small, tested, audited, merge-safety-checked, and post-merge verified.
- Intelligence features ship as pure service + tests first, wired later behind a flag.
