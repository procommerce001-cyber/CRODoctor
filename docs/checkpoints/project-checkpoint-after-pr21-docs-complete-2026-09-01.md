# Project Checkpoint — After PR21 Documentation Track Complete

**Date:** 2026-09-01
**Applies from main:** `00703b4`
**Status:** Documentation track complete; operational rehearsal not started.

---

## 1. Purpose

- Preserves the approved project state after PR #21.
- Records that the documentation, decision, sign-off, checkpoint, and rehearsal-plan track is complete.
- Clarifies what remains operationally blocked before any rehearsal or real-store Beta 0.
- Changes no runtime behaviour.

---

## 2. Latest verified main state

- Current main: `00703b4`
- PR #21 merged and verified.
- Latest post-merge verdict: `PR_21_POST_MERGE_VERIFIED`
- Main includes all approved guardrails and documentation through PR #21.
- No runtime behaviour changed by PR #21. It added a markdown plan and edited three lines of another markdown file.

---

## 3. Completed milestones

- **PR #14** — Controlled Beta write kill switch / read-only guards. Fail-closed for calls routed through `shopifyFetch`; coverage is not universal, see Section 10.
- **PR #15** — Diagnostics store allowlist gate. The global flag alone is not sufficient; blocked requests 404 before any DB work.
- **PR #16** — Controlled Beta 0 ops runbook.
- **PR #17** — Checkpoint and webhook lifecycle documentation.
- **PR #18** — `SHOPIFY_SCOPES` and data-environment decision record.
- **PR #19** — Owner sign-off for the scopes / data-environment decision.
- **PR #20** — Checkpoint after PR19 and rehearsal draft.
- **PR #21** — Non-client dev-store rehearsal plan saved, including the embedded app UI visibility check.

---

## 4. Current source-of-truth files

- `docs/controlled-beta-0-ops-runbook.md`
- `docs/project-checkpoint-current-status.md`
- `docs/decisions/webhook-registration-lifecycle-beta0.md`
- `docs/decisions/shopify-scopes-and-data-environment-beta0.md`
- `docs/checkpoints/project-checkpoint-after-pr19-rehearsal-draft-2026-08-27.md`
- `docs/checkpoints/project-checkpoint-after-pr21-docs-complete-2026-09-01.md` (this file)
- `docs/rehearsals/non-client-dev-store-rehearsal-plan-beta0.md`

---

## 5. Current approved / signed decisions

Signed 2026-08-25, recorded in `docs/decisions/shopify-scopes-and-data-environment-beta0.md`.

- `SHOPIFY_SCOPES=read_products,read_orders,read_analytics`
- Accepted for non-client dev-store rehearsal use only.
- No write scopes approved.
- No `write_products`.
- No `write_script_tags`.
- Fallback if needed: minimum read scope only, most likely `read_reports`, followed by a decision-record update, service restart, running-instance confirmation, and a full non-client re-rehearsal.
- Staging accepted for the non-client dev-store rehearsal only.
- A dedicated Beta 0 database or environment is required before any real merchant data.
- Staging is not approved for real merchant data by default.

---

## 6. Current rehearsal status

- A non-client dev-store rehearsal plan exists on main.
- File: `docs/rehearsals/non-client-dev-store-rehearsal-plan-beta0.md`
- Plan status: draft plan only — not approved for execution.
- The rehearsal has not started.
- No dev store connected.
- No install URL generated.
- No OAuth install started.
- No diagnostics run.
- No Shopify calls made.
- No env values changed.
- No Render configuration changes.
- No DB work.

---

## 7. What remains blocked

- Real-store Beta 0.
- Real-store OAuth install.
- Webhook lifecycle decision for a real merchant.
- Merchant consent.
- Apply.
- Rollback.
- Auto-Apply.
- Write scopes.
- Product, theme, cart, checkout, or storefront mutation.
- Diagnostics on a real store.
- Real merchant data in staging.
- Production rollout.
- Public case study or uplift claims.

---

## 8. Operational next step

The documentation track is complete.

The next step is **operational readiness** for the non-client dev-store rehearsal, not more documentation by default. Every remaining item is a human decision or a configuration act.

Before any install URL or Shopify interaction, the owner or operator must provide:

- non-client development store domain;
- confirmation the store is not a client or merchant store;
- confirmation the store contains only fake or synthetic data;
- operator;
- reviewer;
- abort owner;
- cleanup and offboarding owner;
- run record location;
- planned date and time window;
- env setup owner;
- service restart owner;
- running-instance confirmation method that does not expose secrets;
- webhook behaviour recording method;
- explicit approval to run the rehearsal against the named non-client dev store only.

---

## 9. Required gates before any install URL

- `SHOPIFY_SCOPES=read_products,read_orders,read_analytics`
- `CONTROLLED_BETA_READ_ONLY=true`
- `DISABLE_SHOPIFY_WRITES=true`
- `APPLY_DISABLED=true`
- `PRODUCT_OPPORTUNITY_DIAGNOSTICS=true`
- `DIAGNOSTICS_STORE_ALLOWLIST=<devstore>.myshopify.com`
- Allowlist contains the non-client dev store only.
- No real store domain appears in any allowlist.
- Service restarted after the env changes.
- Running instance confirmed after restart.
- Operator understands the expected `BETA_READ_ONLY_WRITE_BLOCKED` event from `ensureScriptTag`.
- Operator understands webhook registration bypasses the kill switch and will not produce a blocked event.
- Tracker-registration endpoints are not called.
- Apply, Rollback, Auto-Apply, Batch Apply, and Decision Execute are not called.

The restart and running-instance gates are not formalities. `SHOPIFY_SCOPES` is captured at module load, so without a confirmed restart the install URL is built from the old scope set.

---

## 10. Remaining blockers before real-store Beta 0

- Webhook lifecycle decision recorded. It remains open; install-time `registerWebhooks` uses raw global `fetch` and bypasses the PR #14 kill switch, producing no blocked event.
- Non-client dev-store rehearsal passed.
- Runbook section 22 sign-off. Both rows are still blank, and this is separate from the scopes and data-environment sign-off.
- Dedicated Beta 0 database or environment provisioned before any real merchant data. It is not yet provisioned.
- Merchant consent captured.
- Final go or no-go completed.
- Real-store OAuth install separately approved later.

A successful rehearsal will not make real-store Beta 0 automatic.

---

## 11. Safety summary at this checkpoint

At this checkpoint:

- no runtime behaviour changed;
- no API code changed;
- no frontend changed;
- no Prisma changed;
- no Shopify write path changed;
- no Apply or Rollback changed;
- no ProductOpportunityScore changed;
- no Store Baseline changed;
- no DB connection;
- no Shopify call;
- no Anthropic call;
- no external API call;
- no real store connected;
- no OAuth install started;
- no diagnostics run;
- no manual deploy.

---

## 12. Next recommended action

The next recommended action is a readiness review before execution, using the merged rehearsal plan.

That review should collect:

- dev store domain;
- synthetic-data confirmation;
- operator, reviewer, abort owner, and cleanup owner;
- run record location;
- env setup plan;
- restart plan;
- running-instance confirmation method;
- webhook recording method;
- explicit owner approval for non-client dev-store rehearsal execution only.

Do not run the rehearsal before this readiness review is complete and explicitly approved.
