'use strict';

// ---------------------------------------------------------------------------
// Orphan-write-edge hardening tests for the two-phase Apply path.
//
// Covers executeTwoPhaseWrite + reconcileApplyingExecution using injected
// fakes (fake prisma + stub Shopify write/read) — no live Shopify, no real DB.
//
// Includes the two review concerns:
//   - reconciliation decides applied/failed from the LIVE Shopify body, never
//     a stale local Product.bodyHtml mirror (and never falsely marks failed
//     when the live read is unavailable);
//   - an advisory-lock-guarded reserve so concurrent applies cannot both write.
//
// Run: node --test src/__tests__/orphan-apply-guard.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');

const {
  executeTwoPhaseWrite,
  reconcileApplyingExecution,
} = require('../services/action-center.service');

// ── fakes ──────────────────────────────────────────────────────────────────
function makePrisma(opts = {}) {
  const calls = { findFirst: [], create: [], update: [], productUpdate: [], queryRaw: [] };
  const prisma = {
    // Interactive transaction: run the callback with this same client as `tx`.
    $transaction: async (fn) => fn(prisma),
    // Advisory-lock probe: pg_try_advisory_xact_lock(...) → [{ locked }].
    $queryRaw: async (...args) => { calls.queryRaw.push(args); return [{ locked: opts.lockBusy ? false : true }]; },
    contentExecution: {
      findFirst: async (args) => {
        calls.findFirst.push(args);
        const status = args?.where?.status;
        if (status === 'applying')    return opts.inProgress   ?? null;
        if (status === 'applied')     return opts.appliedRow   ?? null;
        if (status === 'rolled_back') return opts.rolledBackRow ?? null;
        return null;
      },
      create: async (args) => {
        calls.create.push(args);
        if (opts.createError) throw opts.createError;
        return { id: args.data.id, ...args.data };
      },
      update: async (args) => {
        calls.update.push(args);
        if (opts.updateError && args.data.status === opts.updateError.onStatus) throw opts.updateError.err;
        return { id: args.where.id, ...args.data };
      },
    },
    product: {
      update: async (args) => {
        calls.productUpdate.push(args);
        if (opts.productUpdateError) throw opts.productUpdateError;
        return {};
      },
    },
  };
  return { prisma, calls };
}

function makeWriter(opts = {}) {
  const fn = async (_store, shopifyProductId, body) => {
    fn.calls.push({ shopifyProductId, body });
    if (opts.error) throw opts.error;
  };
  fn.calls = [];
  return fn;
}

// A stub live-Shopify-body reader. Returns `body`, or throws if `error` set.
function makeReader(body, opts = {}) {
  const fn = async () => { fn.calls++; if (opts.error) throw opts.error; return body; };
  fn.calls = 0;
  return fn;
}

const NOW = 1_000_000_000_000;

function baseArgs(writeShopify, extra = {}) {
  return {
    executionId:          'eid-1',
    store:                { id: 'store-1', shopDomain: 's.myshopify.com', accessToken: 'x' },
    rawProduct:           { id: 'prod-1', shopifyProductId: 'shp-1', bodyHtml: '' },
    issueId:              'no_trust_bullets',
    selectedVariantIndex: 0,
    patchMode:            'replace_full_body',
    anchorUsed:           null,
    previousContent:      '',
    proposedContent:      'Guarantee text',
    markedContent:        '<p>Guarantee text</p>',
    writeShopify,
    readShopifyBody:      makeReader(''),  // never the real network in tests
    now:                  NOW,
    ...extra,
  };
}

// ── A. reservation fails before Shopify write ───────────────────────────────
test('reservation failure prevents any Shopify write', async () => {
  const { prisma, calls } = makePrisma({ createError: new Error('db down') });
  const writer = makeWriter();
  const res = await executeTwoPhaseWrite(prisma, baseArgs(writer));
  assert.equal(writer.calls.length, 0, 'no Shopify write attempted');
  assert.equal(res.applied, false);
  assert.match(res.error, /reserve/i);
  assert.equal(calls.productUpdate.length, 0);
});

// ── B/C-fail. Shopify write fails → row marked failed, no product mirror ─────
test('Shopify write failure marks row failed and skips product mirror', async () => {
  const { prisma, calls } = makePrisma();
  const writer = makeWriter({ error: new Error('502 from Shopify') });
  const res = await executeTwoPhaseWrite(prisma, baseArgs(writer));
  assert.equal(writer.calls.length, 1, 'one Shopify write attempt');
  assert.equal(res.applied, false);
  assert.match(res.error, /Shopify write failed/);
  assert.equal(calls.create[0].data.status, 'applying', 'reserved as applying');
  assert.ok(calls.update.find(u => u.data.status === 'failed'), 'marked failed');
  assert.equal(calls.productUpdate.length, 0, 'no product mirror on failure');
});

// ── happy path. reserve(applying) → applied ─────────────────────────────────
test('successful write reserves applying then flips to applied', async () => {
  const { prisma, calls } = makePrisma();
  const writer = makeWriter();
  const res = await executeTwoPhaseWrite(prisma, baseArgs(writer));
  assert.equal(res.applied, true);
  assert.equal(writer.calls.length, 1);
  assert.equal(calls.create[0].data.status, 'applying');
  assert.ok(calls.create[0].data.afterReadyAt instanceof Date, 'afterReadyAt persisted at reserve');
  assert.ok(calls.update.find(u => u.data.status === 'applied'), 'flipped to applied');
  assert.equal(calls.productUpdate.length, 1, 'product mirror updated');
  assert.equal(res.previousContent, '');
  assert.equal(res.appliedContent, 'Guarantee text');
});

// ── E/C-orphan. write OK but finalize fails → recoverable applying row ───────
test('write succeeds but finalize fails leaves a recoverable applying row', async () => {
  const { prisma, calls } = makePrisma({ updateError: { onStatus: 'applied', err: new Error('db blip') } });
  const writer = makeWriter();
  const res = await executeTwoPhaseWrite(prisma, baseArgs(writer));
  assert.equal(writer.calls.length, 1, 'exactly one Shopify write (no duplicate)');
  assert.equal(res.applied, false);
  assert.equal(res.pendingReconcile, true);
  assert.equal(res.executionId, 'eid-1');
  const reserved = calls.create[0].data;
  assert.equal(reserved.status, 'applying');
  assert.equal(reserved.previousContent, '', 'previousContent preserved for recovery');
  assert.equal(reserved.resultContent, '<p>Guarantee text</p>', 'resultContent preserved for recovery');
});

// ── F. retry while a recent applying row exists → no second write ───────────
test('a recent applying row short-circuits without a second write', async () => {
  const recent = { id: 'eid-0', status: 'applying', createdAt: new Date(NOW) };
  const { prisma, calls } = makePrisma({ inProgress: recent });
  const writer = makeWriter();
  const res = await executeTwoPhaseWrite(prisma, baseArgs(writer));
  assert.equal(writer.calls.length, 0, 'no second Shopify write');
  assert.equal(res.skipped, true);
  assert.match(res.reason, /in progress/);
  assert.equal(calls.create.length, 0, 'no new reservation');
});

// ── Concern 1. stale applying row + STALE LOCAL MIRROR but LIVE body applied ─
// The orphan case: local Product.bodyHtml still holds previousContent while
// Shopify already has resultContent. Reconciliation must read the LIVE body and
// promote to applied — NOT mark failed from the stale local mirror.
test('stale applying reconciles from LIVE body (not stale local mirror) → applied, no re-write', async () => {
  const stale = {
    id: 'eid-0', status: 'applying',
    resultContent: '<p>Guarantee text</p>', previousContent: '',
    createdAt: new Date(NOW - 3 * 60 * 1000), afterReadyAt: new Date(1),
  };
  const { prisma, calls } = makePrisma({ inProgress: stale });
  const writer = makeWriter();
  // Local mirror is empty/stale; the LIVE read returns the applied resultContent.
  const liveReader = makeReader('<p>Guarantee text</p>');
  const args = baseArgs(writer, {
    rawProduct:      { id: 'prod-1', shopifyProductId: 'shp-1', bodyHtml: '' /* stale local */ },
    readShopifyBody: liveReader,
  });
  const res = await executeTwoPhaseWrite(prisma, args);
  assert.ok(liveReader.calls > 0, 'live Shopify body was read');
  assert.equal(writer.calls.length, 0, 'no second Shopify write');
  assert.equal(res.skipped, true);
  assert.match(res.reason, /already applied/);
  assert.ok(calls.update.find(u => u.data.status === 'applied'), 'stale row promoted to applied');
  assert.equal(calls.create.length, 0, 'no fresh reservation');
});

// ── Concern 1. live read unavailable → needsAttention, never a false failed ──
test('stale applying with a failed LIVE read returns needsAttention, never failed', async () => {
  const stale = {
    id: 'eid-0', status: 'applying',
    resultContent: '<p>Guarantee text</p>', previousContent: '',
    createdAt: new Date(NOW - 3 * 60 * 1000),
  };
  const { prisma, calls } = makePrisma({ inProgress: stale });
  const writer = makeWriter();
  const failingReader = makeReader(null, { error: new Error('Shopify 503') });
  const res = await executeTwoPhaseWrite(prisma, baseArgs(writer, { readShopifyBody: failingReader }));
  assert.equal(writer.calls.length, 0, 'no Shopify write');
  assert.equal(res.applied, false);
  assert.match(res.blockReason, /unknown state|review/i);
  assert.ok(!calls.update.find(u => u.data.status === 'failed'), 'never falsely marked failed');
});

// ── Concern 2. advisory lock busy → in-progress, no Shopify write ────────────
test('advisory lock held by a concurrent apply yields in-progress and no write', async () => {
  const { prisma, calls } = makePrisma({ lockBusy: true });
  const writer = makeWriter();
  const res = await executeTwoPhaseWrite(prisma, baseArgs(writer));
  assert.equal(writer.calls.length, 0, 'no Shopify write while lock is held');
  assert.equal(res.skipped, true);
  assert.match(res.reason, /in progress/);
  assert.equal(calls.create.length, 0, 'no reservation created');
});

// ── Concern 2. recheck inside the lock finds a racing applying row → bail ────
test('concurrent racing applying row seen inside the lock yields in-progress, no write', async () => {
  // No stale pre-check row (inProgress only returned for the in-lock recheck via appliedRow=null);
  // simulate a sibling that reserved between our pre-check and our lock acquisition.
  const racing = { id: 'eid-9', status: 'applying', createdAt: new Date(NOW) };
  const { prisma, calls } = makePrisma();
  // Make findFirst return the racing row ONLY for the in-lock applying check by
  // toggling after the first (outside-lock) applying findFirst returns null.
  let applyingSeen = 0;
  prisma.contentExecution.findFirst = async (args) => {
    const status = args?.where?.status;
    if (status === 'applying') { applyingSeen += 1; return applyingSeen === 1 ? null : racing; }
    return null;
  };
  const writer = makeWriter();
  const res = await executeTwoPhaseWrite(prisma, baseArgs(writer));
  assert.equal(writer.calls.length, 0, 'no Shopify write when a sibling is reserving');
  assert.equal(res.skipped, true);
  assert.match(res.reason, /in progress/);
  assert.equal(calls.create.length, 0);
});

// ── G. concurrent flip P2002 backstop → skip, one write only ────────────────
test('concurrent flip P2002 yields skip and only one Shopify write', async () => {
  const p2002 = Object.assign(new Error('unique'), { code: 'P2002' });
  const { prisma, calls } = makePrisma({ updateError: { onStatus: 'applied', err: p2002 } });
  const writer = makeWriter();
  const res = await executeTwoPhaseWrite(prisma, baseArgs(writer));
  assert.equal(writer.calls.length, 1, 'one Shopify write');
  assert.equal(res.skipped, true);
  assert.match(res.reason, /already applied/);
  assert.ok(calls.update.find(u => u.data.status === 'failed'), 'losing attempt marked failed');
});

// ── reconciliation matrix (direct, live-body injected) ──────────────────────
test('reconcile: LIVE body equals resultContent promotes applying → applied', async () => {
  const { prisma, calls } = makePrisma();
  const execution = {
    id: 'eid-9', status: 'applying',
    resultContent: '<p>X</p>', previousContent: '<p>orig</p>',
    createdAt: new Date(0), afterReadyAt: new Date(123),
  };
  const r = await reconcileApplyingExecution(prisma, {
    execution, store: {}, shopifyProductId: 'shp-1', readShopifyBody: makeReader('<p>X</p>'),
  });
  assert.equal(r.status, 'applied');
  assert.equal(r.reconciled, true);
  assert.equal(calls.update[0].data.status, 'applied');
});

test('reconcile: LIVE body equals previousContent marks applying → failed', async () => {
  const { prisma, calls } = makePrisma();
  const execution = {
    id: 'eid-9', status: 'applying',
    resultContent: '<p>X</p>', previousContent: '<p>orig</p>', createdAt: new Date(0),
  };
  const r = await reconcileApplyingExecution(prisma, {
    execution, store: {}, shopifyProductId: 'shp-1', readShopifyBody: makeReader('<p>orig</p>'),
  });
  assert.equal(r.status, 'failed');
  assert.equal(calls.update[0].data.status, 'failed');
});

test('reconcile: LIVE body matching neither is flagged, no overwrite', async () => {
  const { prisma, calls } = makePrisma();
  const execution = {
    id: 'eid-9', status: 'applying',
    resultContent: '<p>X</p>', previousContent: '<p>orig</p>', createdAt: new Date(0),
  };
  const r = await reconcileApplyingExecution(prisma, {
    execution, store: {}, shopifyProductId: 'shp-1', readShopifyBody: makeReader('<p>a human edited this</p>'),
  });
  assert.equal(r.needsAttention, true);
  assert.equal(r.status, 'applying');
  assert.equal(calls.update.length, 0, 'never overwrites an unknown state');
});

test('reconcile: non-applying row is a no-op (no live read)', async () => {
  const { prisma, calls } = makePrisma();
  const reader = makeReader('anything');
  const r = await reconcileApplyingExecution(prisma, {
    execution: { id: 'eid-9', status: 'applied' }, store: {}, shopifyProductId: 'shp-1', readShopifyBody: reader,
  });
  assert.equal(r.reconciled, false);
  assert.equal(calls.update.length, 0);
  assert.equal(reader.calls, 0, 'no live read for a non-applying row');
});
