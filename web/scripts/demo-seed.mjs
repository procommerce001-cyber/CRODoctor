/**
 * demo-seed.mjs
 *
 * Prepares the demo store for a clean rehearsal run:
 *   1. Finds products with a `weak_desire_creation` issue that are not yet approved
 *   2. Approves the first one via POST /action-center/review
 *   3. Reports the ready state of the Ready to Apply list
 *
 * Run before every rehearsal:
 *
 *   node web/scripts/demo-seed.mjs
 *
 * Uses the same env vars as the frontend — reads from web/.env.local.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_ISSUE = 'weak_desire_creation';

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
  } catch {
    console.error('✗  web/.env.local not found. Copy web/.env.example → web/.env.local and fill in values.');
    process.exit(1);
  }
  const required = ['NEXT_PUBLIC_API_BASE_URL', 'NEXT_PUBLIC_SHOP'];
  for (const key of required) {
    if (!env[key]) { console.error(`✗  Missing required env var: ${key}`); process.exit(1); }
  }
  return env;
}

function headers(env, extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (env['NEXT_PUBLIC_DEV_BEARER_TOKEN']) h['Authorization'] = `Bearer ${env['NEXT_PUBLIC_DEV_BEARER_TOKEN']}`;
  return h;
}

async function run() {
  const env     = loadEnv();
  const apiBase = env['NEXT_PUBLIC_API_BASE_URL'];
  const shop    = env['NEXT_PUBLIC_SHOP'];

  console.log(`\nDemo seed — shop: ${shop}\n`);

  // ── 1. Fetch review summary ───────────────────────────────────────────────
  let summary;
  try {
    const res = await fetch(`${apiBase}/action-center/review-summary?shop=${encodeURIComponent(shop)}`, {
      headers: headers(env),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error(`✗  review-summary returned HTTP ${res.status}: ${body.error ?? 'unknown error'}`);
      process.exit(1);
    }
    summary = await res.json();
  } catch (err) {
    console.error(`✗  Could not reach API at ${apiBase}. Is the API server running?`);
    console.error(`   Start it: cd api && node src/server.js`);
    process.exit(1);
  }

  const { readyToApply = [], blocked = [] } = summary.groups ?? {};

  // ── 2. Check if already approved ─────────────────────────────────────────
  const alreadyReady = readyToApply.filter(i => i.issueId === TARGET_ISSUE);
  if (alreadyReady.length > 0) {
    console.log(`✓  ${alreadyReady.length} product(s) already have "${TARGET_ISSUE}" approved and ready to apply:`);
    for (const item of alreadyReady) {
      console.log(`   · productId: ${item.productId}`);
    }
    console.log('\n✓  Demo store is ready. No seed action needed.\n');
    process.exit(0);
  }

  // ── 3. Find unapproved candidates in the blocked group ───────────────────
  const candidates = blocked.filter(
    i => i.issueId === TARGET_ISSUE && i.reason && i.reason.includes('reviewStatus'),
  );

  if (candidates.length === 0) {
    // Fallback: any blocked item for this issueId
    const fallback = blocked.filter(i => i.issueId === TARGET_ISSUE);
    if (fallback.length === 0) {
      console.error(`✗  No products found with issueId "${TARGET_ISSUE}".`);
      console.error('   Ensure at least one product is synced with a short or missing description.');
      process.exit(1);
    }
    candidates.push(...fallback);
  }

  const target = candidates[0];
  console.log(`  Approving "${TARGET_ISSUE}" for productId: ${target.productId} ...`);

  // ── 4. Approve via POST /action-center/review ─────────────────────────────
  const reviewRes = await fetch(`${apiBase}/action-center/review`, {
    method:  'POST',
    headers: headers(env),
    body:    JSON.stringify({
      shop,
      productId:    target.productId,
      issueId:      TARGET_ISSUE,
      reviewStatus: 'approved',
    }),
  });

  if (!reviewRes.ok) {
    const body = await reviewRes.json().catch(() => ({}));
    console.error(`✗  Review endpoint returned HTTP ${reviewRes.status}: ${body.error ?? 'unknown error'}`);
    process.exit(1);
  }

  console.log(`✓  Approved "${TARGET_ISSUE}" for productId: ${target.productId}`);

  // ── 5. Confirm it now appears in readyToApply ─────────────────────────────
  const confirmRes = await fetch(`${apiBase}/action-center/review-summary?shop=${encodeURIComponent(shop)}`, {
    headers: headers(env),
  });
  const confirmData = await confirmRes.json().catch(() => ({}));
  const nowReady = (confirmData.groups?.readyToApply ?? []).filter(i => i.issueId === TARGET_ISSUE);

  if (nowReady.length > 0) {
    console.log(`\n✓  Ready to Apply list now contains ${nowReady.length} "${TARGET_ISSUE}" action(s).`);
    console.log('✓  Demo store is seeded and ready for rehearsal.\n');
  } else {
    console.warn(`\n⚠  Approved but item not yet in readyToApply — may need canAutoApply=true or a generatedFix.`);
    console.warn('   Check the product description has enough content for the CRO engine to generate a fix.\n');
  }
}

run();
