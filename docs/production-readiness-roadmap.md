# Production Readiness Roadmap

_Last updated: 2026-07-05_

Prioritized plan derived from the [external LLM pipeline audit](./llm-pipeline-external-audit-summary.md)
and current [project status](./project-checkpoint-current-status.md).

## Priority order

| Pri | Item | Status |
|-----|------|--------|
| P0 | PR #4 — LLM Call Hardening (retry + system messages) | ✅ Completed, merged (`ca6304b`), post-merge verified |
| P1 | Sync `data/product-opportunity-score-v1` with `main` | ✅ Done (sync commit `ab22786`, 201/201 tests) |
| P1 | Merge ProductOpportunityScore v1 (pure service + tests only, no runtime wiring) | ⏭️ Next: final audit → PR |
| P1.5 | Output Contract Validator — **PR 1A**: pure validator/helper + tests, no wiring | Pending |
| P1.5 | Output Contract Validator — **PR 1B**: wire validator (fail-closed / safe fallback) before output progresses toward Shopify write | Pending (after 1A) |
| P1.5 / P2 | Connect ProductOpportunityScore behind flag/internal mode (no auto-apply, no dashboard/public until QA) | After merge + verify |
| P2 | IssueRouter / declarative registry | Later |
| P2 | Deduplication + consistency pass across generators | Later |
| P2 | Shared LLM config (move hardcoded model strings) | Later, not urgent |
| P2/P3 | Generator contract documentation | Later |
| P3 | TrustBullets dead-code cleanup (disabled LLM path) | Later, not a blocker |

## Detail on selected items

### Output Contract Validator (P1.5)

The narrowed, legitimate remainder of the external audit's "P0". Complements the
existing fail-closed safety gate (`validateContentSafety` / `buildResultContent` /
`wrapIssueContent`), it does not replace it. Enforce per-issue output shape:

- plain text vs HTML
- required fields present
- placement / wrapper rules
- no malformed output
- no double wrapping
- no raw unsafe shape

**Split into two PRs:** 1A pure validator + tests (no runtime wiring); 1B careful
wiring, fail-closed or safe fallback, before LLM output progresses toward the
Shopify write path.

### IssueRouter / declarative registry (P2)

Make routing explicit: `issueType →` generator, output contract, placement strategy,
measurement target, rollback behavior.

## Ways of working (project rules)

- **Do NOT** run broad "fix all audit issues" prompts.
- **Do NOT** bundle multiple architectural changes in one PR.
- Every Shopify write-path change must be: small, scoped, tested, audited,
  merge-safety checked, post-merge verified.
- Every intelligence feature ships first as a **pure service + tests, no runtime
  behavior**, then is wired later behind a flag / internal mode.
- Do **not** touch `action-center.service.js`, the Shopify write path, or
  Apply/Rollback unless the task explicitly requires it and is scoped + audited.

## Do NOT do now (explicit hold list)

- No broad audit-fix PR.
- No full `action-center.service.js` refactor.
- No autonomous Shopify writes.
- No ProductOpportunityScore runtime wiring before merge + QA.
- No deleting branches before post-merge verification.
