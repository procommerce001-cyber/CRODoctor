# Supabase RLS Security Check — `public._prisma_migrations`

Read-only guard so a fixed Supabase exposure cannot silently return.

## What was fixed

Supabase Security Advisor (project `crodoctor-staging`) reported:

- **Issue:** RLS Disabled in Public
- **Entity:** `public._prisma_migrations`
- **Warning:** the table was readable/writable by anyone with the project URL.

Fixed manually via the Supabase SQL Editor:

```sql
begin;
alter table public._prisma_migrations enable row level security;
revoke all on table public._prisma_migrations from anon;
revoke all on table public._prisma_migrations from authenticated;
revoke all on table public._prisma_migrations from public;
commit;
```

## Expected fixed state

| Check | Expected |
| --- | --- |
| Table exists | yes |
| `rls_enabled` | `true` |
| `rls_forced` | `false` |
| Grants to `anon` / `authenticated` / `public` | none |
| Policies on the table | none |

`FORCE ROW LEVEL SECURITY` is intentionally left **off**. With RLS on and no
policies, the table is deny-all for `anon`/`authenticated`, while the table owner
still bypasses RLS — which is what keeps Prisma's migration bookkeeping working.
Turning FORCE on would subject the owner to RLS and break it. Likewise, do **not**
add a policy here: a policy would re-grant the access the fix removed.

## Running the checker

```bash
cd api
SUPABASE_EXPECTED_PROJECT_REF=<staging-project-ref> \
SUPABASE_SECURITY_DATABASE_URL="<staging-db-url-from-supabase>" \
npm run security:check
```

Exit codes: `0` all checks pass · `1` exposure found · `2` unsafe/incomplete
config (no connection attempted) · `3` connection or query error.

### Rules

- **Never commit or paste the database URL** — not into this repo, a commit
  message, an issue, or a chat log. Pass it inline for a single run, or export it
  in your shell session only.
- **Get the staging URL from Supabase** → Project Settings → Database → Connection
  string, for the project whose ref matches `SUPABASE_EXPECTED_PROJECT_REF`.
- **Do not use the local `DATABASE_URL` from `api/.env`.** It is known to point at
  a retired project ref, so a check run against it would report on the wrong
  database. The checker deliberately ignores `DATABASE_URL` and requires its own
  variable for exactly this reason.
- **The checker is read-only.** It queries `pg_class`, `information_schema.role_table_grants`,
  and `pg_policies` only. It never reads table data and never issues a write.
- It **fails closed**: if either variable is missing, or if the URL does not
  contain the expected project ref, it aborts *before* opening a connection.
- It never prints the connection string, a password, or any env value; driver
  error messages are redacted before output.

### Checking production

Production must be checked only with **its own** expected ref and explicit
approval — never by reusing the staging ref. The ref-match gate is what prevents
an accidental cross-environment run, so pass the production ref deliberately.

## Not yet automated

No scheduled CI workflow is wired up, because the repo has no
`.github/workflows/` directory and no GitHub Secret holding a staging database
URL. Adding one is a reasonable follow-up: it would need a
`SUPABASE_SECURITY_DATABASE_URL_STAGING` secret, a scheduled (not per-PR)
trigger, and a skip-when-secret-absent guard so normal CI never breaks.
