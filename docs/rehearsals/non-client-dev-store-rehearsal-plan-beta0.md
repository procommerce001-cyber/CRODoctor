# Non-client Dev-store Rehearsal Plan — Beta 0

**Date drafted:** 2026-08-29
**Applies from main:** `ccc2ab1`
**Status:** Draft plan only — not approved for execution.

---

## 1. Purpose

- Defines the future non-client development-store rehearsal for Controlled Beta 0.
- The rehearsal is required before any real-store Beta 0 can be considered.
- This plan executes nothing. Reading or merging it starts no rehearsal.
- This plan approves no real-store Beta 0.

---

## 2. Hard boundaries

- No real merchant store.
- No real merchant data.
- No real-store Beta 0.
- No real-store OAuth install.
- No write scopes.
- No Apply.
- No Rollback.
- No Auto-Apply.
- No product, theme, cart, checkout, or storefront mutation.
- No diagnostics on a real store.
- No production rollout.
- No public case study or uplift claims.

---

## 3. Rehearsal objective

- Validate the read-only Beta 0 flow end to end on a non-client development store.
- Validate the approved scope value `SHOPIFY_SCOPES=read_products,read_orders,read_analytics`.
- Determine whether `read_analytics` is sufficient, or whether `read_reports` is needed.
- Observe and record webhook registration behaviour.
- Verify the safety gates behave as documented before any real-store consideration.
- A dev-store rehearsal does **not** prove diagnostics quality on real commercial data. A development store has synthetic products, little or no order history, and no real traffic. A smooth rehearsal must not create confidence about output quality.

---

## 4. Required inputs before execution

- Named non-client development Shopify store: `<devstore>.myshopify.com`
- Confirmation the store contains only fake or synthetic data.
- Operator: `<name>`
- Reviewer: `<name>`
- Date and time window: `<window>`
- Abort owner: `<name>`
- Cleanup and offboarding owner: `<name>`
- Run record location: `<location>`
- Approved scope value: `read_products,read_orders,read_analytics`
- The five required flags:
  - `CONTROLLED_BETA_READ_ONLY=true`
  - `DISABLE_SHOPIFY_WRITES=true`
  - `APPLY_DISABLED=true`
  - `PRODUCT_OPPORTUNITY_DIAGNOSTICS=true`
  - `DIAGNOSTICS_STORE_ALLOWLIST=<devstore>.myshopify.com`
- Confirmation that no real store domain appears in any allowlist.
- Service restart plan: who performs it and when.
- Running-instance confirmation method: restart status, service health, and log timestamps. Never an environment dump.
- Webhook behaviour recording method: Section 7 of this plan.

No secrets, tokens, database URLs, or API keys belong in this plan or in any run record.

---

## 5. Preflight checklist

- [ ] Current branch is `main`.
- [ ] Working tree is clean.
- [ ] `main` includes PR #20.
- [ ] Scopes and data-environment decision is signed for non-client rehearsal use only.
- [ ] Webhook lifecycle decision remains separate and open.
- [ ] Runbook section 22 sign-off status checked.
- [ ] Selected store is a non-client development store only.
- [ ] Selected store has no real merchant data.
- [ ] Approved read-only scopes configured.
- [ ] All five required flags confirmed.
- [ ] Allowlist contains only the development store.
- [ ] No real store domain in any allowlist.
- [ ] Service restarted after the environment changes.
- [ ] Running instance confirmed after restart.
- [ ] No install URL generated before restart confirmation.
- [ ] Operator understands the expected `BETA_READ_ONLY_WRITE_BLOCKED` event from `ensureScriptTag`.
- [ ] Operator understands webhook registration bypasses the kill switch and produces no blocked event.
- [ ] Tracker-registration endpoints will not be called.
- [ ] Apply, Rollback, Auto-Apply, Batch Apply, and Decision Execute will not be called.
- [ ] Run record destination prepared.
- [ ] Abort owner reachable.

---

## 6. Execution phases

Every install or OAuth action is scoped to the named non-client development store only. This section describes intent, not commands to run now.

### Phase A — Environment confirmation

- **Goal:** prove the running process serves the approved values before anything touches Shopify.
- **Allowed:** read back the five flags and the scope value; confirm the restart completed and the running instance is the post-restart one.
- **Forbidden:** generating an install URL; printing secrets or environment dumps; changing flags after this point.
- **Evidence:** restart timestamp; service health; per-flag confirmed or not confirmed.
- **Abort if:** any flag is wrong or unconfirmed; the scope value is not the approved one; restart or running-instance status is uncertain.

### Phase B — Dev-store install / OAuth rehearsal

- **Goal:** complete OAuth against the development store and observe the consent screen.
- **Allowed:** generate the install URL for the development store only; complete OAuth; record the consent screen contents.
- **Forbidden:** any other store; proceeding if the consent screen shows write permissions.
- **Evidence:** consent-screen scopes as displayed; callback count; install result; blocked-event count reconciled against callbacks; admin check confirming no ScriptTag was created.
- **Abort if:** the consent screen shows write scopes; a ScriptTag is created; a blocked event appears from any origin other than `ensureScriptTag`.

### Phase C — Read-only ingest / diagnostics rehearsal

- **Goal:** determine whether the read-only scope set is sufficient.
- **Allowed:** observe ingest and sync; call the internal diagnostics path for the development store from an authenticated operator context; capture ProductOpportunityScore and Store Baseline output.
- **Forbidden:** any write; Apply or Rollback; any other endpoint; treating an authentication failure as an allowlist-gate failure.
- **Evidence:** what ingested and what did not; every scope-related error verbatim with the exact failing call; diagnostics payload shape; products evaluated against total catalogue size; missing-data fields, expecting product views to be null.
- **Abort if:** diagnostics returns another store's data; unexpected server errors; secrets appear in logs; performance concerns.

### Phase D — Webhook behavior observation

- **Goal:** establish the facts the separate webhook lifecycle decision needs.
- **Allowed:** observe and record; inspect webhook subscriptions in the development store admin.
- **Forbidden:** deliberately triggering registration; calling any tracker or webhook registration endpoint; deciding the lifecycle question.
- **Evidence:** the Section 7 record, completed in full.
- **Abort if:** webhook activity occurs outside the install window; topics differ from those expected; any webhook-triggered mutation toward Shopify.

### Phase E — Cleanup / uninstall / offboarding

- **Goal:** leave no residue on the development store or in configuration.
- **Allowed:** remove the development store from the diagnostics allowlist; turn the diagnostics flag off; uninstall the app from the development store admin; confirm the token is revoked; confirm webhook subscriptions are removed.
- **Forbidden:** relaxing the write-disable flags.
- **Evidence:** each step confirmed; webhook cleanup result recorded explicitly.
- **Abort if:** webhook subscriptions remain after uninstall. Treat that as an incident and resolve it before any real merchant is involved.

### Phase F — Evidence capture and run report

- **Goal:** produce a report that can carry the webhook decision and the eventual real-store go or no-go.
- **Allowed:** complete the Section 11 run report and the runbook read-only proof checklist.
- **Forbidden:** recording secrets; presenting dev-store findings as evidence of diagnostics quality; marking any real-store gate complete.
- **Evidence:** the completed run report.
- **Abort if:** evidence is insufficient to answer the scope-sufficiency question, which makes the rehearsal inconclusive and requires a repeat.

---

## 7. Webhook behavior to record

- Whether webhook registration was attempted.
- Which topics were attempted.
- Whether registration succeeded.
- Whether registration failed due to scope, including the exact error.
- Whether any webhook write happened during install.
- Whether `BETA_READ_ONLY_WRITE_BLOCKED` appeared for webhooks. It is expected not to.
- Whether subscriptions were visible in the development store admin, and how many.
- Whether subscriptions were removed on uninstall and offboarding.
- Evidence location.
- Recommendation input for the future webhook lifecycle decision.

The rehearsal informs the webhook lifecycle decision. It does not decide it.

---

## 8. Abort criteria

Abort if any of the following occurs.

- The store is a real merchant store.
- Real merchant data appears.
- The scope value is not the approved read-only value.
- A write scope appears.
- Any required flag is missing.
- The allowlist contains a real store.
- The service restart is missing.
- Running-instance confirmation is missing.
- An install URL was generated before restart confirmation.
- Apply, Rollback, or Auto-Apply becomes reachable.
- Product, theme, cart, checkout, or storefront mutation is attempted.
- Secrets appear in logs or documents.
- Any unexpected Shopify write beyond the documented install-time webhook behaviour.
- The operator is uncertain.

---

## 9. Success criteria

- Non-client development store only.
- Approved read-only scopes used.
- No write scopes.
- No product, theme, cart, checkout, or storefront mutation.
- No ScriptTag created.
- Diagnostics route behaviour understood.
- Sufficiency of `read_analytics` is known, or the exact failing call is recorded.
- Webhook behaviour recorded.
- Cleanup and offboarding completed.
- Run report completed.
- No real merchant data used.

Partial passes are not passes.

---

## 10. Failure handling

- If `read_analytics` is insufficient, record the exact failing call. Do not add scopes mid-run.
- If `read_reports` is needed, update the decision record, set the value, restart the service, confirm the running instance, and re-rehearse in full.
- If webhook registration fails, record it and feed it into the separate webhook lifecycle decision.
- If webhook registration succeeds but creates concern, record the specifics and keep real-store Beta 0 blocked.
- If diagnostics fails closed, check the canonical allowlist host and the flag. Do not loosen the gate to debug.
- If diagnostics returns thin data, distinguish a genuinely sparse development store from a scope silently degrading a call.
- If any write-related concern appears, abort.
- If cleanup fails, treat it as an incident.

Any scope change requires a decision-record update, a service restart, running-instance confirmation, and a full non-client re-rehearsal. No real-store Beta 0 until verified.

---

## 11. Run report template

- Date
- Operator
- Reviewer
- Development store identifier
- Confirmation the store is non-client and synthetic
- Scope value used
- What the consent screen showed
- Five flags confirmed
- Service restart confirmed
- Running instance confirmed
- Install URL generated only after confirmation
- Allowlist confirmed
- Install and OAuth result
- Callback count
- `ensureScriptTag` blocked-event count
- ScriptTag created, admin check
- Diagnostics result
- Products evaluated
- Total catalogue size
- Whether `read_analytics` was sufficient: yes, no, or inconclusive
- Exact failing call, if any
- Webhook observations
- Data quality observations
- Failures and aborts
- Cleanup completed
- Conclusion
- Recommendation
- Remaining blockers before real-store Beta 0

---

## 12. Remaining blockers after a successful rehearsal

- Webhook lifecycle decision recorded.
- Runbook section 22 sign-off.
- Dedicated Beta 0 database or environment before any real merchant data.
- Merchant consent.
- Final go or no-go.
- Real-store OAuth install separately approved.

A successful rehearsal does not make real-store Beta 0 automatic.
