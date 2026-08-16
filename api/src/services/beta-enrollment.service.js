'use strict';

// ---------------------------------------------------------------------------
// beta-enrollment.service.js — Controlled Beta diagnostics enrollment gate (PR B).
//
// Pure, fail-closed helpers that decide whether the INTERNAL diagnostics route
// may run for a given shop. A real-store Beta 0 must be scoped to explicitly
// enrolled stores, so PRODUCT_OPPORTUNITY_DIAGNOSTICS=true alone is NOT enough:
// the shop must also be in DIAGNOSTICS_STORE_ALLOWLIST.
//
// This is a SEPARATE concern from beta-safety.service.js (the write kill switch):
//   - beta-safety      → blocks Shopify WRITES (403 / thrown error)
//   - beta-enrollment  → gates read-only DIAGNOSTICS visibility (404, no leak)
//
// Guarantees: no Prisma / Shopify / Anthropic / network / DB / mutation / logs /
// secrets. Deterministic. Fail-closed: missing/empty/malformed config or a
// non-enrolled shop → diagnostics do not run.
// ---------------------------------------------------------------------------

const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const DIAGNOSTICS_FLAG = 'PRODUCT_OPPORTUNITY_DIAGNOSTICS';
const ALLOWLIST_KEY = 'DIAGNOSTICS_STORE_ALLOWLIST';

// Canonical Shopify store host: <sub>.myshopify.com (custom domains rejected for
// PR B to minimize tenant confusion).
const MYSHOPIFY_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function isTruthyFlag(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return TRUTHY.has(value.trim().toLowerCase());
}

// Normalize an input into a canonical *.myshopify.com host, or null if invalid.
// Never throws.
function normalizeShopDomain(value) {
  if (typeof value !== 'string') return null;
  let s = value.trim().toLowerCase();
  if (s === '') return null;
  s = s.replace(/^https?:\/\//, '');   // strip protocol
  s = s.replace(/[/?#].*$/, '');        // strip path/query/hash after host
  s = s.replace(/\/+$/, '');            // strip any residual trailing slash
  if (!MYSHOPIFY_RE.test(s)) return null;
  return s;
}

// Parse a comma-separated allowlist into a de-duplicated array of canonical
// hosts. Empty/invalid entries are ignored. Missing/empty → [] (fail-closed).
function parseStoreAllowlist(value) {
  if (typeof value !== 'string') return [];
  const seen = new Set();
  for (const part of value.split(',')) {
    const host = normalizeShopDomain(part);
    if (host) seen.add(host);
  }
  return [...seen];
}

function isDiagnosticsGloballyEnabled(env = process.env) {
  return !!env && isTruthyFlag(env[DIAGNOSTICS_FLAG]);
}

function isStoreAllowlisted(shop, env = process.env) {
  const host = normalizeShopDomain(shop);
  if (!host) return false;
  const allow = parseStoreAllowlist(env && env[ALLOWLIST_KEY]);
  return allow.includes(host);
}

// The single fail-closed decision: diagnostics may run only when the global flag
// is on AND the shop is a valid, enrolled *.myshopify.com host.
function canRunBetaDiagnostics(shop, env = process.env) {
  return isDiagnosticsGloballyEnabled(env) && isStoreAllowlisted(shop, env);
}

// 404 body — identical whether diagnostics are globally off or the shop is not
// enrolled, so enrollment state never leaks.
function betaDiagnosticsNotFoundBody() {
  return { error: 'Not found.' };
}

// Route helper: returns { status, body } to short-circuit the diagnostics route,
// or null when it may proceed. Lets the handler block BEFORE any DB/Shopify work.
function getBetaDiagnosticsRouteBlock(shop, env = process.env) {
  if (!canRunBetaDiagnostics(shop, env)) {
    return { status: 404, body: betaDiagnosticsNotFoundBody() };
  }
  return null;
}

module.exports = {
  isTruthyFlag,
  normalizeShopDomain,
  parseStoreAllowlist,
  isDiagnosticsGloballyEnabled,
  isStoreAllowlisted,
  canRunBetaDiagnostics,
  betaDiagnosticsNotFoundBody,
  getBetaDiagnosticsRouteBlock,
};
