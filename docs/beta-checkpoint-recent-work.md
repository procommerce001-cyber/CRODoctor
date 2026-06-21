# CRODoctor Beta Checkpoint — Recent Work

_Factual handoff checkpoint. Last updated: 2026-06-21._

This document is a point-in-time record of recently completed and in-progress
work. It changes no product behavior. Where a status is not independently
verified, it is marked **unknown / needs verification**.

---

## 1. Executive status

- **UX Phase 1 (Apply/Rollback clarity)** — merged into `main` (PR #1) and
  production-verified.
- **Root redirect `/` → `/dashboard`** — merged into `main` (PR #2) and verified.
- **API health** — green at last check (`/health` 200; unauthenticated
  `/auth/me`, `/dashboard/selection`, `/auth/onboarding-status` all 401, no 500s).
- **DATA #2B (honest measurement labels)** — exists on feature branch
  `data/measurement-honest-labels-no-schema`, **not merged**. Implementation +
  merchant-facing wording fix are committed and pushed.
- **No current instruction to deploy or to merge DATA #2B.** Next gate is a
  final audit, then (if approved) a PR.

`main` HEAD at checkpoint: **`eb9b965`**.

---

## 2. Completed and merged work

### UX Phase 1 — Apply/Rollback clarity
- **Branch:** `ux/apply-rollback-clarity-phase-1`
- **PR:** #1
- **Commits:** `a448540` (Improve Apply and Rollback UX clarity), `c8b34a5` (Polish rollback CTA visibility)
- **Merge commit on main:** `00a365d`
- **Files changed (summary):** frontend only —
  `web/components/dashboard/OptimizationFeed.tsx`,
  `web/components/dashboard/ProductInspectorPanel.tsx`,
  `web/components/dashboard/previewCopy.ts`
- **Verified:** local visual QA + rollback-CTA QA passed; tsc/lint/build green.
- **Production:** verified (dashboard loads; Undo CTA is a secondary destructive
  action; Confirm revert remains stronger; measuring copy does not imply proven lift).
- **Safety notes:** UX/copy/styling only; no backend, API, DB, Apply/Rollback
  logic, or Shopify-write changes.

### Root redirect `/` → `/dashboard`
- **Branch:** `frontend/root-redirect-dashboard`
- **PR:** #2
- **Commit:** `8edf121` (Redirect root route to dashboard)
- **Merge commit on main:** `eb9b965`
- **Behavior:** root route now server-side redirects to `/dashboard` via
  `redirect()` from `next/navigation`; the default create-next-app starter page
  is removed. `/dashboard` itself is unchanged.
- **Verified:** `main` contains the change; `web/app/page.tsx` confirmed; build
  prerenders `/` as a redirect; tsc/lint/build green. Live browser hop reported
  working by the user.
- **Safety notes:** single frontend file (`web/app/page.tsx`); no dashboard,
  auth/session, API, or dependency changes.

---

## 3. In-progress work — DATA #2B (measurement interpretation / honest labels)

- **Branch:** `data/measurement-honest-labels-no-schema`
- **Commits:**
  - `9803606` — Add honest measurement interpretation labels (implementation)
  - `c167376` — Refine merchant-facing measurement wording (value fix) **← branch HEAD**
- **Pushed to origin:** yes (`origin/data/measurement-honest-labels-no-schema` at `c167376`).
- **Current state:** implementation complete; merchant-facing wording fix
  complete. **Ready for final audit; not merged.**

**What it changes**
- Adds a pure, no-schema interpretation helper
  (`api/src/services/measurement-labels.js`, `deriveMeasurementLabels()`) that
  relabels the already-computed `decisionV2` scores into merchant-safe labels:
  data sufficiency, data quality, signal label, evidence source, disclaimer,
  and plain-language caveats.
- Spreads those derived fields additively into both `buildDecisionV2` return
  paths in `api/src/services/metrics.service.js`.
- Adds optional (back-compat) fields to the `DecisionV2` type in `web/lib/api.ts`.
- Renders signal label + disclaimer + caveats in
  `web/components/dashboard/DecisionV2Card.tsx`.
- Adds scenario tests in `api/src/__tests__/metrics-decision.test.js`.

**What it does NOT change**
- No Prisma schema, no migrations, no DB writes/persistence.
- No Shopify writes, no Apply/Rollback logic.
- No new inference engine; `decisionV2` is reused as the single source.
- No p-values, Bayesian inference, A/B tests, holdouts, or attribution model.
- No dependencies added.

**Merchant-facing wording issue/fix**
- **Issue (found in audit):** the original measured-state disclaimer
  ("This is an early measurement signal, not statistical proof.") used
  value-dampening "no proof" wording on the customer-facing card.
- **Fix (committed in `c167376`):** reframed to confident, honest copy —
  "Tracking impact — we'll confirm as more visitors see this change." and
  "Collecting more data before making a final recommendation." Internal
  sufficiency/quality/caveat semantics are unchanged. Tests now fail if merchant
  labels contain proof claims **or** "no proof / not proven / not statistically
  significant" wording.

**Readiness:** ready for final DATA #2B audit. **Not ready for merge** until that
audit passes and a PR is opened and reviewed.

---

## 4. Safety boundaries (for this body of work)

- No schema changes approved.
- No migrations approved or run.
- No DB writes.
- No Shopify writes.
- No live Apply/Rollback actions.
- No Render/Vercel/Supabase settings changes.
- No deployment actions.
- No autonomous keep/undo/stack decisions.

---

## 5. Known paused risks / technical debt

- **Prisma migration-history reconciliation:** paused.
- **Render Pre-Deploy:** blocked until migration history is reconciled.
- **RLS private-table fix:** applied manually earlier — **do not touch RLS now.**
- **DATA #2C:** not started.
- **Statistical inference (p-values / Bayesian):** deferred.
- **A/B testing / randomized holdout:** deferred.
- **Attribution model:** deferred.
- **Execution-linked snapshot comparison fix:** deferred.

---

## 6. Recommended next steps (in order)

1. Finish/verify the merchant-facing value fix for DATA #2B. _(Done in `c167376`;
   confirm in audit.)_
2. Run the final DATA #2B audit.
3. If approved, open a PR for `data/measurement-honest-labels-no-schema`.
4. Merge only after PR checks and a final merge-safety review.
5. Verify production after merge.
6. Only after that, consider DATA #2C or migration-history reconciliation.

---

## 7. Last known commands / checks (non-secret)

- **Main verification:** `git log origin/main` contains `00a365d` (PR #1) and
  `eb9b965` (PR #2); `main` in sync with `origin/main`.
- **API health:** `/health` → 200; unauthenticated `/auth/me`,
  `/dashboard/selection?shop=…`, `/auth/onboarding-status` → 401 (no 500s).
- **DATA #2B tests:** `cd api && npm test` → 180 pass / 0 fail (includes the new
  label scenario tests).
- **Frontend checks:** `cd web && npx tsc --noEmit` → clean; `npm run lint` →
  0 errors, 11 pre-existing warnings; `npm run build` → passed.

---

## 8. Do-not-touch list

- DB
- Shopify
- Apply / Rollback
- Migrations
- Env files
- Render / Vercel / Supabase settings
- DATA #2C
- Autonomous optimization

---

_End of checkpoint._
