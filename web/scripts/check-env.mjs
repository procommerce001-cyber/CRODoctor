// Pre-dev sanity check — runs automatically before `npm run dev`.
// Catches the three failure modes that broke the dashboard:
//   1. Missing required env vars
//   2. API base URL pointing at the wrong port
//   3. API server not reachable before the frontend starts

import { readFileSync } from 'fs';
import { resolve } from 'path';

const REQUIRED_VARS = [
  'NEXT_PUBLIC_API_BASE_URL',
  'NEXT_PUBLIC_SHOP',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
];

// ── Load .env.local ───────────────────────────────────────────────
let env = {};
try {
  const raw = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
  for (const line of raw.split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) env[key.trim()] = rest.join('=').trim();
  }
} catch {
  console.error('\n✗  .env.local not found. Copy .env.example and fill in values.\n');
  process.exit(1);
}

// ── Check required vars are present ──────────────────────────────
let failed = false;
for (const key of REQUIRED_VARS) {
  if (!env[key]) {
    console.error(`✗  Missing required env var: ${key}`);
    failed = true;
  }
}
if (failed) { console.error(''); process.exit(1); }

// ── Warn if API base URL looks wrong ─────────────────────────────
const apiBase = env['NEXT_PUBLIC_API_BASE_URL'];
if (apiBase?.includes('localhost:3001')) {
  console.error(
    `\n✗  NEXT_PUBLIC_API_BASE_URL is set to ${apiBase}\n` +
    `   Port 3001 is the Next.js dev server, not the API.\n` +
    `   Set it to http://localhost:3000 in .env.local\n`
  );
  process.exit(1);
}

// ── Ping the API ──────────────────────────────────────────────────
try {
  const url = `${apiBase}/health`;
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) {
    console.warn(
      `\n⚠  API at ${apiBase} did not respond to GET /health.\n` +
      `   Make sure the API server is running (cd api && node src/server.js)\n` +
      `   Continuing anyway...\n`
    );
  } else {
    console.log(`✓  API reachable at ${apiBase}`);
  }
} catch {
  // Non-fatal — /health may not exist, let the app surface errors naturally
}

console.log(`✓  Env vars OK  (API → ${apiBase})`);
