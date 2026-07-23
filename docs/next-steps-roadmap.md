# CRODoctor — Next-Steps Roadmap (Candidates Only)

Approved *candidates* for future work. This document lists direction only — it is
**not** an implementation approval. Every item requires a fresh, explicit prompt and
its own planning pass before any runtime change.

## Immediate
1. **Accept PR #7 checkpoint as the current baseline.** Main `c3e0bb6`, 245/245,
   Output Contract Validator wired at generation-time.

## Candidate next steps (each needs its own planning task)
2. **Output Contract Validator PR 1C (planning first).** Review whether variants
   beyond index 0 need deep contract checking. Would require a validator change;
   plan before implementing.
3. **ProductOpportunityScore runtime wiring (behind flag / internal mode only).**
   Plan a gated, internal-only wiring path. Keep separate from Output Contract
   Validator follow-up work.
4. **IssueRouter / declarative issue registry (planning).** Consider consolidating
   the repeated per-issue generation blocks. Behavior-neutral; plan first.
5. **Post-generation dedup / consistency pass (planning).**
6. **Shared LLM config** for hardcoded model strings.
7. **Generator contract docs** — document each generator's expected output shape.
8. **TrustBullets disabled/dead-code cleanup** — the `no_trust_bullets` LLM path is
   intentionally disabled today; consider a scoped cleanup.

## Standing rules
- Do **not** proceed to runtime wiring without a new explicit prompt.
- Do **not** touch the Shopify write path unless separately justified and approved.
- Do **not** add an apply-time contract guard unless a planning review proves it
  necessary.
- Do **not** combine ProductOpportunityScore wiring with Output Contract Validator
  follow-up work.
- Keep PRs small, audited, merge-safety checked, and post-merge verified.
