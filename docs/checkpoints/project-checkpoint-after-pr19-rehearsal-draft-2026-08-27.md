# Project Checkpoint — After PR19 and Before Rehearsal Plan Save

**Date:** 2026-08-27
**Applies from main:** `a4c79e6`
**Status:** Safe checkpoint before saving the non-client dev-store rehearsal plan.

---

## 1. Purpose

- Preserves the approved project state after PR #19.
- Records exactly what is complete, what remains blocked, and what the next safe step is.
- Prevents loss of context before the non-client dev-store rehearsal plan is cleaned and saved.
- Documentation-only. Changes no runtime behaviour.

---

## 2. Latest verified main state

| Item | Value |
|---|---|
| Current main | `a4c79e6` |
| Latest verified merge | PR #19 — Record Beta 0 scopes and data environment sign-off |
| Post-merge verdict | `PR_19_POST_MERGE_VERIFIED` |
| Contents | All approved guardrail code and Beta 0 documentation through PR #19 |

---

## 3. Completed major milestones

### Guardrail code

- **PR #14** — Controlled Beta write kill switch / read-only guards. Fail-closed; blocks mutating calls routed through `shopifyFetch`, plus the apply/rollback/execute routes. Coverage is not universal — see §9.
- **PR #15** — Diagnostics store allowlist gate. `PRODUCT_OPPORTUNITY_DIAGNOSTICS=true` alone is insufficient; the shop must also be allowlisted. Blocked requests 404 before any DB work.

### Beta 0 documentation and decisions

- **PR #16** — Controlled Beta 0 ops runbook.
- **PR #17** — Checkpoint + webhook lifecycle documentation.
- **PR #18** — `SHOPIFY_SCOPES` and data-environment decision record.
- **PR #19** — Owner sign-off for the scopes / data-environment decision.

---

## 4. Current signed decision

Signed 2026-08-25, recorded in `docs/decisions/shopify-scopes-and-data-environment-beta0.md`.

- `SHOPIFY_SCOPES=read_products,read_orders,read_analytics`
- **Accepted for non-client dev-store rehearsal use only.**
- No write scopes approved.
- No `write_products`.
- No `write_script_tags`.
- Fallback if needed: minimum read scope only, most likely `read_reports` — followed by a decision-record update, service restart, running-instance confirmation, and a **full non-client re-rehearsal**.
- Staging accepted for the non-client dev-store rehearsal only.
- A dedicated Beta 0 database/environment is required before any real merchant data.
- Staging is **not** approved for real merchant data by default.

---

## 5. What remains blocked

- Real-store Beta 0.
- Real-store OAuth install.
- Webhook lifecycle decision for a real merchant.
- Merchant consent.
- Apply.
- Rollback.
- Auto-Apply.
- Write scopes.
- Product / theme / cart / checkout / storefront mutation.
- Diagnostics on a real store.
- Real merchant data in staging.
- Production rollout.
- Public case study or uplift claims.

---

## 6. Current live next step

1. Clean the non-client dev-store rehearsal plan draft.
2. Save it as a docs artifact.
3. Review it.
4. Open a docs PR.
5. Merge only after a merge-safety review.

**Recommended future save path:** `docs/rehearsals/non-client-dev-store-rehearsal-plan-beta0.md`

The rehearsal plan draft exists in conversation but is **not yet saved**, because it needs cleanup first:

- remove duplicated sections;
- remove ASCII tables;
- convert to clean Markdown;
- remove repeated preflight / inputs blocks;
- preserve the safety wording exactly.

---

## 7. Dev-store rehearsal status

- Rehearsal is **not approved for execution**.
- Rehearsal plan **not saved**.
- No dev store connected.
- No install URL generated.
- No diagnostics run.
- No Shopify calls.
- No env changes.
- No Render configuration changes.
- No DB work.

Still required before the rehearsal may run:

- clean saved plan;
- plan review and merge;
- named non-client development store;
- env value setup;
- the five write-disable / diagnostics flags;
- diagnostics allowlist containing the dev store only;
- service restart;
- running-instance confirmation;
- webhook behaviour recording plan;
- run record location;
- operator and reviewer assignment.

---

## 8. Real-store Beta 0 status

**Real-store Beta 0 remains blocked.**

Still required:

- webhook lifecycle decision recorded;
- non-client dev-store rehearsal passed;
- runbook §22 sign-off (release owner + product owner — still blank, and separate from the scopes / data-environment sign-off);
- dedicated Beta 0 environment/database before any real merchant data;
- merchant consent;
- final go / no-go;
- real-store OAuth install separately approved later.

---

## 9. Webhook lifecycle status

- Webhook lifecycle remains **separate and open**.
- Current record: `docs/decisions/webhook-registration-lifecycle-beta0.md`
- Install-time `registerWebhooks` uses raw/global `fetch` and **bypasses the PR #14 kill switch**, producing no `BETA_READ_ONLY_WRITE_BLOCKED` event.
- The dev-store rehearsal may **inform** the decision.
- The rehearsal does **not** decide it.
- Real-store OAuth install remains blocked until the webhook lifecycle decision is recorded.

---

## 10. Data environment status

- Current staging is acceptable for the **non-client dev-store rehearsal only**.
- A dedicated Beta 0 environment/database is required before any real merchant data.
- The dedicated Beta 0 environment is **not yet provisioned**.
- Prisma migration-history reconciliation remains a likely long-lead item before a real-merchant-data environment can be provisioned.

---

## 11. Source-of-truth files

- `docs/controlled-beta-0-ops-runbook.md`
- `docs/project-checkpoint-current-status.md`
- `docs/decisions/webhook-registration-lifecycle-beta0.md`
- `docs/decisions/shopify-scopes-and-data-environment-beta0.md`
- `docs/checkpoints/project-checkpoint-after-pr19-rehearsal-draft-2026-08-27.md` (this file)

---

## 12. Safety summary

At this checkpoint:

- no runtime behaviour changed;
- no API code changed;
- no frontend changed;
- no Prisma changed;
- no Shopify write path changed;
- no Apply / Rollback changed;
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

## 13. Next recommended action

Clean the rehearsal-plan draft, then save it as `docs/rehearsals/non-client-dev-store-rehearsal-plan-beta0.md`.

**Do not run the rehearsal before the clean plan is saved, reviewed, and merged.**
