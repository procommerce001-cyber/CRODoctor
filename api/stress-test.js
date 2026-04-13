'use strict';
// stress-test.js
// Focused load test for CRODoctor action-center endpoints.
// Run with: node stress-test.js
// Requires the server to be running on localhost:3000.

const http  = require('http');
const https = require('https');
const { PrismaClient } = require('@prisma/client');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BASE_URL   = 'http://localhost:3000';
const TOKEN      = 'my-local-dev-secret-123';
const SHOP       = 'jw5kjx-1z.myshopify.com';
const PRODUCT_ID = 'cmnsyokn300011446pt4c7d8j';
const ISSUE_ID   = 'no_description';

const HEADERS = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type':  'application/json',
};

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function request(method, path, body) {
  return new Promise((resolve) => {
    const start   = Date.now();
    const payload = body ? JSON.stringify(body) : null;
    const mod     = path.startsWith('https') ? https : http;

    const url = new URL(path.startsWith('http') ? path : BASE_URL + path);
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers:  {
        ...HEADERS,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = (url.protocol === 'https:' ? https : http).request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        resolve({ status: res.statusCode, ms: Date.now() - start, body: data });
      });
    });

    req.on('error', (err) => {
      resolve({ status: 0, ms: Date.now() - start, error: err.message });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ status: 0, ms: Date.now() - start, error: 'timeout' });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Run N requests at concurrency C, return stats
// ---------------------------------------------------------------------------
async function runStage(label, total, concurrency, buildReq) {
  const results  = [];
  let   inflight = 0;
  let   launched = 0;

  await new Promise((resolve) => {
    function launch() {
      while (inflight < concurrency && launched < total) {
        inflight++;
        launched++;
        const { method, path, body } = buildReq(launched);
        request(method, path, body).then((r) => {
          results.push(r);
          inflight--;
          if (results.length === total) return resolve();
          launch();
        });
      }
    }
    launch();
  });

  const ok      = results.filter(r => r.status >= 200 && r.status < 300).length;
  const fail    = results.filter(r => r.status === 0 || r.status >= 500).length;
  const client4 = results.filter(r => r.status >= 400 && r.status < 500).length;
  const times   = results.map(r => r.ms).sort((a, b) => a - b);
  const avg     = Math.round(times.reduce((s, t) => s + t, 0) / times.length);
  const p95     = times[Math.floor(times.length * 0.95)];
  const max     = times[times.length - 1];

  const errTypes = {};
  results.filter(r => r.status === 0).forEach(r => {
    errTypes[r.error] = (errTypes[r.error] || 0) + 1;
  });

  console.log(`\n--- ${label} ---`);
  console.log(`  Total      : ${total}  (concurrency ${concurrency})`);
  console.log(`  2xx OK     : ${ok}`);
  console.log(`  4xx client : ${client4}`);
  console.log(`  5xx/err    : ${fail}`);
  console.log(`  Avg ms     : ${avg}`);
  console.log(`  p95 ms     : ${p95}`);
  console.log(`  Max ms     : ${max}`);
  if (Object.keys(errTypes).length) {
    console.log(`  Errors     :`, errTypes);
  }

  return { ok, fail, client4, avg, p95, max };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const prisma = new PrismaClient();

  console.log('\n========================================');
  console.log('  CRODoctor Stress Test');
  console.log('  BASE_URL   :', BASE_URL);
  console.log('  SHOP       :', SHOP);
  console.log('  PRODUCT_ID :', PRODUCT_ID);
  console.log('  ISSUE_ID   :', ISSUE_ID);
  console.log('========================================\n');

  // ── Pre-flight: ensure issue is NOT approved yet (clean state) ──────────
  await request('POST', '/action-center/review', {
    shop: SHOP, productId: PRODUCT_ID, issueId: ISSUE_ID, reviewStatus: 'pending',
  });
  // Clean any prior ContentExecution for this pair so apply is fresh
  await prisma.contentExecution.deleteMany({
    where: { productId: PRODUCT_ID, issueId: ISSUE_ID },
  });
  console.log('[setup] Cleared prior executions for', PRODUCT_ID, ISSUE_ID);

  // ── STAGE A: Light load — health + queue ────────────────────────────────
  console.log('\n[STAGE A] Light load — 20 req, concurrency 5');
  let i = 0;
  await runStage('Stage A · /health', 10, 5, () =>
    ({ method: 'GET', path: '/health' }));
  await runStage('Stage A · /action-center/queue', 10, 5, () =>
    ({ method: 'GET', path: `/action-center/queue?shop=${SHOP}` }));

  // ── STAGE B: Medium load — preview + apply-gate ─────────────────────────
  console.log('\n[STAGE B] Medium load — 100 req, concurrency 10');
  await runStage('Stage B · /products/:id/preview', 50, 10, () =>
    ({ method: 'GET', path: `/action-center/products/${PRODUCT_ID}/preview?shop=${SHOP}` }));
  await runStage('Stage B · /products/:id/apply-gate', 50, 10, () =>
    ({ method: 'POST', path: `/action-center/products/${PRODUCT_ID}/apply-gate`,
       body: { shop: SHOP, issueId: ISSUE_ID } }));

  // ── STAGE C: Heavy load — mixed read endpoints ───────────────────────────
  console.log('\n[STAGE C] Heavy load — 300 req, concurrency 25');
  const endpoints = [
    () => ({ method: 'GET',  path: '/health' }),
    () => ({ method: 'GET',  path: `/action-center/queue?shop=${SHOP}` }),
    () => ({ method: 'GET',  path: `/action-center/products/${PRODUCT_ID}/preview?shop=${SHOP}` }),
    () => ({ method: 'POST', path: `/action-center/products/${PRODUCT_ID}/apply-gate`,
             body: { shop: SHOP, issueId: ISSUE_ID } }),
  ];
  await runStage('Stage C · mixed', 300, 25, (n) => endpoints[n % endpoints.length]());

  // ── CONCURRENT DUPLICATE-APPLY TEST ─────────────────────────────────────
  console.log('\n[APPLY TEST] Concurrent duplicate-apply (25 simultaneous requests)');
  console.log('  Step 1: approve the action...');
  const approveRes = await request('POST', '/action-center/review', {
    shop: SHOP, productId: PRODUCT_ID, issueId: ISSUE_ID, reviewStatus: 'approved',
  });
  console.log('  Approve status:', approveRes.status);

  console.log('  Step 2: fire 25 concurrent apply requests...');
  const applyPromises = Array.from({ length: 25 }, () =>
    request('POST', `/action-center/products/${PRODUCT_ID}/apply`, {
      shop: SHOP, issueId: ISSUE_ID,
    })
  );
  const applyResults = await Promise.all(applyPromises);

  const appliedCount  = applyResults.filter(r => {
    try { return JSON.parse(r.body).applied === true; } catch { return false; }
  }).length;
  const skippedCount  = applyResults.filter(r => {
    try { const b = JSON.parse(r.body); return b.skipped === true; } catch { return false; }
  }).length;
  const gatedCount    = applyResults.filter(r => {
    try { const b = JSON.parse(r.body); return b.applied === false && !b.skipped; } catch { return false; }
  }).length;
  const errCount      = applyResults.filter(r => r.status >= 500 || r.status === 0).length;

  console.log('\n--- Duplicate-Apply Concurrency Results ---');
  console.log('  Total fired   :', 25);
  console.log('  applied=true  :', appliedCount,  ' ← should be 0 or 1');
  console.log('  skipped=true  :', skippedCount,  ' ← should be 24 or 25');
  console.log('  gate-blocked  :', gatedCount);
  console.log('  5xx/errors    :', errCount);

  // Check DB for duplicate rows
  const execRows = await prisma.contentExecution.findMany({
    where:  { productId: PRODUCT_ID, issueId: ISSUE_ID },
    select: { id: true, status: true, createdAt: true },
  });
  console.log('\n--- DB Integrity ---');
  console.log('  ContentExecution rows for this pair:', execRows.length, '← must be ≤ 1');
  execRows.forEach((r, i) => console.log(`    [${i}] id=${r.id}  status=${r.status}`));

  const dbDuplicates = execRows.length > 1;

  // ── Post-test health check ───────────────────────────────────────────────
  const healthFinal = await request('GET', '/health');
  console.log('\n--- Post-test health ---');
  console.log('  /health status:', healthFinal.status, healthFinal.status === 200 ? 'OK' : 'FAIL');

  // ── Final verdict ────────────────────────────────────────────────────────
  console.log('\n========================================');
  const applyOk  = appliedCount <= 1 && (skippedCount + appliedCount) === 25;
  const dbOk     = !dbDuplicates;
  const serverOk = healthFinal.status === 200;

  if (applyOk && dbOk && serverOk) {
    console.log('  FINAL VERDICT: PASS');
  } else if (serverOk && (applyOk || dbOk)) {
    console.log('  FINAL VERDICT: PASS WITH WARNINGS');
  } else {
    console.log('  FINAL VERDICT: FAIL');
  }

  if (!applyOk)  console.log('  WARNING: apply count unexpected (applied=' + appliedCount + ' skipped=' + skippedCount + ')');
  if (!dbOk)     console.log('  FAIL: DB has ' + execRows.length + ' duplicate ContentExecution rows');
  if (!serverOk) console.log('  FAIL: server not healthy after test');
  console.log('========================================\n');

  await prisma.$disconnect();
})();
