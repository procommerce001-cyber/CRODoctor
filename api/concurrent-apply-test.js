'use strict';
// concurrent-apply-test.js
// Forces a real concurrent duplicate-apply test by:
//  1. Setting a testable bodyHtml so weak_desire_creation fires with generatedFix content
//  2. Approving the issue
//  3. Firing 25 concurrent apply requests
//  4. Checking DB for duplicate rows
//  5. Restoring original product state

const http = require('http');
const { PrismaClient } = require('@prisma/client');

const TOKEN      = 'my-local-dev-secret-123';
const SHOP       = 'jw5kjx-1z.myshopify.com';
const PRODUCT_ID = 'cmnsyokn300011446pt4c7d8j';
const HEADERS    = { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

function req(method, path, body) {
  return new Promise(resolve => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 3000, path, method,
      headers: { ...HEADERS, ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
    };
    const r = http.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', e => resolve({ status: 0, body: e.message }));
    r.setTimeout(15000, () => { r.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (payload) r.write(payload);
    r.end();
  });
}

(async () => {
  const prisma = new PrismaClient();

  // ── 1. Save original bodyHtml ────────────────────────────────────────────
  const original = await prisma.product.findUnique({
    where: { id: PRODUCT_ID }, select: { bodyHtml: true },
  });

  // ── 1b. Assert no_description.proposedContent while bodyHtml is still blank ─
  // no_description only fires when the product has <50 chars of text content,
  // so we must check it before overwriting bodyHtml with testHtml below.
  const ndCheckRes  = await req('GET', `/action-center/products/${PRODUCT_ID}?shop=${SHOP}`);
  const ndCheckItem = (JSON.parse(ndCheckRes.body).actions || []).find(a => a.issueId === 'no_description');
  if (!ndCheckItem) {
    console.log('[ASSERT SKIP] no_description did not fire on this product (bodyHtml may already be valid)');
  } else if (ndCheckItem.proposedContent === null) {
    console.error('[ASSERT FAIL] no_description.proposedContent is null — generatedFix not wired in rules.js or toActionItem');
    process.exitCode = 1;
  } else {
    console.log('[ASSERT PASS] no_description.proposedContent:', ndCheckItem.proposedContent.slice(0, 70) + '...');
  }

  // ── 2. Set a bodyHtml that triggers weak_desire_creation ─────────────────
  // Must be 50+ chars and feature-heavy so weak_desire_creation fires.
  const testHtml = `<p>Here are the key features of the AURA PowerBank: 10,000mAh capacity, USB-C and USB-A outputs, LED battery indicator, fast-charge compatible, lightweight at 220g. Specifications: input 5V/2A, output 5V/3A, dimensions 145x70x15mm.</p>`;
  await prisma.product.update({ where: { id: PRODUCT_ID }, data: { bodyHtml: testHtml } });
  console.log('[setup] Set test bodyHtml to trigger weak_desire_creation');

  // ── 3. Discover the applicable issue ────────────────────────────────────
  const actionsRes = await req('GET', `/action-center/products/${PRODUCT_ID}?shop=${SHOP}`);
  const actions    = JSON.parse(actionsRes.body).actions || [];
  const applicable = actions.find(a => a.canAutoApply && a.proposedContent);

  if (!applicable) {
    console.log('[FAIL] No issue found with canAutoApply=true and generatedFix.bestGuess.content set.');
    console.log('Issues found:', actions.map(a => `${a.issueId} canAutoApply=${a.canAutoApply} fix=${!!a.generatedFix?.bestGuess?.content}`).join('\n  '));
    await prisma.product.update({ where: { id: PRODUCT_ID }, data: { bodyHtml: original.bodyHtml } });
    await prisma.$disconnect();
    return;
  }

  const ISSUE_ID = applicable.issueId;
  console.log(`[setup] Using issue: ${ISSUE_ID}`);
  console.log(`[setup] generatedFix preview: "${applicable.generatedFix.bestGuess.content.slice(0, 80)}..."`);

  // ── 4. Clean any prior ContentExecution for this pair ────────────────────
  const deleted = await prisma.contentExecution.deleteMany({
    where: { productId: PRODUCT_ID, issueId: ISSUE_ID },
  });
  console.log(`[setup] Cleared ${deleted.count} prior execution row(s)`);

  // ── 5. Approve the issue ─────────────────────────────────────────────────
  const approveRes = await req('POST', '/action-center/review', {
    shop: SHOP, productId: PRODUCT_ID, issueId: ISSUE_ID, reviewStatus: 'approved',
  });
  console.log('[setup] Approve status:', approveRes.status);

  // ── 6. Verify gate passes ─────────────────────────────────────────────────
  const gateRes  = await req('POST', `/action-center/products/${PRODUCT_ID}/apply-gate`, {
    shop: SHOP, issueId: ISSUE_ID,
  });
  const gateBody = JSON.parse(gateRes.body);
  console.log('[setup] Gate eligible:', gateBody.eligibleToApply, gateBody.blockReason || '');
  if (!gateBody.eligibleToApply) {
    console.log('[FAIL] Gate still blocked after approval. Cannot run apply test.');
    await prisma.product.update({ where: { id: PRODUCT_ID }, data: { bodyHtml: original.bodyHtml } });
    await prisma.$disconnect();
    return;
  }

  // ── 7. Fire 25 concurrent apply requests ────────────────────────────────
  console.log('\n[TEST] Firing 25 concurrent apply requests...');
  const applyResults = await Promise.all(
    Array.from({ length: 25 }, () =>
      req('POST', `/action-center/products/${PRODUCT_ID}/apply`, {
        shop: SHOP, issueId: ISSUE_ID,
      })
    )
  );

  const appliedCount = applyResults.filter(r => {
    try { return JSON.parse(r.body).applied === true; } catch { return false; }
  }).length;
  const skippedCount = applyResults.filter(r => {
    try { const b = JSON.parse(r.body); return b.skipped === true; } catch { return false; }
  }).length;
  const errCount = applyResults.filter(r => r.status >= 500 || r.status === 0).length;

  // ── 8. Check DB ───────────────────────────────────────────────────────────
  const execRows = await prisma.contentExecution.findMany({
    where: { productId: PRODUCT_ID, issueId: ISSUE_ID },
  });

  // ── 9. Report ─────────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('  Concurrent Apply Test Results');
  console.log('========================================');
  console.log('  Total requests  : 25');
  console.log('  applied=true    :', appliedCount,  '  ← expected 1');
  console.log('  skipped=true    :', skippedCount,  '  ← expected 24');
  console.log('  5xx / errors    :', errCount,      '  ← expected 0');
  console.log('  ContentExecution rows:', execRows.length, '  ← expected 1');

  const pass = appliedCount <= 1 && skippedCount + appliedCount === 25 && errCount === 0 && execRows.length === 1;
  console.log('\n  VERDICT:', pass ? 'PASS' : 'FAIL');
  if (!pass) {
    if (appliedCount > 1)  console.log('  FAIL: multiple rows applied');
    if (execRows.length > 1) console.log('  FAIL: duplicate ContentExecution rows in DB');
    if (errCount > 0)      console.log('  FAIL: server errors occurred');
    if (appliedCount + skippedCount < 25) {
      const unaccounted = 25 - appliedCount - skippedCount;
      const sample = applyResults.find(r => {
        try { const b = JSON.parse(r.body); return !b.applied && !b.skipped; } catch { return false; }
      });
      console.log('  NOTE:', unaccounted, 'requests gate-blocked. Sample:', sample?.body?.slice(0, 120));
    }
  }
  console.log('========================================\n');

  // ── 10. Restore original state ────────────────────────────────────────────
  await prisma.product.update({ where: { id: PRODUCT_ID }, data: { bodyHtml: original.bodyHtml } });
  await prisma.contentExecution.deleteMany({ where: { productId: PRODUCT_ID, issueId: ISSUE_ID } });
  await req('POST', '/action-center/review', {
    shop: SHOP, productId: PRODUCT_ID, issueId: ISSUE_ID, reviewStatus: 'pending',
  });
  console.log('[teardown] Restored product bodyHtml, cleared executions, reset review status');

  await prisma.$disconnect();
})();
