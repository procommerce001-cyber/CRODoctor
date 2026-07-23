#!/usr/bin/env node
'use strict';

/**
 * Read-only Supabase/Postgres exposure guard for public._prisma_migrations.
 *
 * Background: Supabase Security Advisor flagged "RLS Disabled in Public" on
 * public._prisma_migrations (staging project crodoctor-staging). The fix was
 * applied manually: RLS enabled, and anon/authenticated/public grants revoked.
 * This script re-checks that state so the exposure cannot silently return.
 *
 * Guarantees:
 *   - Metadata only. It never reads, writes, or alters table data.
 *   - It never reads DATABASE_URL. The local .env is known to be unreliable and
 *     has pointed at a retired project ref, so this checker requires its own
 *     explicit connection string instead.
 *   - It fails closed: missing config, or a URL that does not match the expected
 *     project ref, aborts BEFORE any connection is opened.
 *   - It never prints the connection string, a password, or any env value.
 *
 * Required env:
 *   SUPABASE_EXPECTED_PROJECT_REF   e.g. the staging project ref
 *   SUPABASE_SECURITY_DATABASE_URL  connection string for that same project
 *
 * Exit codes: 0 = all checks pass, 1 = exposure/risk found, 2 = unsafe or
 * incomplete configuration (no connection attempted), 3 = connection/query error.
 */

const SCHEMA = 'public';
const TABLE = '_prisma_migrations';
const EXPOSED_ROLES = ['anon', 'authenticated', 'public'];

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_UNSAFE_CONFIG = 2;
const EXIT_ERROR = 3;

/**
 * Strip anything that could carry a credential out of text destined for stdout.
 * Applied to every error message, since driver errors can embed the DSN.
 */
function redact(text, secrets) {
  let safe = String(text == null ? '' : text);
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      safe = safe.split(secret).join('[REDACTED]');
    }
  }
  // Catch-all for any URI that still carries user:password@host.
  return safe.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]*/g, '[REDACTED_URL]');
}

function pass(label) {
  console.log(`PASS  ${label}`);
}

function fail(label, detail) {
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const expectedRef = (process.env.SUPABASE_EXPECTED_PROJECT_REF || '').trim();
  const databaseUrl = (process.env.SUPABASE_SECURITY_DATABASE_URL || '').trim();
  const secrets = [databaseUrl].filter(Boolean);

  console.log(`Supabase RLS security check — ${SCHEMA}.${TABLE}`);

  // --- Fail-closed config gate: no connection is opened before this passes. ---
  if (!expectedRef) {
    fail('config', 'SUPABASE_EXPECTED_PROJECT_REF is not set');
    console.log('\nRESULT: UNSAFE_CONFIG (no database connection attempted)');
    return EXIT_UNSAFE_CONFIG;
  }
  if (!databaseUrl) {
    fail('config', 'SUPABASE_SECURITY_DATABASE_URL is not set');
    console.log('\nRESULT: UNSAFE_CONFIG (no database connection attempted)');
    return EXIT_UNSAFE_CONFIG;
  }
  if (!databaseUrl.includes(expectedRef)) {
    fail(
      'target confirmation',
      'SUPABASE_SECURITY_DATABASE_URL does not reference the expected project ' +
        'ref — refusing to connect to an unconfirmed database'
    );
    console.log('\nRESULT: UNSAFE_CONFIG (no database connection attempted)');
    return EXIT_UNSAFE_CONFIG;
  }
  pass(`target confirmation — connection references expected project ref ${expectedRef}`);

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({
    datasourceUrl: databaseUrl,
    log: ['warn', 'error'],
  });

  let failures = 0;

  try {
    // 1. Table existence + RLS flags.
    const tableRows = await prisma.$queryRaw`
      select
        c.relrowsecurity      as rls_enabled,
        c.relforcerowsecurity as rls_forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${SCHEMA}
        and c.relname = ${TABLE}
    `;

    if (tableRows.length === 0) {
      fail('table exists', `${SCHEMA}.${TABLE} not found`);
      console.log('\nRESULT: FAIL (table not found — verify the target database)');
      return EXIT_FAIL;
    }
    pass(`table exists — ${SCHEMA}.${TABLE}`);

    const { rls_enabled: rlsEnabled, rls_forced: rlsForced } = tableRows[0];

    if (rlsEnabled === true) {
      pass('row level security enabled');
    } else {
      failures += 1;
      fail('row level security enabled', 'RLS is DISABLED — table is publicly exposed');
    }

    // FORCE RLS is deliberately expected to stay off: it would subject the table
    // owner to RLS and break Prisma migration bookkeeping.
    if (rlsForced === false) {
      pass('force row level security not enabled');
    } else {
      failures += 1;
      fail(
        'force row level security not enabled',
        'FORCE RLS is ON — this can break Prisma migration bookkeeping'
      );
    }

    // 2. Grants to publicly reachable roles.
    const grants = await prisma.$queryRaw`
      select grantee, privilege_type
      from information_schema.role_table_grants
      where table_schema = ${SCHEMA}
        and table_name = ${TABLE}
        and grantee in ('anon', 'authenticated', 'public')
      order by grantee, privilege_type
    `;

    if (grants.length === 0) {
      pass(`no grants for ${EXPOSED_ROLES.join('/')}`);
    } else {
      failures += 1;
      const summary = grants
        .map((g) => `${g.grantee}:${g.privilege_type}`)
        .join(', ');
      fail(`no grants for ${EXPOSED_ROLES.join('/')}`, `found ${grants.length} grant(s) — ${summary}`);
    }

    // 3. Policies. Any policy here would re-open access that the fix removed.
    const policies = await prisma.$queryRaw`
      select policyname, cmd, roles
      from pg_policies
      where schemaname = ${SCHEMA}
        and tablename = ${TABLE}
      order by policyname
    `;

    if (policies.length === 0) {
      pass('no policies on table');
    } else {
      failures += 1;
      const summary = policies.map((p) => `${p.policyname}(${p.cmd})`).join(', ');
      fail('no policies on table', `found ${policies.length} policy/policies — ${summary}`);
    }
  } catch (error) {
    fail('database check', redact(error && error.message, secrets));
    console.log('\nRESULT: ERROR (could not complete read-only verification)');
    return EXIT_ERROR;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }

  if (failures > 0) {
    console.log(`\nRESULT: FAIL (${failures} check(s) failed) — ${SCHEMA}.${TABLE} may be exposed`);
    return EXIT_FAIL;
  }

  console.log(`\nRESULT: PASS — ${SCHEMA}.${TABLE} is not publicly exposed`);
  return EXIT_PASS;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const secrets = [(process.env.SUPABASE_SECURITY_DATABASE_URL || '').trim()].filter(Boolean);
    fail('unexpected', redact(error && error.message, secrets));
    console.log('\nRESULT: ERROR');
    process.exitCode = EXIT_ERROR;
  });
