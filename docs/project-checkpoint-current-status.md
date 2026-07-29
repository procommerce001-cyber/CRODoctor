# Project Checkpoint — Current Approved State

This is a short, docs-only record of completed + verified work. It records what is
merged and safe on `main`, not aspirational plans.

## Latest checkpoint — after PR #8 (2026-07-28)

**`main` at merge commit `d256bd1`.**

### PR #8 — Add Supabase RLS security guard

- **Merge commit:** `d256bd1`
- **Merged branch:** `security/supabase-rls-prisma-migrations-guard`
- **Branch commits:**
  - `2688e7b` — Add Supabase RLS security check
  - `43e6d98` — Clarify Supabase RLS guard verification
- **Changed files (3, additive only):**
  - `api/scripts/check-supabase-rls-security.js`
  - `api/package.json` (adds `security:check` npm script only)
  - `docs/supabase-rls-security-check.md`

### Purpose

Read-only Supabase/Postgres security guard for the previously fixed
`public._prisma_migrations` "RLS Disabled in Public" exposure (staging project
`crodoctor-staging`). Lets the fixed state be re-checked safely in the future.

### Supabase status (manual)

- Security Advisor UI showed **0 errors / no errors detected** after the manual fix
  (enable RLS + revoke anon/authenticated/public grants).
- Live DB-level guard was **not run** because no confirmed staging DB
  password/connection string was available.
- **No need to reset the DB password just for this.** Running the guard later with a
  staging DB URL provides optional independent verification.

### Verification (post-merge, on `main`)

- `2688e7b` and `43e6d98` reachable from `main`: yes
- `node --check scripts/check-supabase-rls-security.js`: pass
- `npm run security:check` with missing env: fails closed (exit 2) **before** any DB
  connection; no secrets printed
- `npm test`: **245/245 passing**
- No DB connection · no SQL · no manual deploy
- No runtime behavior change · no Shopify write-path change · no Apply/Rollback
  change · no Output Contract Validator change · no ProductOpportunityScore change ·
  no Prisma schema/migration change · no frontend change · no dependency/lockfile
  change

**Verdict:** `PR_8_POST_MERGE_VERIFIED`.

### Next recommended work

- ProductOpportunityScore **internal diagnostics behind a flag** (Option A from the
  wiring plan) — dark, read-only, no default behavior change.
- First, optionally merge the docs-only ProductOpportunityScore wiring-plan branch
  if still open (`docs/product-opportunity-score-wiring-plan`).
