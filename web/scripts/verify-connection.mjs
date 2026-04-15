/**
 * verify-connection.mjs
 *
 * Replicates the exact request logic the frontend uses to fetch the dashboard.
 * Run any time you suspect a connectivity issue:
 *
 *   node web/scripts/verify-connection.mjs
 *
 * Uses the same env vars as the frontend — reads from web/.env.local if present.
 * Fails loudly and exits 1 on any misconfiguration or connectivity failure.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load .env.local ───────────────────────────────────────────────────────────
function loadEnv() {
  const env = {};
  const envPath = resolve(__dirname, '../.env.local');
  try {
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...rest] = trimmed.split('=');
      if (key) env[key.trim()] = rest.join('=').trim();
    }
    console.log('✓  Loaded .env.local');
  } catch {
    console.error('✗  .env.local not found at', envPath);
    console.error('   Copy web/.env.example → web/.env.local and fill in values.');
    process.exit(1);
  }
  return env;
}

// ── Validate required vars ────────────────────────────────────────────────────
function validateEnv(env) {
  const required = ['NEXT_PUBLIC_API_BASE_URL', 'NEXT_PUBLIC_SHOP'];
  let failed = false;
  for (const key of required) {
    if (!env[key]) {
      console.error(`✗  Missing required env var: ${key}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);

  const apiBase = env['NEXT_PUBLIC_API_BASE_URL'];
  if (apiBase.includes('localhost:3001')) {
    console.error(
      `✗  NEXT_PUBLIC_API_BASE_URL="${apiBase}" points to port 3001.` +
      '\n   Port 3001 is the Next.js dev server, not the API.' +
      '\n   Set it to http://localhost:3000 in .env.local'
    );
    process.exit(1);
  }
  if (apiBase.endsWith('/')) {
    console.error(`✗  NEXT_PUBLIC_API_BASE_URL has a trailing slash. Remove it.`);
    process.exit(1);
  }

  console.log(`✓  NEXT_PUBLIC_API_BASE_URL = ${apiBase}`);
  console.log(`✓  NEXT_PUBLIC_SHOP         = ${env['NEXT_PUBLIC_SHOP']}`);
  console.log(`✓  NEXT_PUBLIC_DEV_BEARER_TOKEN = ${env['NEXT_PUBLIC_DEV_BEARER_TOKEN'] ? '(set)' : '(not set — will get 401)'}`);
}

// ── Build headers (mirrors apiHeaders() in lib/api.ts exactly) ───────────────
function buildHeaders(env, extra = {}) {
  const headers = { ...extra };
  const token = env['NEXT_PUBLIC_DEV_BEARER_TOKEN'];
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

// ── Run connectivity checks ───────────────────────────────────────────────────
async function run() {
  const env     = loadEnv();
  validateEnv(env);

  const apiBase = env['NEXT_PUBLIC_API_BASE_URL'];
  const shop    = env['NEXT_PUBLIC_SHOP'];
  const headers = buildHeaders(env);

  const checks = [
    { label: 'Dashboard endpoint',  url: `${apiBase}/dashboard/selection?shop=${encodeURIComponent(shop)}` },
    { label: 'Suggestions endpoint', url: `${apiBase}/metrics/store/suggestions-status?shop=${encodeURIComponent(shop)}` },
  ];

  console.log('\nRunning connectivity checks...\n');
  let allPassed = true;

  for (const { label, url } of checks) {
    try {
      const res = await fetch(url, { headers });
      const body = await res.json().catch(() => null);
      const success = body?.success ?? false;

      if (res.ok && success) {
        console.log(`  ✓  ${label}  →  HTTP ${res.status}  (success: true)`);
      } else if (res.status === 401) {
        console.error(`  ✗  ${label}  →  HTTP 401 — Auth header missing or token wrong`);
        allPassed = false;
      } else if (res.status === 404) {
        console.error(`  ✗  ${label}  →  HTTP 404 — Route not found or shop not in DB`);
        allPassed = false;
      } else {
        console.error(`  ✗  ${label}  →  HTTP ${res.status}  (success: ${success})`);
        allPassed = false;
      }
    } catch (err) {
      console.error(`  ✗  ${label}  →  ECONNREFUSED — API server not running at ${apiBase}`);
      console.error(`     Start it: cd api && node src/server.js`);
      allPassed = false;
    }
  }

  console.log('');
  if (allPassed) {
    console.log('✓  All checks passed. Frontend → API connection is healthy.\n');
    process.exit(0);
  } else {
    console.error('✗  One or more checks failed. See above.\n');
    process.exit(1);
  }
}

run();
