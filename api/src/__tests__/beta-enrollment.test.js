'use strict';

// ---------------------------------------------------------------------------
// Controlled Beta diagnostics enrollment gate (PR B) — pure helper tests +
// a structural assertion that the route gates before any DB work.
// No DB / Shopify / Anthropic / network.
//
// Run: node --test src/__tests__/beta-enrollment.test.js
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert   = require('node:assert');
const fs       = require('node:fs');
const path     = require('node:path');

const enroll = require('../services/beta-enrollment.service');

const SHOP = 'example.myshopify.com';
const envWith = (over = {}) => ({
  PRODUCT_OPPORTUNITY_DIAGNOSTICS: 'true',
  DIAGNOSTICS_STORE_ALLOWLIST: SHOP,
  ...over,
});

// ── normalizeShopDomain ──────────────────────────────────────────────────────

test('normalizeShopDomain: plain domain unchanged', () => {
  assert.strictEqual(enroll.normalizeShopDomain('example.myshopify.com'), SHOP);
});
test('normalizeShopDomain strips https:// and http://', () => {
  assert.strictEqual(enroll.normalizeShopDomain('https://example.myshopify.com'), SHOP);
  assert.strictEqual(enroll.normalizeShopDomain('http://example.myshopify.com'), SHOP);
});
test('normalizeShopDomain strips trailing slash', () => {
  assert.strictEqual(enroll.normalizeShopDomain('https://example.myshopify.com/'), SHOP);
});
test('normalizeShopDomain strips path/query/hash', () => {
  assert.strictEqual(enroll.normalizeShopDomain('https://example.myshopify.com/admin/products'), SHOP);
  assert.strictEqual(enroll.normalizeShopDomain('example.myshopify.com/admin?x=1#f'), SHOP);
});
test('normalizeShopDomain trims spaces and lowercases', () => {
  assert.strictEqual(enroll.normalizeShopDomain('  EXAMPLE.MyShopify.com  '), SHOP);
});
test('normalizeShopDomain rejects empty/null/undefined/non-string', () => {
  for (const v of ['', '   ', null, undefined, 42, {}, []]) {
    assert.strictEqual(enroll.normalizeShopDomain(v), null, `value ${JSON.stringify(v)}`);
  }
});
test('normalizeShopDomain rejects custom + malformed domains', () => {
  for (const v of ['example.com', 'not-a-shop', 'myshopify.com', '.myshopify.com', 'a b.myshopify.com', 'example.myshopify.com.evil.com']) {
    assert.strictEqual(enroll.normalizeShopDomain(v), null, `value ${JSON.stringify(v)}`);
  }
});
test('normalizeShopDomain never throws on bad input', () => {
  assert.doesNotThrow(() => enroll.normalizeShopDomain(Symbol('x') && undefined));
});

// ── parseStoreAllowlist ──────────────────────────────────────────────────────

test('parseStoreAllowlist parses + normalizes comma-separated domains', () => {
  const out = enroll.parseStoreAllowlist('https://A.myshopify.com/, b.myshopify.com');
  assert.deepStrictEqual(out.sort(), ['a.myshopify.com', 'b.myshopify.com']);
});
test('parseStoreAllowlist ignores empty and invalid entries', () => {
  const out = enroll.parseStoreAllowlist('a.myshopify.com,,  ,example.com,not-a-shop');
  assert.deepStrictEqual(out, ['a.myshopify.com']);
});
test('parseStoreAllowlist de-duplicates', () => {
  const out = enroll.parseStoreAllowlist('a.myshopify.com, https://a.myshopify.com/, A.MYSHOPIFY.COM');
  assert.deepStrictEqual(out, ['a.myshopify.com']);
});
test('parseStoreAllowlist fail-closed on missing/empty/non-string', () => {
  for (const v of [undefined, null, '', '   ', 5]) {
    assert.deepStrictEqual(enroll.parseStoreAllowlist(v), [], `value ${JSON.stringify(v)}`);
  }
});

// ── isDiagnosticsGloballyEnabled ─────────────────────────────────────────────

test('isDiagnosticsGloballyEnabled requires explicit truthy flag', () => {
  for (const v of ['true', '1', 'yes', 'on']) {
    assert.strictEqual(enroll.isDiagnosticsGloballyEnabled({ PRODUCT_OPPORTUNITY_DIAGNOSTICS: v }), true, v);
  }
  for (const v of [undefined, '', 'false', '0', 'no', 'off', 'TRUE?']) {
    assert.strictEqual(enroll.isDiagnosticsGloballyEnabled({ PRODUCT_OPPORTUNITY_DIAGNOSTICS: v }), false, JSON.stringify(v));
  }
});

// ── canRunBetaDiagnostics ────────────────────────────────────────────────────

test('canRunBetaDiagnostics false when global flag off', () => {
  assert.strictEqual(enroll.canRunBetaDiagnostics(SHOP, envWith({ PRODUCT_OPPORTUNITY_DIAGNOSTICS: 'false' })), false);
});
test('canRunBetaDiagnostics false when allowlist missing or empty', () => {
  assert.strictEqual(enroll.canRunBetaDiagnostics(SHOP, envWith({ DIAGNOSTICS_STORE_ALLOWLIST: undefined })), false);
  assert.strictEqual(enroll.canRunBetaDiagnostics(SHOP, envWith({ DIAGNOSTICS_STORE_ALLOWLIST: '   ' })), false);
});
test('canRunBetaDiagnostics false when shop missing/malformed', () => {
  assert.strictEqual(enroll.canRunBetaDiagnostics(undefined, envWith()), false);
  assert.strictEqual(enroll.canRunBetaDiagnostics('example.com', envWith()), false);
});
test('canRunBetaDiagnostics false when store not listed', () => {
  assert.strictEqual(enroll.canRunBetaDiagnostics('other.myshopify.com', envWith()), false);
});
test('canRunBetaDiagnostics true when flag on + store listed', () => {
  assert.strictEqual(enroll.canRunBetaDiagnostics(SHOP, envWith()), true);
});
test('canRunBetaDiagnostics matching is case-insensitive + URL/slash tolerant', () => {
  assert.strictEqual(enroll.canRunBetaDiagnostics('https://EXAMPLE.myshopify.com/', envWith()), true);
  assert.strictEqual(enroll.canRunBetaDiagnostics(SHOP, envWith({ DIAGNOSTICS_STORE_ALLOWLIST: 'https://Example.myshopify.com/, b.myshopify.com' })), true);
});

// ── getBetaDiagnosticsRouteBlock ─────────────────────────────────────────────

test('getBetaDiagnosticsRouteBlock returns 404 body when blocked', () => {
  const block = enroll.getBetaDiagnosticsRouteBlock('other.myshopify.com', envWith());
  assert.deepStrictEqual(block, { status: 404, body: { error: 'Not found.' } });
});
test('getBetaDiagnosticsRouteBlock returns null when allowed', () => {
  assert.strictEqual(enroll.getBetaDiagnosticsRouteBlock(SHOP, envWith()), null);
});
test('getBetaDiagnosticsRouteBlock blocks (does not leak) when globally off too', () => {
  const off = enroll.getBetaDiagnosticsRouteBlock(SHOP, envWith({ PRODUCT_OPPORTUNITY_DIAGNOSTICS: 'false' }));
  assert.deepStrictEqual(off, { status: 404, body: { error: 'Not found.' } });
});

// ── Structural: route gates before any DB work ───────────────────────────────

test('diagnostics route calls getBetaDiagnosticsRouteBlock before req.app.get(prisma)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'action-center.routes.js'), 'utf8'
  );
  const routeIdx = src.indexOf("router.get('/opportunity-diagnostics'");
  assert.ok(routeIdx > -1, 'diagnostics route must exist');
  // Search within the route handler body (bounded before the next router.* def).
  const after = src.slice(routeIdx);
  const nextRoute = after.indexOf('\nrouter.', 1);
  const body = nextRoute > -1 ? after.slice(0, nextRoute) : after;
  const gateIdx = body.indexOf('getBetaDiagnosticsRouteBlock');
  const prismaIdx = body.indexOf("req.app.get('prisma')");
  assert.ok(gateIdx > -1, 'route must call getBetaDiagnosticsRouteBlock');
  assert.ok(prismaIdx > -1, 'route must fetch prisma');
  assert.ok(gateIdx < prismaIdx, 'enrollment gate must run before req.app.get(prisma)');
});
