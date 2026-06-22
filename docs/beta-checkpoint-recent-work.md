# CRODoctor Beta Checkpoint — Recent Work

_Factual handoff checkpoint. Last updated: 2026-06-22._

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
- **DATA #2B (honest measurement labels)** — **merged into `main` via PR #3 and
  production verified.** `measurement-labels.js` exists on main; merchant-facing
  copy is confident/value-positive with no "no proof" regression. API health
  green after merge.
- **No active implementation branch is currently approved for merge.** Next
  technical priority (DATA #2C vs migration-history reconciliation) is undecided
  and must not be started without a separate scoped prompt.

`main` HEAD at checkpoint: **`8db2b08`** (Merge pull request #3).

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

### DATA #2B — Measurement interpretation / honest labels
- **Branch:** `data/measurement-honest-labels-no-schema`
- **PR:** #3
- **Commits:**
  - `9803606` — Add honest measurement interpretation labels (implementation)
  - `c167376` — Refine merchant-facing measurement wording (value fix)
- **Merge commit on main:** `8db2b08` (Merge pull request #3)
- **Status:** **merged into `main`** and **production verified.**

**What changed**
- Adds a pure, no-schema interpretation helper
  (`api/src/services/measurement-labels.js`, `deriveMeasurementLabels()`) that
  reuses the already-computed `decisionV2` scores and exposes safer derived
  labels: data sufficiency, data quality, measurement signal, evidence source,
  and plain-language caveats.
- Spreads those derived fields additively into both `buildDecisionV2` return
  paths in `api/src/services/metrics.service.js`.
- Adds optional (back-compat) fields to the `DecisionV2` type in `web/lib/api.ts`.
- Renders signal label + disclaimer + caveats in
  `web/components/dashboard/DecisionV2Card.tsx`.
- Adds scenario tests in `api/src/__tests__/metrics-decision.test.js`.
- Merchant-facing wording remains confident and value-positive
  ("Tracking impact — we'll confirm as more visitors see this change." /
  "Collecting more data before making a final recommendation."); no
  customer-facing "not statistical proof / no proof" wording. The earlier
  value-dampening disclaimer was reframed in `c167376`.

**What did NOT change**
- No Prisma schema, no migrations, no DB writes/persistence.
- No Shopify writes, no Apply/Rollback behavior.
- No env/settings changes, no dependencies.
- No new statistical inference engine; `decisionV2` is reused as the single
  source (no p-values, Bayesian, A/B tests, holdouts, or attribution model).

**Verified after merge:** `main` contains `8db2b08`; both commits are ancestors;
`measurement-labels.js` present; API health green (see §7).

---

## 3. In-progress work

- **No active implementation branch is currently approved for merge.**
- **DATA #2B is complete** (merged + production verified — see §2).
- **DATA #2C has not started.**
- **Prisma migration-history reconciliation remains paused** (see §5).

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

1. Optionally delete merged branches on GitHub after confirming they are fully
   merged into `main`:
   - `ux/apply-rollback-clarity-phase-1`
   - `frontend/root-redirect-dashboard`
   - `data/measurement-honest-labels-no-schema`
2. Optionally open/merge the docs checkpoint branch
   (`docs/beta-checkpoint-recent-work`) later if desired.
3. Decide the next technical priority — **either**:
   - DATA #2C, **or**
   - Prisma migration-history reconciliation / Render Pre-Deploy unblock.
4. **Do not start either without a separate scoped prompt.**

---

## 7. Last known commands / checks (non-secret)

- **Main verification:** `git log origin/main` contains `00a365d` (PR #1),
  `eb9b965` (PR #2), and `8db2b08` (PR #3, DATA #2B); `main` in sync with
  `origin/main`.
- **PR #3 post-merge API health:** `/health` → 200; unauthenticated `/auth/me`
  → 401; `/dashboard/selection?shop=jw5kjx-1z.myshopify.com` → 401;
  `/auth/onboarding-status` → 401 (no 500s).
- **DATA #2B verification:** `cd api && npm test` → 180 pass / 0 fail (includes
  the new label scenario tests).
- **Frontend checks:** `cd web && npx tsc --noEmit` → passed (0 errors);
  `npm run lint` → 0 errors, 11 pre-existing warnings; `npm run build` → passed.

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
