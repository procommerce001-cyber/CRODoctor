# CRODoctor — Controlled Beta Handoff

_Last updated: 2026-06-18_

A concise, verified operational snapshot for resuming work. No secrets, no raw
logs. Project refs are included (they are identifiers, not credentials).

## Verified current state

- **No P0 blocker currently known.**
- CRODoctor is **ready for a controlled internal/friendly beta with guardrails**.
- **Not** ready for broad external merchant beta or paid production.
- Current beta scope is **functional / product validation**, not a statistically
  proven lift program.
- Controlled Apply and controlled Rollback have both succeeded.
- API health is green: `/health` = 200; unauthenticated `/auth/me`,
  `/dashboard/selection`, `/auth/onboarding-status` all return 401.

## What is safe now

- **Apply / Rollback** are reversible and guarded:
  - Orphan-write edge hardened via a two-phase Apply flow + advisory locking.
  - `public.session` is tracked in Prisma.
  - No autonomous Apply or autonomous Rollback in the current beta.
- **Database / RLS security** (active DB only):
  - 11 private application tables confirmed `rls_enabled=true`, `force_rls=false`,
    `policies=0`.
  - API stayed healthy after RLS was enabled.

## Active database identity

- Active Render runtime DB = Supabase project **crodoctor-staging**, project ref
  **`visyqnfayqluyjcqrkim`**.
- Old / inactive project ref: **`eiirxupzzhfuqkjspazx`** — do not target.
- **Do not trust local `DATABASE_URL` / `.env` blindly** for staging/production DB
  actions. Verify the active target ref before any DB action.
- Never store connection strings, passwords, tokens, or secrets in the repo.

## What remains blocked (debt, not active exposure)

- RLS on the 11 private tables was applied **manually** via the Supabase SQL
  Editor, so Prisma migration history for
  `20260615000000_enable_rls_on_private_tables` is **not yet reconciled**.
- `public._prisma_migrations` RLS warning is intentionally left unresolved for now.
- **Render Pre-Deploy / automatic `migrate deploy` must remain OFF** until
  migration history is reconciled and verified.
- This is migration/automation debt — **not** a known active merchant-data
  exposure.

## Branches and deployment status

- **UX Phase 1 branch (unmerged):** `ux/apply-rollback-clarity-phase-1`
  - `a448540` — Improve Apply and Rollback UX clarity
  - `c8b34a5` — Polish rollback CTA visibility
  - **Not merged into `main`. No deploy to main/production performed.**
  - Frontend-only changes: preview "store hasn't changed yet" disclaimer; clearer
    "Live on Shopify" copy; "collecting data" measurement wording; clearer
    Undo/Rollback wording; subtle secondary-destructive Undo styling; confirmation
    remains stronger/destructive than the first-level Undo.
  - **Visual QA still required on the Vercel Preview before any PR merge.**
- **Vercel routing note:** the Vercel Preview correctly builds the `web` Next.js
  app. The root route `/` currently shows the untouched create-next-app starter
  page — the CRODoctor dashboard is at **`/dashboard`**. For preview QA, open
  `/dashboard`. Do **not** click "Deploy Now" from the starter screen. Replacing
  `/` with a redirect to `/dashboard` is an optional, separate future frontend
  task.

## Data / measurement posture

- **Verdict: REAL_LIFT_POSSIBLE_BUT_PROOF_NOT_READY.** CRODoctor can plausibly
  create useful lift on under-optimized product pages, but must not claim
  statistically proven causal lift yet.
- Existing measurement foundation already includes: `ProductMetricsSnapshot`
  before/after windows, execution linkage, order/unit/revenue capture, Shopify
  Analytics + first-party `PdpEvent` fallback, sample thresholds,
  `ProductPerformanceProfile`.
- **Correction to earlier assumptions:** `decisionV2` already contains
  significant measurement/inference infrastructure — `confidenceScore`,
  `dataQualityScore`, `downsideRiskScore`, `confoundFlags`, adjusted/credited lift
  concepts, `explanationForMerchant`, and beta/non-causal guardrails.
  **Future measurement work must reuse `decisionV2`, not build a parallel
  inference layer.**
- Key risk: legacy `measurementConfidence` represents **sample sufficiency**, not
  proof of statistical confidence.
- **Next approved measurement task (not started):** DATA #2B — implement
  measurement sufficiency / data quality / honest labels **without schema
  changes**. Avoid schema migrations for DATA #2 while migration history is
  unresolved.

## Next actions in order

1. **Visual QA** of the Vercel Preview dashboard for the UX branch, at
   `<preview-url>/dashboard`.
2. After successful visual QA: open a PR from
   `ux/apply-rollback-clarity-phase-1` → `main`. **Do not merge until QA is
   approved.**
3. After the UX branch is safely merged or explicitly paused: plan/implement
   **DATA #2B** narrowly (reuse `decisionV2`, no schema changes).
4. **Before external merchant beta:** UX clarity merged and verified; Render
   cold-start approach decided; Prisma migration-history reconciliation
   planned/resolved.
5. **Before paid production:** migration history reconciled; Render Pre-Deploy
   safely enabled; `_prisma_migrations` RLS decision handled; measurement/
   attribution claims improved; ShopifyQL / analytics maturity reviewed.

## Critical do-not-do rules

- Do not enable Render Pre-Deploy / automatic `migrate deploy` until migration
  history is reconciled and verified.
- Do not run DB actions against an unverified target — confirm the active ref
  (`visyqnfayqluyjcqrkim`) first.
- Do not build a parallel measurement inference layer — reuse `decisionV2`.
- Do not introduce schema migrations for DATA #2 while migration history is
  unresolved.
- Do not claim statistically proven / causal lift in merchant-facing surfaces.
- Do not merge the UX branch before visual QA approval.
- Do not store secrets, connection strings, or tokens in the repo.
