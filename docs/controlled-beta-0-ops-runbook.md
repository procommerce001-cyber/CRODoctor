# Controlled Beta 0 — Operations Checklist / Runbook

**Status:** DRAFT — awaiting release owner + product owner approval
**Owner:** Release owner (engineering) + Product owner
**Document type:** operational source of truth — follow it literally, do not improvise
**Applies to:** every real-store Beta 0 run (this is a reusable master document)

> **This runbook is not yet approved. No real client store may be connected — and no OAuth install may be started — until Section 22 is signed off.**

### Revision history

| Rev | Date | Change | Author |
|---|---|---|---|
| 1 | 2026-08-18 | Initial runbook | Engineering |
| 2 | 2026-08-19 | Revised after safety review (`RUNBOOK_REVIEW_BLOCKED_NEEDS_REVISIONS`): store lifecycle, OAuth scopes/consent, ScriptTag install behavior, data handling, offboarding, diagnostics sample limits | Engineering |

---

## 1. Purpose

This runbook defines exactly how CRODoctor may run **Beta 0** against one real Shopify store in **read-only mode**.

Beta 0 exists to validate:

- diagnostics quality and completeness,
- store data visibility (are we actually seeing the store's real state?),
- ProductOpportunityScore reasoning (are the opportunities explainable and sane?),
- Store Baseline honesty (does it admit what it does not know?).

Beta 0 explicitly does **not**:

- test automatic Apply,
- test Rollback,
- modify the client store in any way,
- produce any merchant-facing or public claim about results.

Beta 0 is an **internal evaluation run using a real store's data**. The merchant receives no change, no dashboard promise, and no performance claim. The only output is an internal report.

**Why read-only matters:** CRODoctor cannot yet prove lift. It has before/after data only, no A/B capability. Writing to a real store before measurement exists would create changes we cannot attribute, cannot defend, and cannot honestly report on. Beta 0 deliberately stops short of that line.

---

## 2. Baseline at Document Creation

Point-in-time values recorded when this runbook was written. **These are not live status.** Every real run must record its own current values in a fresh run record (Section 15).

| Item | Value at rev 2 (2026-08-19) |
|---|---|
| Approved main commit | `4c4bee9` (or later, if re-verified) |
| PR #14 — write kill switch | Merged and verified (`df1fa76`) |
| PR #15 — diagnostics allowlist gate | Merged and verified (`4c4bee9`), verdict `PR_15_POST_MERGE_VERIFIED` |
| Latest full test suite | 320/320 passing, 19 suites |
| Real store connected at authoring time | None |
| Production / manual deploy by this runbook | None |

Any deployment that occurred around the PR #14 / PR #15 merges was **automatic preview/CI only**. This runbook performs no deploy and claims none.

---

## 3. Beta 0 Definition

### 3.1 Allowed

- Connect **one** explicitly approved real Shopify store.
- Use the **canonical `*.myshopify.com` domain only**.
- Run **internal diagnostics only**.
- Inspect ProductOpportunityScore output internally.
- Inspect Store Baseline output internally.
- Capture `missingData` honestly, without filling gaps by guesswork.
- Compare system findings against a manual CRO review of the same store.
- Produce an **internal report only**.

### 3.2 Forbidden

- Apply.
- Rollback.
- Auto-Apply.
- Batch Apply (safe or selected).
- Decision Engine execute.
- Product updates (description, title, metafields, images, tags, anything).
- Theme updates.
- **ScriptTag / tracker installation on the client storefront.**
- Cart updates.
- Checkout changes.
- Manual theme/code edits to the client store.
- Merchant-facing dashboard promises.
- Merchant-facing uplift claims.
- Public case study claims.
- **Any claim that CRODoctor improved revenue.** Measurement does not exist yet; such a claim would be unsupported.

---

## 4. Required Code Guardrails Before Beta 0

Both must already be **merged into `main` and post-merge verified**:

**PR #14 — Controlled Beta Write Kill Switch**
- Guards **all mutating HTTP methods** at the Shopify transport layer (`shopify-admin.service.js` → `shopifyFetch`): when the kill switch is on, any `POST`/`PUT`/`PATCH`/`DELETE` toward Shopify throws before leaving our process.
- Additionally guards the product-description write chokepoint (`action-center.service.js:updateProductDescription`).
- Guards the dangerous routes: `POST /action-center/batch-apply-safe`, `POST /action-center/batch-apply-selected`, `POST /action-center/products/:id/apply`, `POST /action-center/products/:id/rollback`, `POST /decision-engine/actions/execute`.
- Fail-closed. Blocked routes return `403 { error: "beta_read_only", ... }`; blocked writes throw an error carrying code `BETA_READ_ONLY_WRITE_BLOCKED`.

**PR #15 — Diagnostics Store Allowlist Gate**
- `GET /action-center/opportunity-diagnostics` requires `PRODUCT_OPPORTUNITY_DIAGNOSTICS=true` **AND** the shop present in `DIAGNOSTICS_STORE_ALLOWLIST`.
- The global flag alone is **not** sufficient.
- Missing / empty / malformed / non-allowlisted shop → `404 { error: "Not found." }`, returned **before** any Prisma handle, `resolveStore`, or DB query.
- The 404 body is identical in every blocked case, so enrollment state does not leak.

> **If either guardrail is not verified on the deployed commit, this runbook does not proceed. Stop.**

---

## 5. Required Environment Flags

### 5.1 ⛔ Hard ordering gate — flags BEFORE OAuth install

> **All five flags below MUST be set and verified in the live environment BEFORE the OAuth install / connect step.**
>
> **Why this is safety-critical:** the OAuth callback calls `ensureScriptTag()`, which attempts to `POST` a tracker ScriptTag to the store. **If the write-disable flags are unset or not truthy at install time, that POST succeeds and installs a ScriptTag on the client's live storefront** — a real storefront modification during a run we promised would change nothing. With the flags on, the attempt is blocked by the kill switch (see Section 6).
>
> Connecting first and configuring afterwards is **not** an acceptable order. If the store was already installed before the flags were verified, treat it as an incident (Section 18) and check the store's script tags.

| Flag | Required value | Effect |
|---|---|---|
| `CONTROLLED_BETA_READ_ONLY` | `true` | Master beta read-only switch |
| `DISABLE_SHOPIFY_WRITES` | `true` | Hard Shopify write kill switch (all mutating methods) |
| `APPLY_DISABLED` | `true` | Disables Apply / Rollback / batch-apply routes |
| `PRODUCT_OPPORTUNITY_DIAGNOSTICS` | `true` | Enables the internal diagnostics route globally |
| `DIAGNOSTICS_STORE_ALLOWLIST` | `<canonical-store>.myshopify.com` | Restricts diagnostics to the approved store |

Accepted truthy values for the boolean flags: `true`, `1`, `yes`, `on` (case-insensitive). Anything else — including unset — reads as false.

### 5.2 Allowlist format rules

- Use the **canonical `*.myshopify.com` host only**.
- **Do not use a custom storefront domain.** A custom domain does not normalize and the store will be silently blocked.
- Preferred operational format is the **plain canonical host, no protocol, no trailing slash**:

  ```
  DIAGNOSTICS_STORE_ALLOWLIST=example.myshopify.com
  ```

- The parser does tolerate `https://`, trailing slashes, mixed case, and surrounding whitespace, but **do not rely on that** — write the plain host so the configuration is unambiguous to the next operator.
- **One store only** for the first Beta 0. Multiple entries are technically supported (comma-separated) but are **not approved** without a separate explicit decision.
- **Never put secrets in this runbook or in a report.** No tokens, no database URLs, no API keys. Record only the store's public canonical domain.

### 5.3 Warnings

- ⚠️ If `DIAGNOSTICS_STORE_ALLOWLIST` uses a **custom domain**, the store is blocked and diagnostics return 404. This looks identical to "feature off" — do not debug it by loosening the gate.
- ⚠️ If the allowlist is **missing or empty**, diagnostics return 404 for every store. This is correct fail-closed behavior.
- ⚠️ If any **write-disable flag is missing or not truthy, Beta 0 is not approved.** Do not connect the store. Fix the environment first.
- ⚠️ Setting `PRODUCT_OPPORTUNITY_DIAGNOSTICS=true` **without** the allowlist does not expose anything, but it is still an incomplete configuration — do not treat it as "ready."

---

## 6. Install-Time ScriptTag Behavior (Expected, Not a Bug)

**What happens.** During the OAuth callback, the app calls `ensureScriptTag()` to register the CRODoctor storefront tracker (`cro-tracker.js`). This is a `POST` to Shopify's `script_tags.json` — a genuine storefront write.

**What happens during Beta 0.** With the write-disable flags active (Section 5.1), `shopifyFetch` blocks the mutating request and throws `BETA_READ_ONLY_WRITE_BLOCKED`. The call site handles this non-fatally, so **the install still completes successfully** and no ScriptTag is created.

**Therefore, during Beta 0:**

- ✅ **Expect** one `BETA_READ_ONLY_WRITE_BLOCKED` event in the logs during the OAuth install window, originating from `ensureScriptTag`.
- ✅ **Record it as evidence the kill switch worked.** It is the system behaving exactly as designed.
- ✅ **Do not abort the run because of it.**
- ⛔ **Any other** `BETA_READ_ONLY_WRITE_BLOCKED` event — a different origin, or *any* occurrence outside the OAuth install window — **is a stop condition** and must be investigated before continuing (Section 17).
- ⛔ If a ScriptTag **was** created (verify in Shopify admin), the flags were not active at install time. Stop and follow Section 18.

**Downstream consequence — expected missing data.** Because the tracker is intentionally not installed, no PDP events are captured for this store. **`productViews` and related view-derived fields will be null/missing. This is expected in Beta 0.** Do not chase it as a bug, do not work around it, and do not let it be silently defaulted — record it honestly as `missingData` (Section 15, Section 16).

---

## 7. OAuth Scopes / Merchant Consent

The Shopify install screen shows the merchant exactly which permissions we request. Our merchant-facing promise must not contradict that screen.

**Current app default** (`SHOPIFY_SCOPES`, if unset): `read_products, write_products, read_orders, read_analytics, write_script_tags` — i.e. the consent screen will show **write** permissions.

### 7.1 Preferred Beta 0 policy — read-only scopes

Before the OAuth install, configure `SHOPIFY_SCOPES` to read-only scopes, if technically supported for the Beta 0 flow:

```
SHOPIFY_SCOPES=read_products,read_orders,read_analytics
```

This gives defense in depth at the Shopify grant level — the token itself cannot write — and makes the consent screen match what we tell the merchant.

**`write_products` and `write_script_tags` must NOT be included for Beta 0 unless explicitly approved by the release owner AND the product owner.** Note that omitting `write_script_tags` also permanently prevents tracker installation, which is already the intended Beta 0 state (Section 6).

> Changing scopes affects the OAuth grant. Decide and configure this **before** install; changing scopes later requires the merchant to re-authorize.

### 7.2 Fallback — if write scopes remain visible

If the app is installed with write scopes still present, the merchant **must be pre-briefed before install**, and told plainly:

- Shopify may show write permissions because the app contains Apply features intended for later, separately-approved phases.
- For this Beta 0 run, those write paths are **disabled by code-level kill switches**.
- We will not use Apply, Rollback, Auto-Apply, Batch Apply, ScriptTag installation, product updates, theme updates, cart changes, checkout changes, or code edits.
- Any future store change requires **separate written approval** from them.

Do not let a merchant reach the consent screen unprepared. A surprise "can edit your products" prompt after being told "nothing will change" costs trust that a correct technical explanation will not buy back.

---

## 8. First Store Selection Criteria

The first Beta 0 store must satisfy **all** of the following:

- Cooperative client with an existing relationship.
- **Written approval** for read-only diagnostics.
- Store owner explicitly understands **no website changes will be made**.
- Store owner has been briefed on the OAuth consent screen (Section 7).
- Enough product and order data to produce meaningful diagnostics (a near-empty catalog teaches us nothing and will read as `missingData` everywhere).
- Known, confirmed canonical `*.myshopify.com` domain.
- **Not** during a major sale, product launch, unusual traffic spike, ad campaign change, or migration.
- Low operational risk window; the store is not mission-critical during the test window, or the test is scheduled for a low-risk time.
- Merchant expectations documented in writing before the run.

If any criterion fails, choose a different store or a different window. Do not proceed on a "close enough" basis.

---

## 9. Required Approvals

| Role | Responsibility |
|---|---|
| Product owner | Confirms Beta 0 scope, merchant relationship, and that no claims will be made |
| Engineering / release owner | Confirms deployed commit, guardrail verification, env flag state, and scope strategy |
| Operator | Runs the session, captures output, holds the stop authority |
| Abort owner | Named individual who can halt the run at any moment (may differ from operator) |
| Merchant | Consent and expectation confirmation, in writing |
| Data owner | Owns environment approval, retention, and deletion requests (Section 11) |
| QA reviewer (optional) | Independent review of diagnostics output quality |

### 9.1 Sign-off table (fill before the run)

| Role | Name | Approval date/time | Notes |
|---|---|---|---|
| Product owner | | | |
| Engineering / release owner | | | |
| Operator | | | |
| Abort owner | | | |
| Merchant consent | | | |
| Data owner | | | |
| QA reviewer (optional) | | | |

**A run with any blank mandatory row is not approved.**

---

## 10. Merchant Communication Requirements

### 10.1 The merchant must be told

- The store will be connected for **read-only diagnostics**.
- CRODoctor **will not change** products, theme, cart, checkout, code, or storefront scripts.
- **No Apply or Auto-Apply** will be used.
- What the **Shopify consent screen** will show (Section 7) — before they see it.
- The goal is to analyze opportunities and validate the quality of our diagnostics.
- **Any future change would require separate, explicit approval** from them.
- They may ask us to stop and disconnect at any time (Section 19 defines how).
- What data we access and how long we keep it (Section 11).

### 10.2 Suggested wording — read-only scopes (Section 7.1)

> We'd like to connect your store to CRODoctor in read-only mode. We will look at your product and performance data to see what conversion opportunities our system identifies, and compare that to our own manual review. We will not change anything on your store — no product edits, no theme edits, no storefront scripts, no checkout changes. Nothing will be applied. If we later want to make any change, we'll come back to you for approval first, and you can ask us to disconnect at any time.

### 10.3 Suggested wording — if write scopes remain visible (Section 7.2)

> We'd like to connect your store to CRODoctor in read-only mode for analysis only. One thing to expect before you click install: **Shopify's permission screen will list write permissions** (for example, editing products). That is because the app also contains "apply changes" features built for a later stage. **Those are switched off in code for this run** — we will not apply anything, will not edit products or theme, will not install storefront scripts, and will not touch cart or checkout. We're only reading your product and performance data to see what our system identifies, and comparing that to our own manual review. Any actual change in future would need your separate written approval, and you can ask us to disconnect at any time.

### 10.4 Do not promise

- Guaranteed uplift.
- Revenue increase.
- Automatic optimization.
- Case study results.
- A timeline to improvement.

Honest framing is a hard requirement, not a style preference. We can currently identify opportunities; we cannot yet prove lift.

---

## 11. Data Handling

Beta 0 pulls a real client's commercial data into our systems. Decide all of the below **before** the run.

### 11.1 What may be accessed or stored

- Product data (titles, descriptions, handles, vendor, images metadata).
- Order / analytics data, **only** to the extent the granted OAuth scopes allow.
- Diagnostics outputs.
- ProductOpportunityScore outputs.
- Store Baseline outputs.
- `missingData` fields.
- Internal reviewer notes.

### 11.2 Environment approval

- **The environment used to hold real merchant data must be explicitly approved by the data owner before Beta 0.**
- **Do not assume a staging environment is automatically approved for real merchant data.** If the active database is a staging instance, that is a decision to be made and recorded deliberately, not inherited by default.
- Record the approved environment in the run record.

### 11.3 Access

Access is limited to:

- the assigned operator,
- the release owner,
- the product owner,
- the data owner,
- any explicitly approved reviewer (e.g. the QA/CRO reviewer).

No wider sharing. No copying into general team channels.

### 11.4 Secrets

- **No tokens, database URLs, or API keys** in this runbook, in any run record, or in any report. Record only the store's public canonical domain.

### 11.5 Retention and deletion

- **Retention period must be decided and recorded before the run.**
- A **named owner** is responsible for merchant deletion requests, and the deletion process must be documented before the run begins.
- On merchant request, data is deleted within the agreed window and the deletion is confirmed back to the merchant in writing.
- **Merchant data must not be used for public case studies or marketing without separate written approval** from both the merchant and the product owner.

---

## 12. Preflight Checklist

Complete **every** item before the OAuth install. Any unchecked box blocks the run.

- [ ] **Section 22 final decision gate signed by release owner AND product owner** (mandatory before OAuth install).
- [ ] Main is on approved commit `4c4bee9` or later, and the **deployed** commit matches.
- [ ] PR #14 (write kill switch) verified on the deployed commit.
- [ ] PR #15 (diagnostics allowlist gate) verified on the deployed commit.
- [ ] Latest full test suite known green at 320/320 or later.
- [ ] Store canonical `*.myshopify.com` domain confirmed (not a custom domain).
- [ ] Merchant written approval captured.
- [ ] OAuth scope strategy approved: read-only scopes preferred, OR merchant pre-brief completed if write scopes will appear.
- [ ] `CONTROLLED_BETA_READ_ONLY=true` configured and confirmed in the live environment.
- [ ] `DISABLE_SHOPIFY_WRITES=true` configured and confirmed.
- [ ] `APPLY_DISABLED=true` configured and confirmed.
- [ ] `PRODUCT_OPPORTUNITY_DIAGNOSTICS=true` configured and confirmed.
- [ ] `DIAGNOSTICS_STORE_ALLOWLIST` contains **only** the approved store, as a plain canonical host.
- [ ] **All five flags verified BEFORE OAuth install** (Section 5.1 ordering gate).
- [ ] Install-time ScriptTag behavior understood by the operator (Section 6) — the expected blocked event will not be mistaken for a failure, and a created ScriptTag will be.
- [ ] Data handling decided: environment approved, access list agreed, retention period set, deletion owner named (Section 11).
- [ ] No Apply / Rollback / Batch Apply / Decision Execute will be called during the session.
- [ ] No theme / product / cart / checkout / ScriptTag changes planned.
- [ ] Operator assigned and available for the whole window.
- [ ] Abort owner assigned and reachable.
- [ ] Log monitoring prepared (operator can see API logs live).
- [ ] Internal report destination prepared (Section 15 template ready).
- [ ] Stop conditions (Section 17) reviewed by the operator before starting.

---

## 13. Safe Execution Procedure

> This procedure contains **no write operations**. Do not add any. Do not "just test" Apply on a real store.

**Pre-connect**

1. **Confirm the runbook is signed off** — Section 22 complete, release owner and product owner both signed.
2. **Confirm merchant consent and OAuth scope communication** — written approval captured; merchant pre-briefed on the consent screen (Section 7).
3. **Confirm the canonical store domain.** Verify the exact `*.myshopify.com` host with the merchant or the Shopify admin URL.
4. **Verify all Render/env flags — BEFORE OAuth install.** Read back all five flags from Section 5 in the live environment. Confirm values, not just presence. This is the Section 5.1 ordering gate; do not proceed past it on assumption.
5. **Confirm `DIAGNOSTICS_STORE_ALLOWLIST` contains only the approved canonical store.** One entry. Exact match. Plain host.
6. **Confirm write-disable flags are active** (`CONTROLLED_BETA_READ_ONLY`, `DISABLE_SHOPIFY_WRITES`, `APPLY_DISABLED` all truthy).
7. **Confirm no deploy or manual code change is happening** during this session. Any deploy requires separate approval.

**Connect**

8. **Start the OAuth install and connect the approved store only.** No other store.
9. **Expect and record the known install-time `BETA_READ_ONLY_WRITE_BLOCKED` event** from `ensureScriptTag`, if it appears (Section 6). Record it as kill-switch evidence. Do not abort on it.
10. **Confirm no ScriptTag / tracker was actually installed** — check the store's script tags in the Shopify admin. If one exists, stop and follow Section 18.
11. **Confirm initial ingest/sync behavior.** Record what was actually ingested. **Do not claim full catalog coverage unless it has been proven** for this store (see Section 14).

**Diagnose**

12. **Run internal diagnostics only through the approved internal path:** `GET /action-center/opportunity-diagnostics?shop=<canonical-host>`, from an authenticated operator context (Section 14). No other endpoint is part of Beta 0.
13. **Capture ProductOpportunityScore and Store Baseline output internally** — stored in the approved location, secrets excluded.
14. **Compare with the manual CRO review** of the same store. For each surfaced opportunity: is it explainable? Would a competent CRO reviewer reach it? Check `missingData` and confidence honestly — sufficiency is not confidence, and absent data is a finding, not a defect to paper over. Expect `productViews` to be missing (Section 6).
15. **Apply nothing.** Not manually, not "just one small one," not in the Shopify admin.

**Close out**

16. **Remove the store from `DIAGNOSTICS_STORE_ALLOWLIST` after the session** — mandatory, not optional (Section 19).
17. **Complete the read-only proof checklist** (Section 16).
18. **Complete the post-run review** (Section 20).
19. **Decide: stop / repeat / next run** — and record who decided.

---

## 14. Diagnostics Sample Limitations

**The diagnostics run is a sample, not a full-catalog scan.** As currently implemented, the diagnostics route:

- is **capped at 50 products**,
- ordered by **`createdAt desc`** — i.e. the **most recently created** products,
- and therefore **does not scan the full catalog**.

Consequences the operator must respect:

- Findings are **"top opportunities within the diagnostics sample,"** never "top opportunities in the whole store."
- ⚠️ **Do not present results as store-wide** unless a full-catalog scan is implemented and verified. A store's biggest real opportunity may sit in an older product the sample never touched.
- If the store's most important products are long-established, the sample may be systematically unrepresentative. Note this in the run record.
- Re-verify the cap and ordering if the code changes; this section describes current behavior, not a guarantee.

**Authenticated access note.** The internal diagnostics endpoint sits behind session/auth middleware (`requireSession`) and requires an **authenticated operator context**. A plain unauthenticated `curl` or browser call may fail on auth. **That failure does not mean the allowlist gate failed** — do not "fix" it by touching the gate. Use the approved authenticated internal path.

---

## 15. Data Capture Template

Record the following for every Beta 0 session. **Exclude all secrets** — no tokens, no DB URLs, no API keys.

```
BETA 0 SESSION RECORD

Store canonical domain:      <store>.myshopify.com
Date / time (start–end):
Operator:
Abort owner:
Deployed commit verified:
Section 22 sign-off confirmed:   yes / no

OAuth scopes granted:            <read-only set / write scopes present>
Merchant pre-briefed on consent screen:  yes / no

Data handling:
  Environment approved by data owner:
  Retention period agreed:
  Deletion request owner:

Flags confirmed BEFORE OAuth install (value read back from live env):
  CONTROLLED_BETA_READ_ONLY:        true / false
  DISABLE_SHOPIFY_WRITES:           true / false
  APPLY_DISABLED:                   true / false
  PRODUCT_OPPORTUNITY_DIAGNOSTICS:  true / false
  DIAGNOSTICS_STORE_ALLOWLIST:      <host only, single entry>

Install-time ScriptTag:
  BETA_READ_ONLY_WRITE_BLOCKED from ensureScriptTag seen:  yes / no
  ScriptTag actually created on storefront (admin check):  yes / no   <-- must be NO

Diagnostics endpoint used:
  GET /action-center/opportunity-diagnostics?shop=<host>

Diagnostics sample:
  Products evaluated (max 50, createdAt desc):
  Total catalog size (for context):
  Sample considered representative?  yes / no / unknown

ProductOpportunityScore outputs:
  - score distribution / notable values:
  - explainability notes:

Store Baseline outputs:
  - fields populated:
  - AOV values (if any):
  - reliability / confidence labels:

missingData fields observed:
  - productViews missing (expected — tracker intentionally not installed):  yes / no
  - other:

Top 3 opportunities WITHIN THE DIAGNOSTICS SAMPLE (not store-wide):
  1.
  2.
  3.

Manual CRO reviewer notes (independent review of same store):
  -

Disagreements between system and human review:
  -

Errors encountered:
  -

Performance concerns (slow queries, timeouts, heavy load):
  -

BETA_READ_ONLY_WRITE_BLOCKED events outside the install window:  yes / no
  (if yes, this is a STOP CONDITION — detail + investigation)

Offboarding completed (Section 19):  yes / no
  Store removed from allowlist:
  Diagnostics flag state after run:
  App uninstalled (if applicable):
  Merchant confirmed run complete / no changes made:

FINAL DECISION:  proceed / repeat / stop
Decision rationale:
Decided by:
```

---

## 16. Read-Only Proof Checklist

Complete **after** the session. This is the evidence that Beta 0 was genuinely read-only.

- [ ] Write-disable flags were active for the entire session, and verified **before** OAuth install (start and end).
- [ ] Diagnostics allowlist contained only the approved store.
- [ ] No Apply endpoint was called (`POST /action-center/products/:id/apply`).
- [ ] No Rollback endpoint was called (`POST /action-center/products/:id/rollback`).
- [ ] No Batch Apply endpoint was called (`/action-center/batch-apply-safe`, `/action-center/batch-apply-selected`).
- [ ] No Decision Engine execute endpoint was called (`POST /decision-engine/actions/execute`).
- [ ] No Shopify product / theme / cart / checkout mutation was performed.
- [ ] **No ScriptTag / tracker was created on the storefront** — verified in the Shopify admin.
- [ ] `BETA_READ_ONLY_WRITE_BLOCKED` events reconciled: the install-window `ensureScriptTag` event (if present) is recorded as expected kill-switch evidence, and **no other occurrences exist**.
- [ ] Webhook activity reviewed (see note below) — no webhook-triggered mutation to Shopify.
- [ ] No product or theme changes observed in the Shopify admin (spot-check the products that appeared in diagnostics).
- [ ] Internal diagnostics output was captured.
- [ ] No merchant-facing page changed.
- [ ] Offboarding completed per Section 19.

> **`BETA_READ_ONLY_WRITE_BLOCKED` — how to read it.** One occurrence during the OAuth install window, originating from `ensureScriptTag`, is **expected** in Beta 0 and confirms the kill switch worked (Section 6). Record it; do not abort. **Any other occurrence — different origin, or any time outside the install window — is a stop condition**: our system attempted a write during a read-only run, and the call path must be investigated before continuing. A working safety net is not a licence to keep driving at it.

> **Webhooks.** Shopify webhooks may arrive as part of normal app lifecycle and sync. Receiving them is **not** an operator write and should not be treated as one. However, **any webhook-triggered mutation toward Shopify would be a stop condition.** Check logs for unexpected webhook side effects before signing off this checklist.

---

## 17. Failure / Stop Conditions

**Stop immediately** if any of the following occurs:

- Any write attempt occurs, **other than** the expected install-window `ensureScriptTag` block described in Section 6.
- Any `BETA_READ_ONLY_WRITE_BLOCKED` event outside the OAuth install window, or from any origin other than `ensureScriptTag`.
- A ScriptTag / tracker was actually created on the storefront.
- Any Shopify product / theme / cart / checkout change is detected.
- Any webhook-triggered mutation toward Shopify.
- Any tenant leakage is suspected.
- Any secret appears in logs or output.
- Diagnostics returns another store's data.
- The route returns unexpected `500`s.
- Query performance is concerning (long-running queries, timeouts, elevated load on the store's data).
- ProductOpportunityScore produces **fake confidence** — high confidence on thin or absent data.
- Store Baseline **overclaims** — presents missing data as known.
- The merchant sees unintended UI or unintended claims.
- **The operator is unsure.** Uncertainty is a valid and sufficient stop condition. Stopping costs a session; guessing costs a client.

---

## 18. Abort Procedure

1. **Stop the test immediately.** No further requests.
2. **Do not run further diagnostics** against the store.
3. **Remove the store from `DIAGNOSTICS_STORE_ALLOWLIST`**, and set `PRODUCT_OPPORTUNITY_DIAGNOSTICS=false`.
4. **Keep write-disable flags active** (`CONTROLLED_BETA_READ_ONLY`, `DISABLE_SHOPIFY_WRITES`, `APPLY_DISABLED`). Never relax these during an incident.
5. **Capture logs** covering the full session window, before they roll off.
6. **Document the incident:** what happened, when, what was observed, what was requested.
7. **Notify the engineering / release owner and the product owner.**

**If the incident is serious** — any actual store mutation, a created ScriptTag, suspected tenant leakage, or secret exposure — additionally:

8. **Uninstall the app from the Shopify admin.**
9. **Revoke / invalidate the access token** if possible.
10. **Notify the merchant** if there is any possible store impact. Do this promptly and factually; do not wait for a full root-cause analysis to tell them something changed on their store.
11. **If any store change occurred:** identify the exact change, confirm scope in the Shopify admin, and handle it manually with the merchant's knowledge. **Do not attempt an automated rollback** — Rollback is forbidden in Beta 0, and an automated fix during an incident compounds the problem.
12. **Do not reconnect** the store until the root cause has been reviewed and the fix verified on `main`.

> This procedure deliberately contains no write calls and no instruction to test Apply on a real store. Do not add either.

---

## 19. Disconnect / Offboarding

**Mandatory at the end of every session.** This is not optional cleanup and it is not conditional on anyone asking.

1. **Remove the store from `DIAGNOSTICS_STORE_ALLOWLIST`.**
2. **Set `PRODUCT_OPPORTUNITY_DIAGNOSTICS=false`**, or leave it off, unless another approved run is already scheduled.
3. **Keep write-disable flags active** unless separately approved to change them.
4. **Uninstall the app from the store admin** if the merchant requests disconnect, or if the beta run is complete and no further approved run is scheduled.
5. **Confirm the token / access is revoked**, where applicable.
6. **Confirm with the merchant** that the run is complete and that no changes were made to their store.
7. **Record offboarding in the run log** (Section 15).

A merchant may ask to stop and disconnect at any time (Section 10.1). When they do, execute steps 1–7 immediately and confirm completion back to them in writing.

---

## 20. Post-Run Review

Convene after every session and produce:

- **Internal summary** — what ran, what was found, what broke.
- **CRO quality review** — were the diagnostics genuinely useful to a CRO practitioner, given the sample limits in Section 14?
- **Engineering safety review** — did every guardrail behave as designed? Was the install-time ScriptTag block the only blocked-write event? Any surprises in logs?
- **Data quality review** — was `missingData` honest? Were confidence labels defensible? Any overclaiming? Was the sample treated as a sample?
- **Data handling review** — retention on track, access list respected, deletion owner still assigned.
- **Decision**, one of:
  - **stop** — fundamental problems, return to development;
  - **repeat same store** — inconclusive or fixable issues;
  - **test another store** — success criteria met, see Section 21;
  - **move to Preview-only planning** — ready to design the next stage.

**No customer-facing case study is allowed yet.** We cannot prove lift, so we do not describe results publicly, in sales material, or to other merchants.

### 20.1 Success criteria

Beta 0 passes **only if all** of the following hold:

- Zero Shopify writes (the blocked install-time ScriptTag attempt is not a write — nothing reached the store).
- Zero product / theme / cart / checkout / ScriptTag changes.
- Diagnostics complete without critical errors.
- No tenant leakage (no other store's data appears anywhere).
- No secret leakage (no tokens, URLs, or keys in logs or output).
- No heavy query or performance concern.
- ProductOpportunityScore results are **explainable** — the operator can articulate why each opportunity surfaced.
- Store Baseline results are **honest** — it reports what it knows and admits what it does not.
- `missingData` is preserved, not silently defaulted away (including the expected missing `productViews`).
- AOV / baseline fields are **not overclaimed** — cumulative snapshot data is not presented as windowed performance.
- Findings are framed as **sample-scoped**, not store-wide (Section 14).
- Recommendations make sense compared to the manual CRO review.
- Offboarding completed (Section 19).
- The internal team agrees the system is safe to test on another store.

Partial passes are not passes. If a criterion is unmet, the outcome is "repeat" or "stop," not "proceed with caveats."

---

## 21. Expansion Criteria

A second store may be added **only if all** of the following hold:

- The first run met **all** Section 20.1 success criteria.
- **No** Section 17 stop conditions occurred.
- Manual CRO review found the diagnostics genuinely useful.
- Engineering / release owner approves in writing.
- Product owner approves in writing.
- Data owner approves the environment and retention terms for the additional store.
- Merchant expectations for the new store remain strictly **read-only**.

Expansion means adding one more store to `DIAGNOSTICS_STORE_ALLOWLIST`, with the full preflight repeated for that store. It does **not** mean enabling writes, Apply, or Auto-Apply. Those remain out of scope regardless of how well Beta 0 goes.

### 21.1 Remaining work after this runbook

Once this runbook is reviewed and approved, a first real-store Beta 0 may be **considered** — subject to the Section 12 preflight and Section 9 approvals.

Still explicitly out of scope: **Apply, Auto-Apply, and any write to a client store.**

Planned work after Beta 0:

- Beta 0 report template (standardized internal reporting).
- PdpEvent / `productViews` architecture plan (currently deferred; view data is null by design in Beta 0 because the tracker is intentionally not installed).
- Change→Outcome data model plan.
- Measurement readiness + data honesty plan (the prerequisite for any lift claim).
- Full-catalog diagnostics coverage (removing the 50-product sample limit) if store-wide claims are ever needed.
- Preview-only Beta planning (merchant sees proposed changes, still no writes).
- Controlled Apply Beta — **only much later**, and only after measurement exists.

---

## 22. Final Decision Gate

> **Do not connect a real client store — and do not start an OAuth install — until this runbook is reviewed and explicitly approved by the release owner and product owner.**

| Approval | Name | Date | Signature / confirmation |
|---|---|---|---|
| Release owner | | | |
| Product owner | | | |

Until both rows are filled, Beta 0 has **not** started and no store may be connected.
