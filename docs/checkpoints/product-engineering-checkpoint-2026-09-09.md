# CRODoctor — Product & Engineering Checkpoint — 2026-09-09

**Documented from main:** `00703b4`
**Code work described here lives on an unmerged branch — see §3.**
**Status:** engineering work committed locally and green; no deployment, no real-store execution, no database mutation.

---

## 1. Executive state

Three bounded engineering changes are complete, tested, and committed **locally only**. No PR has been opened and the branch is unpushed. Migration history has been reconciled against real database evidence and one pending migration identified. No live reconciliation, rehearsal, or Shopify contact has occurred.

Real-store Beta 0 remains blocked. Every remaining gate is an owner decision or an operational act, not further documentation.

---

## 2. Approved architecture

**North Star:** an autonomous Shopify CRO operator — not an audit dashboard, analytics product, or copywriting tool.

**Loop:** Scan → Detect → Prioritize → Propose → Preview → Approve → Snapshot → Apply → Verify Live → Measure → Classify → Keep / Rollback → Next Opportunity → Learn.

**Boundaries (unchanged):**
- **Engine 1** — diagnosis, rules, prioritization, proposals. Never writes to Shopify; never issues verdicts.
- **Execution Layer** — approval integrity, snapshots, mutations, verification, idempotency, concurrency, rollback, audit. Sole write chokepoint; never decides what to fix or whether it worked.
- **Engine 2** — measurement, data sufficiency, confounds, honest verdicts, rollback recommendations. Never writes to Shopify; never gates first value.
- **Learning Layer** — durable Opportunity → Intervention → Frozen Context → Outcome.

Reuse existing services, models, and dashboard components. "Copy the Fix" is a fallback, not the destination. No premature ML, A/B infrastructure, new engine, or UI rebuild.

**Canonical documents:** `docs/controlled-beta-0-ops-runbook.md` · `docs/project-checkpoint-current-status.md` · `docs/decisions/shopify-scopes-and-data-environment-beta0.md` · `docs/decisions/webhook-registration-lifecycle-beta0.md` · `docs/rehearsals/non-client-dev-store-rehearsal-plan-beta0.md` · `docs/checkpoints/project-checkpoint-after-pr19-rehearsal-draft-2026-08-27.md`

---

## 3. A — Implemented and verified

**Branch `fix/d1-write-safety-and-rules-version` — three commits, local, unpushed, no PR:**

- **`d87418c`** — `RULES_VERSION` added to the CRO ruleset and exported, with a test. Date-based format matching the repo's `API_VERSION` convention. 20 rules, IDs and order unchanged.
- **`d476cf6`** — D1 write-safety bypasses closed. `registerWebhooks` (POST `webhooks.json`) and `deleteAsset` (DELETE `assets.json`) both used raw `fetch` and so never reached `shopifyFetch`'s mutation gate. Both now carry the same explicit `shouldBlockShopifyWrites()` guard already used by `updateProductDescription`. No new policy logic; `beta-safety.service.js` untouched; no dev-only exception; no broader write permission. `updateImageAltText` (routed through `shopifyFetch`) and `fetchOrderMetrics` (a GET) verified as not defective.
- **`ebb8301`** — 422 discrimination. Previously *every* 422 was treated as "already registered" and reported success; Shopify also returns 422 for validation errors (invalid topic, bad address, missing scope), so rejected registrations were silently recorded as successes. Registration now inspects the response body: 422 is success only on a confirmed duplicate signature; validation errors and unparseable/empty bodies fail closed with sanitized, bounded error detail. Runbook corrected accordingly. **This work is complete, not pending.**

**Tests: 331/331 passing, 19 suites — verified at revision `ebb8301`.** No later revision has been tested; do not assume any subsequent commit is green.

**No deployment, no real Shopify execution, and no database mutation resulted from this work.**

### Database evidence (read-only, owner-supplied)

- 23 repository migration directories; 24 history rows representing **22 distinct applied migrations**.
- Two rolled-back-then-reapplied pairs (`20260513000000`, `20260601000000`) — normal Prisma recovery; both ultimately applied.
- **22/22 applied checksums match** the repository files (SHA-256 over `migration.sql` bytes).
- One pending migration: **`20260615000000_enable_rls_on_private_tables`** — 11 × `ALTER TABLE IF EXISTS … ENABLE ROW LEVEL SECURITY`.
- All 11 target tables observed with **RLS enabled, FORCE false, zero policies** — the migration's intended state already exists.
- Installed Prisma CLI: **5.22.0** (`package.json` declares `^5.14.0`; the caret resolved upward).
- **No isolated reconciliation rehearsal has run** — local PostgreSQL and container tooling are absent.
- **No live migration or `resolve` was authorized or executed.**
- Project ref `visyqnfayqluyjcqrkim` may be used by the live Render service. **Treat as production-in-effect** until independently verified otherwise.

---

## 4. B — Approved direction, not yet implemented

**Minimum persistence layer:** `Opportunity` + `ExecutionContext` + `ruleVersion`, followed by durable `ExecutionOutcome` **before the first real measured beta execution can lose its verdict**. Reuse `ActionItem`, `ContentExecution`, `ProductMetricsSnapshot`, and the existing approval integrity, snapshots, two-phase write, verification, idempotency, and rollback. Constraints: missing metrics must never be stored as zero; `disappeared` is not evidence of `manually_fixed`; context frozen pre-mutation and linked immutably to the execution.

**Product-experience principles:** reinforce meaningful progress and learning; keep effort, implementation quality, and business outcomes strictly separate; communicate opportunity cost only on an evidence hierarchy (verified data → explicitly labelled scenario → qualitative). No fabricated lift, no invented revenue figures, no artificial urgency. Lightweight layer over existing data; integrate into existing UI only after core loop reliability.

---

## 5. C — Open decisions and blockers

- **D4 — webhook lifecycle policy: OPEN.** No Option A/B/C selected. The current guard prevents **new** subscriptions through the blocked path; **existing subscriptions may still exist and deliver events.** Do not claim global absence of push-based sync or uninstall detection. Requires an owner decision before real-store OAuth.
- **D1 review/acceptance** and the release workflow for the three commits.
- **Named non-client synthetic Shopify development store** — still `<devstore>.myshopify.com`.
- **Dev-only `write_products` exception** and owner approvals.
- **Runbook §22 sign-offs** (both rows blank) and named rehearsal operators.
- **Isolated PostgreSQL reconciliation rehearsal**, then a separately approved live reconciliation.
- **Five-merchant validation** using read-only public data and previews only.

**Pending review — possible residual contradiction:** the Runbook's §6.1 and §16 reconciliation guidance was revised across several passes. Recorded here as *pending review* rather than edited further in this checkpoint.

---

## 6. Next three delivery priorities

1. Review and land the three D1/RULES_VERSION commits through the normal PR workflow.
2. Collect the outstanding owner decisions and name the non-client synthetic development store so the merged rehearsal plan can be prepared.
3. Provision disposable PostgreSQL tooling and run the isolated migration-reconciliation rehearsal.

---

## 7. Safety boundaries

Real-store Beta 0, real-store OAuth install, merchant consent, Apply / Rollback / Auto-Apply, write scopes, storefront mutation, diagnostics on a real store, real merchant data in staging, production rollout, and public case-study or uplift claims **all remain blocked**. §22 is unsigned and the signed release posture is unchanged. No decision in this checkpoint authorizes a real-store Apply.
