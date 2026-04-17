'use strict';

// ---------------------------------------------------------------------------
// seed-revenue-test.js
//
// Inserts realistic before/after execution data so the Revenue Dashboard
// renders real numbers end-to-end without waiting 7 days.
//
// Usage:
//   node api/prisma/seed-revenue-test.js --shop=yourdomain.myshopify.com
//
// What it creates (per scenario):
//   1. ContentExecution   (status: 'applied')
//   2. ProductMetricsSnapshot phase='before'  linked via baselineExecutionId
//   3. ProductMetricsSnapshot phase='after'   linked via baselineExecutionId
//
// The Revenue Dashboard picks up data when BOTH before+after snapshots exist
// for an execution. This seed satisfies that requirement immediately.
//
// Safe to re-run — snapshots use upsert. Each run creates new executions
// (by design, so you can accumulate more test data across runs).
//
// Clean up test data:
//   node api/prisma/seed-revenue-test.js --shop=<shop> --clean
// ---------------------------------------------------------------------------

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// ── CLI args ─────────────────────────────────────────────────────────────────
const args  = process.argv.slice(2);
const shopArg  = args.find(a => a.startsWith('--shop='));
const SHOP     = shopArg ? shopArg.split('=')[1] : process.env.SEED_SHOP;
const CLEAN    = args.includes('--clean');

if (!SHOP) {
  console.error('\nUsage:');
  console.error('  node api/prisma/seed-revenue-test.js --shop=yourdomain.myshopify.com');
  console.error('  node api/prisma/seed-revenue-test.js --shop=yourdomain.myshopify.com --clean\n');
  process.exit(1);
}

// ── Scenarios ─────────────────────────────────────────────────────────────────
// Three realistic CRO fixes with believable revenue lift.
// before→after reflects a 7-day comparison window.
const SCENARIOS = [
  {
    issueId:       'no_description',
    label:         'Missing product description',
    productSuffix: 'Running Shoes Pro',
    before: { revenue: 1200, orderCount: 8,  unitsSold: 10 },
    after:  { revenue: 1584, orderCount: 11, unitsSold: 13 },   // +32% revenue
  },
  {
    issueId:       'no_risk_reversal',
    label:         'No trust / returns guarantee',
    productSuffix: 'Yoga Mat Elite',
    before: { revenue: 480,  orderCount: 4,  unitsSold: 5  },
    after:  { revenue: 638,  orderCount: 6,  unitsSold: 7  },   // +33% revenue
  },
  {
    issueId:       'description_too_short',
    label:         'Description too short',
    productSuffix: 'Protein Powder Vanilla',
    before: { revenue: 2100, orderCount: 15, unitsSold: 20 },
    after:  { revenue: 2520, orderCount: 18, unitsSold: 24 },   // +20% revenue
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function daysAgo(n) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function pct(before, after) {
  return (((after - before) / before) * 100).toFixed(1);
}

// ── Clean mode ────────────────────────────────────────────────────────────────
async function clean(store) {
  console.log('\n🧹 Cleaning seed data...\n');

  // Find test products
  const testProducts = await prisma.product.findMany({
    where:  { storeId: store.id, shopifyProductId: { startsWith: 'SEED_TEST_' } },
    select: { id: true, title: true },
  });

  for (const p of testProducts) {
    await prisma.productMetricsSnapshot.deleteMany({ where: { productId: p.id } });
    await prisma.contentExecution.deleteMany({ where: { productId: p.id, storeId: store.id } });
    await prisma.product.delete({ where: { id: p.id } });
    console.log(`  ✓ Removed test product and all linked data: ${p.title}`);
  }

  // Remove seed executions on real products (identified by newContent prefix)
  const seedExecs = await prisma.contentExecution.findMany({
    where:  { storeId: store.id, newContent: { startsWith: '[seed]' } },
    select: { id: true, productId: true, issueId: true },
  });

  for (const e of seedExecs) {
    await prisma.productMetricsSnapshot.deleteMany({ where: { baselineExecutionId: e.id } });
    await prisma.contentExecution.delete({ where: { id: e.id } });
    console.log(`  ✓ Removed seed execution and snapshots: ${e.id}`);
  }

  console.log('\n✅ Clean complete.\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🌱  CRODoctor — Revenue Test Seed');
  console.log(`    Shop : ${SHOP}`);
  console.log(`    Mode : ${CLEAN ? 'CLEAN' : 'SEED'}\n`);

  // 1. Resolve store
  const store = await prisma.store.findUnique({ where: { shopDomain: SHOP } });
  if (!store) {
    console.error(`✗  Store not found: ${SHOP}`);
    console.error('   Connect the store first (POST /connect-shopify or OAuth flow).');
    process.exit(1);
  }
  console.log(`✓  Store: ${store.name}  (id: ${store.id})`);

  if (CLEAN) {
    await clean(store);
    return;
  }

  // 2. Resolve products — prefer existing active products, stub missing ones
  const existing = await prisma.product.findMany({
    where:   { storeId: store.id, status: 'active' },
    orderBy: { createdAt: 'desc' },
    take:    3,
    select:  { id: true, title: true },
  });
  console.log(`✓  Found ${existing.length} existing active product(s)\n`);

  const products = [...existing];

  for (let i = products.length; i < SCENARIOS.length; i++) {
    const stub = await prisma.product.upsert({
      where:  {
        storeId_shopifyProductId: {
          storeId:          store.id,
          shopifyProductId: `SEED_TEST_${i + 1}`,
        },
      },
      update: { title: `[Test] ${SCENARIOS[i].productSuffix}`, status: 'active', updatedAt: new Date() },
      create: {
        storeId:          store.id,
        shopifyProductId: `SEED_TEST_${i + 1}`,
        title:            `[Test] ${SCENARIOS[i].productSuffix}`,
        handle:           `seed-test-product-${i + 1}`,
        status:           'active',
        createdAt:        new Date(),
        updatedAt:        new Date(),
      },
    });
    products.push(stub);
    console.log(`  ↳ Created test product stub: ${stub.title}`);
  }

  // 3. Snapshot dates
  //   before = 8 days ago (start of the measurement window)
  //   after  = 1 day ago  (end of the window, avoids today's live snapshot conflicts)
  const dateBefore  = daysAgo(8);
  const dateAfter   = daysAgo(1);
  const execCreated = daysAgo(1);   // execution happened at the boundary

  console.log(`\n   Window: ${dateBefore.toDateString()} → ${dateAfter.toDateString()}\n`);
  console.log('━'.repeat(60));

  const results = [];

  for (let i = 0; i < SCENARIOS.length; i++) {
    const sc      = SCENARIOS[i];
    const product = products[i];

    console.log(`\n  [${i + 1}/${SCENARIOS.length}] ${product.title}`);
    console.log(`       Issue    : ${sc.issueId}`);

    // 4. ContentExecution — status: 'applied'
    const execution = await prisma.contentExecution.create({
      data: {
        storeId:     store.id,
        productId:   product.id,
        issueId:     sc.issueId,
        newContent:  `[seed] ${sc.label} — optimized copy applied`,
        status:      'applied',
        createdAt:   execCreated,
        afterReadyAt: new Date(execCreated.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    console.log(`       Execution: ${execution.id}`);

    // 5. BEFORE snapshot
    await prisma.productMetricsSnapshot.upsert({
      where:  {
        productId_snapshotDate_phase: {
          productId:    product.id,
          snapshotDate: dateBefore,
          phase:        'before',
        },
      },
      update: {
        orderCount:          sc.before.orderCount,
        unitsSold:           sc.before.unitsSold,
        revenue:             sc.before.revenue,
        baselineExecutionId: execution.id,
        windowStart:         dateBefore,
        windowEnd:           dateAfter,
      },
      create: {
        productId:           product.id,
        snapshotDate:        dateBefore,
        phase:               'before',
        orderCount:          sc.before.orderCount,
        unitsSold:           sc.before.unitsSold,
        revenue:             sc.before.revenue,
        baselineExecutionId: execution.id,
        windowStart:         dateBefore,
        windowEnd:           dateAfter,
      },
    });

    // 6. AFTER snapshot
    await prisma.productMetricsSnapshot.upsert({
      where:  {
        productId_snapshotDate_phase: {
          productId:    product.id,
          snapshotDate: dateAfter,
          phase:        'after',
        },
      },
      update: {
        orderCount:          sc.after.orderCount,
        unitsSold:           sc.after.unitsSold,
        revenue:             sc.after.revenue,
        baselineExecutionId: execution.id,
        windowStart:         dateBefore,
        windowEnd:           dateAfter,
      },
      create: {
        productId:           product.id,
        snapshotDate:        dateAfter,
        phase:               'after',
        orderCount:          sc.after.orderCount,
        unitsSold:           sc.after.unitsSold,
        revenue:             sc.after.revenue,
        baselineExecutionId: execution.id,
        windowStart:         dateBefore,
        windowEnd:           dateAfter,
      },
    });

    const revDelta = sc.after.revenue  - sc.before.revenue;
    const ordDelta = sc.after.orderCount - sc.before.orderCount;
    const revPct   = pct(sc.before.revenue, sc.after.revenue);

    console.log(`       Before   : $${sc.before.revenue}  /  ${sc.before.orderCount} orders`);
    console.log(`       After    : $${sc.after.revenue}   /  ${sc.after.orderCount} orders`);
    console.log(`       Delta    : +$${revDelta}  (+${revPct}%)  /  +${ordDelta} orders`);

    results.push({ title: product.title, revDelta, ordDelta, revPct, executionId: execution.id });
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const totalRevenue = results.reduce((s, r) => s + r.revDelta, 0);
  const avgRevPct    = (results.reduce((s, r) => s + parseFloat(r.revPct), 0) / results.length).toFixed(1);

  console.log('\n' + '━'.repeat(60));
  console.log('\n✅  Seed complete\n');
  console.log('Expected Revenue Dashboard values:');
  console.log(`  totalRevenueImpact   →  $${totalRevenue}`);
  console.log(`  revenueGrowthPercent →  +${avgRevPct}%`);
  console.log(`  productsImproved     →  ${results.length}`);
  console.log(`  executionsCount      →  ${results.length}`);
  console.log('\nrecentImpacts:');
  results.forEach(r => {
    const title = r.title.length > 30 ? r.title.slice(0, 28) + '…' : r.title;
    console.log(`  • ${title.padEnd(30)}  +$${String(r.revDelta).padStart(4)}  (+${r.revPct}%)`);
  });

  console.log('\nVerify now:');
  console.log(`  curl -s -H "Authorization: Bearer $API_SECRET" \\`);
  console.log(`    "$API_BASE/metrics/revenue-dashboard?shop=${SHOP}" | jq .`);
  console.log('\nClean up when done:');
  console.log(`  node api/prisma/seed-revenue-test.js --shop=${SHOP} --clean\n`);
}

main()
  .catch(err => {
    console.error('\n✗  Seed failed:', err.message);
    if (err.code === 'P2002') {
      console.error('   Unique constraint — a snapshot for this (productId, date, phase) already exists.');
      console.error('   Run with --clean first, or wait until tomorrow for new snapshot dates.');
    }
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
