# Controlled Beta 0 — Operations Checklist / Runbook

**Status:** DRAFT — awaiting release owner + product owner approval
**Owner:** Release owner (engineering) + Product owner
**Created:** 2026-08-18
**Applies to:** first real-store Beta 0 run
**Document type:** operational source of truth — follow it literally, do not improvise

> **This runbook is not yet approved. No real client store may be connected until Section 20 is signed off.**

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

## 2. Current Approved System State

| Item | Value |
|---|---|
| Approved main commit | `4c4bee9` (or later, if re-verified) |
| PR #14 — write kill switch | Merged and verified (`df1fa76`) |
| PR #15 — diagnostics allowlist gate | Merged and verified (`4c4bee9`), verdict `PR_15_POST_MERGE_VERIFIED` |
| Latest full test suite | 320/320 passing, 19 suites |
| Real store connected | **None** |
| Production / manual deploy by this runbook | **None** |

Any deployment that occurred after the PR #14 / PR #15 merges was **automatic preview/CI only**. This runbook performs no deploy and claims none.

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
- Guards the true Shopify write chokepoint (`action-center.service.js:updateProductDescription`).
- Guards the dangerous routes: `POST /action-center/batch-apply-safe`, `POST /action-center/batch-apply-selected`, `POST /action-center/products/:id/apply`, `POST /action-center/products/:id/rollback`, `POST /decision-engine/actions/execute`.
- Fail-closed. Blocked writes return `403 { error: "beta_read_only", ... }`; the chokepoint throws an error carrying code `BETA_READ_ONLY_WRITE_BLOCKED`.

**PR #15 — Diagnostics Store Allowlist Gate**
- `GET /action-center/opportunity-diagnostics` requires `PRODUCT_OPPORTUNITY_DIAGNOSTICS=true` **AND** the shop present in `DIAGNOSTICS_STORE_ALLOWLIST`.
- The global flag alone is **not** sufficient.
- Missing / empty / malformed / non-allowlisted shop → `404 { error: "Not found." }`, returned **before** any Prisma handle, `resolveStore`, or DB query.
- The 404 body is identical in every blocked case, so enrollment state does not leak.

> **If either guardrail is not verified on the deployed commit, this runbook does not proceed. Stop.**

---

## 5. Required Environment Flags

Configure these in the deployment environment (Render) **before** the store is connected. Configuration is a manual, human-performed step; this runbook does not set them.

| Flag | Required value | Effect |
|---|---|---|
| `CONTROLLED_BETA_READ_ONLY` | `true` | Master beta read-only switch |
| `DISABLE_SHOPIFY_WRITES` | `true` | Hard Shopify write kill switch |
| `APPLY_DISABLED` | `true` | Disables Apply / Rollback / batch-apply routes |
| `PRODUCT_OPPORTUNITY_DIAGNOSTICS` | `true` | Enables the internal diagnostics route globally |
| `DIAGNOSTICS_STORE_ALLOWLIST` | `<canonical-store>.myshopify.com` | Restricts diagnostics to the approved store |

Accepted truthy values for the boolean flags: `true`, `1`, `yes`, `on` (case-insensitive). Anything else — including unset — reads as false.

### 5.1 Allowlist format rules

- Use the **canonical `*.myshopify.com` host only**.
- **Do not use a custom storefront domain.** A custom domain does not normalize and the store will be silently blocked.
- Preferred operational format is the **plain canonical host, no protocol, no trailing slash**:

  ```
  DIAGNOSTICS_STORE_ALLOWLIST=example.myshopify.com
  ```

- The parser does tolerate `https://`, trailing slashes, mixed case, and surrounding whitespace, but **do not rely on that** — write the plain host so the configuration is unambiguous to the next operator.
- **One store only** for the first Beta 0. Multiple entries are technically supported (comma-separated) but are **not approved** without a separate explicit decision.
- **Never put secrets in this runbook or in a report.** No tokens, no database URLs, no API keys. Record only the store's public canonical domain.

### 5.2 Warnings

- ⚠️ If `DIAGNOSTICS_STORE_ALLOWLIST` uses a **custom domain**, the store is blocked and diagnostics return 404. This looks identical to "feature off" — do not debug it by loosening the gate.
- ⚠️ If the allowlist is **missing or empty**, diagnostics return 404 for every store. This is correct fail-closed behavior.
- ⚠️ If any **write-disable flag is missing or not truthy, Beta 0 is not approved.** Do not connect the store. Fix the environment first.
- ⚠️ Setting `PRODUCT_OPPORTUNITY_DIAGNOSTICS=true` **without** the allowlist does not expose anything, but it is still an incomplete configuration — do not treat it as "ready."

---

## 6. First Store Selection Criteria

The first Beta 0 store must satisfy **all** of the following:

- Cooperative client with an existing relationship.
- **Written approval** for read-only diagnostics.
- Store owner explicitly understands **no website changes will be made**.
- Enough product and order data to produce meaningful diagnostics (a near-empty catalog teaches us nothing and will read as `missingData` everywhere).
- Known, confirmed canonical `*.myshopify.com` domain.
- **Not** during a major sale, product launch, unusual traffic spike, ad campaign change, or migration.
- Low operational risk window; the store is not mission-critical during the test window, or the test is scheduled for a low-risk time.
- Merchant expectations documented in writing before the run.

If any criterion fails, choose a different store or a different window. Do not proceed on a "close enough" basis.

---

## 7. Required Approvals

| Role | Responsibility |
|---|---|
| Product owner | Confirms Beta 0 scope, merchant relationship, and that no claims will be made |
| Engineering / release owner | Confirms deployed commit, guardrail verification, and env flag state |
| Operator | Runs the session, captures output, holds the stop authority |
| Abort owner | Named individual who can halt the run at any moment (may differ from operator) |
| Merchant | Consent and expectation confirmation, in writing |
| QA reviewer (optional) | Independent review of diagnostics output quality |

### 7.1 Sign-off table (fill before the run)

| Role | Name | Approval date/time | Notes |
|---|---|---|---|
| Product owner | | | |
| Engineering / release owner | | | |
| Operator | | | |
| Abort owner | | | |
| Merchant consent | | | |
| QA reviewer (optional) | | | |

**A run with any blank mandatory row is not approved.**

---

## 8. Merchant Communication Requirements

### 8.1 The merchant must be told

- The store will be connected for **read-only diagnostics**.
- CRODoctor **will not change** products, theme, cart, checkout, or code.
- **No Apply or Auto-Apply** will be used.
- The goal is to analyze opportunities and validate the quality of our diagnostics.
- **Any future change would require separate, explicit approval** from them.
- They may ask us to stop and disconnect at any time.

### 8.2 Suggested wording

> We'd like to connect your store to CRODoctor in read-only mode. We will look at your product and performance data to see what conversion opportunities our system identifies, and compare that to our own manual review. We will not change anything on your store — no product edits, no theme edits, no checkout changes. Nothing will be applied. If we later want to make any change, we'll come back to you for approval first.

### 8.3 Do not promise

- Guaranteed uplift.
- Revenue increase.
- Automatic optimization.
- Case study results.
- A timeline to improvement.

Honest framing is a hard requirement, not a style preference. We can currently identify opportunities; we cannot yet prove lift.

---

## 9. Preflight Checklist

Complete **every** item before connecting the store. Any unchecked box blocks the run.

- [ ] Main is on approved commit `4c4bee9` or later, and the **deployed** commit matches.
- [ ] PR #14 (write kill switch) verified on the deployed commit.
- [ ] PR #15 (diagnostics allowlist gate) verified on the deployed commit.
- [ ] Latest full test suite known green at 320/320 or later.
- [ ] Store canonical `*.myshopify.com` domain confirmed (not a custom domain).
- [ ] Merchant written approval captured.
- [ ] `CONTROLLED_BETA_READ_ONLY=true` configured and confirmed in the live environment.
- [ ] `DISABLE_SHOPIFY_WRITES=true` configured and confirmed.
- [ ] `APPLY_DISABLED=true` configured and confirmed.
- [ ] `PRODUCT_OPPORTUNITY_DIAGNOSTICS=true` configured and confirmed.
- [ ] `DIAGNOSTICS_STORE_ALLOWLIST` contains **only** the approved store, as a plain canonical host.
- [ ] No Apply / Rollback / Batch Apply / Decision Execute will be called during the session.
- [ ] No theme / product / cart / checkout changes planned.
- [ ] Operator assigned and available for the whole window.
- [ ] Abort owner assigned and reachable.
- [ ] Log monitoring prepared (operator can see API logs live).
- [ ] Internal report destination prepared (Section 13 template ready).
- [ ] Stop conditions (Section 15) reviewed by the operator before starting.

---

## 10. Safe Execution Procedure

> This procedure contains **no write operations**. Do not add any. Do not "just test" Apply on a real store.

1. **Confirm approved main state.** Verify the deployed commit is `4c4bee9` or a later re-verified commit, and that it is what is actually running.
2. **Confirm environment settings manually.** Read back all five flags from Section 5 in the live environment. Confirm values, not just presence.
3. **Confirm the canonical store domain.** Verify the exact `*.myshopify.com` host with the merchant or the Shopify admin URL.
4. **Confirm the diagnostics allowlist contains only that store.** One entry. Exact match. Plain host.
5. **Confirm write-disable flags are active** (`CONTROLLED_BETA_READ_ONLY`, `DISABLE_SHOPIFY_WRITES`, `APPLY_DISABLED` all truthy).
6. **Confirm no manual deploy is being triggered** as part of this session. Any deploy requires separate approval.
7. **Run diagnostics only through the approved internal path:** `GET /action-center/opportunity-diagnostics?shop=<canonical-host>`. No other endpoint is part of Beta 0.
8. **Capture the response/output internally** — raw output stored in the internal report location, with any sensitive values excluded.
9. **Review ProductOpportunityScore output.** For each surfaced opportunity, ask: is this explainable? Would a competent CRO reviewer reach it?
10. **Review Store Baseline output.** Check what it claims to know versus what it marks unknown.
11. **Check `missingData` and confidence honestly.** Do not mentally fill gaps. Sufficiency is not confidence. If the baseline says data is missing, that is a finding, not a defect to paper over.
12. **Do not apply any recommendation.** Not manually, not "just one small one," not in the Shopify admin.
13. **Save internal findings** using the Section 13 template.
14. **Wind down access** if required by the runbook owner: set `PRODUCT_OPPORTUNITY_DIAGNOSTICS=false` or remove the store from `DIAGNOSTICS_STORE_ALLOWLIST` after the session. **Leave the write-disable flags on.**

---

## 11. Forbidden Actions During Beta 0

- No Apply.
- No Rollback.
- No Batch Apply (safe or selected).
- No Decision Engine execute.
- No product description updates.
- No product title updates.
- No product metafield writes.
- No theme edits.
- No app block installation unless separately approved in writing.
- No cart or checkout changes.
- No Liquid / CSS / JS changes.
- No manual code edits to the client store.
- No claim of uplift.
- No merchant-facing public result.
- No expansion to a second store without approval (Section 18).

This list is not advisory. Any item here occurring during Beta 0 is a **stop condition**.

---

## 12. Read-Only Proof Checklist

Complete **after** the session. This is the evidence that Beta 0 was genuinely read-only.

- [ ] Write-disable flags were active for the entire session (verified at start and end).
- [ ] Diagnostics allowlist contained only the approved store.
- [ ] No Apply endpoint was called (`POST /action-center/products/:id/apply`).
- [ ] No Rollback endpoint was called (`POST /action-center/products/:id/rollback`).
- [ ] No Batch Apply endpoint was called (`/action-center/batch-apply-safe`, `/action-center/batch-apply-selected`).
- [ ] No Decision Engine execute endpoint was called (`POST /decision-engine/actions/execute`).
- [ ] No Shopify product / theme / cart / checkout mutation was performed.
- [ ] Logs show no `BETA_READ_ONLY_WRITE_BLOCKED` events — or, if any appear, each one is investigated and documented.
- [ ] No product or theme changes observed in the Shopify admin (spot-check the products that appeared in diagnostics).
- [ ] Internal diagnostics output was captured.
- [ ] No merchant-facing page changed.

> **Clarification on `BETA_READ_ONLY_WRITE_BLOCKED`:** if this appears in logs, the kill switch **worked as designed** — no write reached Shopify. But something in our system *attempted* a write during a read-only run, which is not supposed to happen. Treat it as a **stop condition** and investigate the call path before continuing. A working safety net is not a licence to keep driving at it.

---

## 13. Data Capture Template

Record the following for every Beta 0 session. **Exclude all secrets** — no tokens, no DB URLs, no API keys.

```
BETA 0 SESSION RECORD

Store canonical domain:      <store>.myshopify.com
Date / time (start–end):
Operator:
Abort owner:

Flags confirmed (value read back from live env):
  CONTROLLED_BETA_READ_ONLY:        true / false
  DISABLE_SHOPIFY_WRITES:           true / false
  APPLY_DISABLED:                   true / false
  PRODUCT_OPPORTUNITY_DIAGNOSTICS:  true / false
  DIAGNOSTICS_STORE_ALLOWLIST:      <host only, single entry>

Diagnostics endpoint used:
  GET /action-center/opportunity-diagnostics?shop=<host>

ProductOpportunityScore outputs:
  - products evaluated:
  - score distribution / notable values:
  - explainability notes:

Store Baseline outputs:
  - fields populated:
  - AOV values (if any):
  - reliability / confidence labels:

missingData fields observed:
  -

Top 3 opportunities identified by the system:
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

Any BETA_READ_ONLY_WRITE_BLOCKED events:  yes / no  (if yes, detail + investigation)

FINAL DECISION:  proceed / repeat / stop
Decision rationale:
Decided by:
```

---

## 14. Success Criteria

Beta 0 passes **only if all** of the following hold:

- Zero Shopify writes.
- Zero product / theme / cart / checkout changes.
- Diagnostics complete without critical errors.
- No tenant leakage (no other store's data appears anywhere).
- No secret leakage (no tokens, URLs, or keys in logs or output).
- No heavy query or performance concern.
- ProductOpportunityScore results are **explainable** — the operator can articulate why each opportunity surfaced.
- Store Baseline results are **honest** — it reports what it knows and admits what it does not.
- `missingData` is preserved, not silently defaulted away.
- AOV / baseline fields are **not overclaimed** — cumulative snapshot data is not presented as windowed performance.
- Recommendations make sense compared to the manual CRO review.
- The internal team agrees the system is safe to test on another store.

Partial passes are not passes. If a criterion is unmet, the outcome is "repeat" or "stop," not "proceed with caveats."

---

## 15. Failure / Stop Conditions

**Stop immediately** if any of the following occurs:

- Any write attempt occurs (including a blocked one — see Section 12).
- Any Shopify product / theme / cart / checkout change is detected.
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

## 16. Abort Procedure

1. **Stop the test immediately.** No further requests.
2. **Do not run further diagnostics** against the store.
3. **Disable access:** set `PRODUCT_OPPORTUNITY_DIAGNOSTICS=false`, or remove the store from `DIAGNOSTICS_STORE_ALLOWLIST`.
4. **Keep write-disable flags active** (`CONTROLLED_BETA_READ_ONLY`, `DISABLE_SHOPIFY_WRITES`, `APPLY_DISABLED`). Never relax these during an incident.
5. **Capture logs** covering the full session window, before they roll off.
6. **Document the incident:** what happened, when, what was observed, what was requested.
7. **Notify the engineering / release owner and the product owner.**
8. **If any store change occurred:** identify the exact change, confirm scope with the Shopify admin, and handle it manually with the merchant's knowledge. Do not attempt an automated rollback — Rollback is forbidden in Beta 0 and an automated fix during an incident compounds the problem.
9. **Do not continue** until the root cause has been reviewed and the fix verified on `main`.

> This procedure deliberately contains no write calls and no instruction to test Apply on a real store. Do not add either.

---

## 17. Post-Run Review

Convene after every session and produce:

- **Internal summary** — what ran, what was found, what broke.
- **CRO quality review** — were the diagnostics genuinely useful to a CRO practitioner?
- **Engineering safety review** — did every guardrail behave as designed? Any surprises in logs?
- **Data quality review** — was `missingData` honest? Were confidence labels defensible? Any overclaiming?
- **Decision**, one of:
  - **stop** — fundamental problems, return to development;
  - **repeat same store** — inconclusive or fixable issues;
  - **test another store** — success criteria met, see Section 18;
  - **move to Preview-only planning** — ready to design the next stage.

**No customer-facing case study is allowed yet.** We cannot prove lift, so we do not describe results publicly, in sales material, or to other merchants.

---

## 18. Expansion Criteria

A second store may be added **only if all** of the following hold:

- The first run met **all** Section 14 success criteria.
- **No** Section 15 stop conditions occurred.
- Manual CRO review found the diagnostics genuinely useful.
- Engineering / release owner approves in writing.
- Product owner approves in writing.
- Merchant expectations for the new store remain strictly **read-only**.

Expansion means adding one more store to `DIAGNOSTICS_STORE_ALLOWLIST`. It does **not** mean enabling writes, Apply, or Auto-Apply. Those remain out of scope regardless of how well Beta 0 goes.

---

## 19. Remaining Work After This Runbook

Once this runbook is reviewed and approved, a first real-store Beta 0 may be **considered** — subject to the Section 9 preflight and Section 7 approvals.

Still explicitly out of scope: **Apply, Auto-Apply, and any write to a client store.**

Planned work after Beta 0:

- Beta 0 report template (standardized internal reporting).
- PdpEvent / `productViews` architecture plan (currently deferred; baseline view data is null by design).
- Change→Outcome data model plan.
- Measurement readiness + data honesty plan (the prerequisite for any lift claim).
- Preview-only Beta planning (merchant sees proposed changes, still no writes).
- Controlled Apply Beta — **only much later**, and only after measurement exists.

---

## 20. Final Decision Gate

> **Do not connect a real client store until this runbook is reviewed and explicitly approved by the release owner and product owner.**

| Approval | Name | Date | Signature / confirmation |
|---|---|---|---|
| Release owner | | | |
| Product owner | | | |

Until both rows are filled, Beta 0 has **not** started and no store may be connected.
