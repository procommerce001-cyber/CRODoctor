# CRODoctor — Current Approved Project State

**Last updated:** 2026-08-22
**Checkpoint after:** PR #16 — Add controlled Beta 0 ops runbook

> **This checkpoint does not approve Beta 0.** No real Shopify store may be connected, no OAuth install may be started, and no diagnostics may be run against a real store. See Sections 4 and 5.

---

## 1. Current approved main

| Item | Value |
|---|---|
| Main commit | `9a59f4c` |
| Latest verified PR | PR #16 — Add controlled Beta 0 ops runbook |
| Latest verdict | `PR_16_DOCS_POST_MERGE_VERIFIED` |
| Date | 2026-08-22 |
| Status | **Code guardrails + Beta 0 runbook are now on main** |
| Full test suite (last run, at `4c4bee9`) | 320/320 passing, 19 suites |

PR #16 was documentation-only: the merge added `docs/controlled-beta-0-ops-runbook.md` and changed nothing else. Any deployment around these merges was **automatic preview/CI only** — no manual deploy has been performed, and no production runtime behavior changed as a result of PR #16.

---

## 2. Completed guardrails and foundation

| PR | Purpose | Status | Safety note |
|---|---|---|---|
| **#10** | ProductOpportunityScore diagnostics endpoint behind `PRODUCT_OPPORTUNITY_DIAGNOSTICS` flag | Merged + verified (`eed382b`) | Default off → 404. Pure adapter, LLM-free. Observation only; does not affect ranking or merchant-facing behavior. |
| **#11** | Store Baseline Engine architecture plan | Merged (`c1c828d`) | Docs-only plan; no runtime change. |
| **#12** | Store Baseline internal helper (Option A) | Merged + verified (`01d305f`) | Pure helper, observation-only on the diagnostics endpoint behind the same flag. Does not feed scoring. |
| **#13** | Snapshot revenue/orders feed into Store Baseline diagnostics | Merged + verified (`3bd709f`) | Window-safe by design: cumulative snapshot data enters only via a dedicated AOV pair, never as funnel orders, so it cannot contaminate rolling-window CVR. |
| **#14** | Controlled Beta Write Kill Switch | Merged + verified (`df1fa76`) | Fail-closed. Blocks all mutating HTTP methods **routed through `shopifyFetch`**, plus the product-description chokepoint and five apply/rollback/execute routes. Fully inert when flags are off. ⚠️ **Known gap:** `registerWebhooks` uses raw/global `fetch` and **bypasses this guard** — see Section 6.6. Coverage is not universal. |
| **#15** | Diagnostics Store Allowlist Gate | Merged + verified (`4c4bee9`) | Fail-closed enrollment gate. `PRODUCT_OPPORTUNITY_DIAGNOSTICS=true` alone is **no longer sufficient** — the shop must be in `DIAGNOSTICS_STORE_ALLOWLIST`. Blocked requests 404 before any DB work, with an identical body in every case so enrollment state cannot leak. |
| **#16** | Controlled Beta 0 Ops Runbook | Merged + verified (`9a59f4c`) | Documentation only. Establishes the operational procedure and the sign-off gate that must precede any real-store run. |

---

## 3. Current Beta 0 readiness

**Code-level guardrails are in place:**

- Shopify writes can be blocked fail-closed by the beta / write-disable flags (PR #14).
- Diagnostics are scoped to explicitly enrolled stores by allowlist (PR #15).
- The operational runbook is written, reviewed across three rounds, and merged (PR #16).

**But real-store Beta 0 is NOT approved yet.**

Merging the runbook published the *procedure*. It did not authorize a run, and it did not satisfy any of the operational gates the runbook itself defines. The runbook on main is explicitly marked **DRAFT — awaiting release owner + product owner approval**, and its Section 22 sign-off table is blank.

---

## 4. Real-store Beta 0 remains blocked

- **No real Shopify store may be connected yet.**
- **No OAuth install may be started yet.**
- **No real-store diagnostics may be run yet.**
- **No Apply / Rollback / Auto-Apply may be used.**
- **No product / theme / cart / checkout changes may be made.**

---

## 5. Remaining gates before any real-store Beta 0

All of the following must be satisfied, in addition to the runbook's own preflight checklist:

- [ ] Release owner sign-off on the runbook (Section 22).
- [ ] Product owner sign-off on the runbook (Section 22).
- [x] OAuth scope strategy decided (Section 6.1) — *signed 2026-08-25, accepted for non-client rehearsal use only.*
- [x] Approved data environment decided (Section 6.2) — *signed 2026-08-25; the dedicated Beta 0 environment itself is still not provisioned.*
- [ ] **Webhook registration lifecycle decided and recorded** (Section 6.6) — accepted, routed through the kill switch, or disabled/deferred.
- [ ] Merchant consent captured in writing.
- [ ] Render / env flags verified in the live environment.
- [ ] Service restart completed successfully after env changes.
- [ ] Running instance confirmed to be serving the new values.
- [ ] Non-client development store rehearsal passed.
- [ ] One approved store selected.
- [ ] Final go / no-go before the real-store OAuth install.

---

## 6. Required env / operational decisions ahead

**Two items are now signed for non-client dev-store rehearsal use only (§6.1 and §6.2). The remaining items are not yet decided or completed. Real-store Beta 0 remains blocked.**

### 6.1 `SHOPIFY_SCOPES` strategy — ACCEPTED FOR NON-CLIENT REHEARSAL USE

> **Signed 2026-08-25** in `docs/decisions/shopify-scopes-and-data-environment-beta0.md` (covering §6.1 and §6.2). Accepted for **non-client dev-store rehearsal use only** — **real-store Beta 0 remains blocked.** The rehearsal still needs a written plan, the env value set, a service restart, and running-instance confirmation.

- **Preferred Beta 0 value:** `read_products,read_orders,read_analytics`
- Fallback write scopes require **release owner + product owner approval** *and* a merchant pre-brief before install.
- ⚠️ `SHOPIFY_SCOPES` is captured **at module load**, so a change cannot take effect without a service restart. Setting it and immediately generating an install URL presents the merchant with the **old** scope set — contradicting whatever pre-brief was just delivered.
- Whether the read-only set is *sufficient* for ingest and analytics is **unverified**; the dev-store rehearsal exists partly to answer this.

### 6.2 Approved data environment — ACCEPTED FOR NON-CLIENT REHEARSAL USE

> **Signed 2026-08-25** in `docs/decisions/shopify-scopes-and-data-environment-beta0.md`. Staging is accepted for the **non-client dev-store rehearsal only**; a **dedicated Beta 0 environment/database is required before any real merchant data**, and that environment does not yet exist.

- **Staging is not automatically approved for real merchant data.** The active database is a Supabase staging instance; using it to hold a real client's commercial data is a decision to be made and recorded deliberately, not inherited by default.
- Requires a named data owner, an agreed retention period, and a documented deletion process.

### 6.3 Dev-store rehearsal — NOT DONE

- Must be completed on a **non-client development / test store** before any real client is involved.
- Validates scopes, install, flags-before-install, the expected blocked ScriptTag event, no-ScriptTag verification, ingest, authenticated diagnostics, output capture, embedded UI visibility, and offboarding.
- ⚠️ A rehearsal proves the **safety and lifecycle procedure** works. It is **not** evidence that diagnostics quality is good on real commercial data.

### 6.4 Merchant embedded app UI — NOT REVIEWED

- After install, the merchant can open CRODoctor from Shopify Admin → Apps.
- The embedded UI must be reviewed in a safe / dev context first, and what a merchant would see must be recorded.
- The merchant must be instructed not to open it during Beta 0 — but an instruction is a courtesy, not a guardrail; the verified review is the guardrail.

### 6.5 Diagnostics sample limitation — KNOWN AND UNRESOLVED

- The diagnostics run is **capped at 50 products, ordered `createdAt desc`** — it is **not** a full-catalog scan.
- Findings are sample-scoped. A store's largest real opportunity may sit in an older product the sample never reaches.
- Do not present results as store-wide unless full-catalog coverage is implemented and verified.

### 6.6 Known open decision: webhook registration lifecycle — NOT DECIDED

**Decision record:** `docs/decisions/webhook-registration-lifecycle-beta0.md` · **Runbook:** §6.1

- The Beta 0 decision brief found that install-time webhook registration (`registerWebhooks`) uses **raw/global `fetch`** to `POST` to `webhooks.json` for `orders/create`, `products/update`, and `app/uninstalled`.
- These writes **bypass the PR #14 `shopifyFetch` kill switch** and succeed even with every write-disable flag active. They also produce **no `BETA_READ_ONLY_WRITE_BLOCKED` event**, so the blocked-event reconciliation does not surface them.
- They **are** Shopify Admin app-lifecycle writes. They are **not** product / theme / cart / checkout / storefront content mutations, and nothing a shopper sees changes.
- ⚠️ **Consequence:** the phrase **"zero Shopify writes" is too broad** and must not be used unqualified — in the runbook, in a report, or to a merchant. The accurate promise is: no product, theme, storefront, cart, checkout, or code changes.
- **Before real-store Beta 0, owners must decide one of:**
  1. **accept** webhook registration as documented app-lifecycle behaviour (requires merchant disclosure);
  2. **route** it through `shopifyFetch` / the kill switch in a later code PR;
  3. **disable or defer** it for Beta 0 in a later code PR.
- **The dev-store rehearsal must record** whether webhooks are created, the count and topics, whether registration succeeds under the chosen `SHOPIFY_SCOPES`, and whether they are cleaned up on uninstall / offboarding.
- ⛔ **Real-store Beta 0 and real-store OAuth install remain blocked until this decision is made and documented.** The rehearsal observes the behaviour; it does not approve it.

---

## 7. Current forbidden actions

- No Apply.
- No Rollback.
- No Auto-Apply.
- No Batch Apply (safe or selected).
- No Decision Engine execute.
- No product updates.
- No theme updates.
- No cart / checkout changes.
- No ScriptTag / tracker installation.
- No manual tracker registration.
- No `POST /auth/ensure-tracker`.
- No merchant-facing uplift claims.
- No public case study claims.
- No unsupported dashboard promises.
- **No unqualified "zero Shopify writes" claim** — to a merchant, in a report, or in our own docs (Section 6.6).
- **No real-store connection before sign-off.**
- **No real-store OAuth install while the webhook lifecycle decision is unrecorded** (Section 6.6).

> **Why the claim restrictions matter:** CRODoctor cannot yet prove lift. It has before/after data only, with no A/B capability. Any claim of measured improvement would be unsupported until the Change→Outcome model and measurement readiness work exist.

---

## 8. Recommended next step

**Completed:**

- PR #17 merged the webhook lifecycle / checkpoint docs patch.
- PR #18 merged the scopes / data-environment decision record.
- Scopes and data environment are **signed for non-client dev-store rehearsal use only** (2026-08-25).

**Current live next step:**

1. **Merge this docs-only sign-off PR** after review.
2. **Then write the dev-store rehearsal plan** — this is the live piece of work. *(A draft exists in conversation but is not yet saved: it needs cleanup first. State as of 2026-08-27 is captured in `docs/checkpoints/project-checkpoint-after-pr19-rehearsal-draft-2026-08-27.md`; intended save path is `docs/rehearsals/non-client-dev-store-rehearsal-plan-beta0.md`.)*

**Still required (none of these are done):**

- **Webhook lifecycle decision** (Section 6.6) — remains separate and open. It may be informed by the rehearsal, but must be recorded before any **real-store OAuth install**.
- A **written dev-store rehearsal plan**.
- `SHOPIFY_SCOPES` **env value set** in the live environment.
- The **five write-disable / diagnostics flags** set and verified.
- **Service restart completed and running instance confirmed** — before any install URL is generated.
- **Non-client development store only** — no real merchant store, no real merchant data.
- **Runbook §22 sign-off** (release owner + product owner) — still blank, and separate from the sign-off recorded here.
- **Dedicated Beta 0 environment/database** provisioned before any real merchant data.
- **Merchant consent** and a **final go / no-go**.

⛔ **Real-store Beta 0 remains blocked.** Signing the scopes and data-environment decisions removed one blocker for the rehearsal; it did not make the rehearsal ready to run, and it approved nothing about a real store.

---

## 9. Source of truth files

| File | Purpose |
|---|---|
| `docs/controlled-beta-0-ops-runbook.md` | The operational source of truth for any Beta 0 run — preflight, execution, proof, abort, offboarding, sign-off gate. |
| `docs/project-checkpoint-current-status.md` | This file — where the project stands and what remains before a real-store run. |
| `docs/decisions/webhook-registration-lifecycle-beta0.md` | Open decision record: install-time webhook registration bypasses the kill switch. Blocks real-store Beta 0 until resolved. |
| `docs/decisions/shopify-scopes-and-data-environment-beta0.md` | Covers `SHOPIFY_SCOPES` (§6.1) and the approved data environment (§6.2). Status: **signed 2026-08-25 — accepted for non-client dev-store rehearsal use only.** Does not approve real-store Beta 0. |
| `docs/checkpoints/project-checkpoint-after-pr19-rehearsal-draft-2026-08-27.md` | Point-in-time checkpoint at main `a4c79e6`, taken before the dev-store rehearsal plan is cleaned and saved. |

Related planning documents: `docs/product-opportunity-score-wiring-plan.md`, `docs/store-baseline-engine-plan.md`, `docs/supabase-rls-security-check.md`, `docs/cro-foundation.md`.
