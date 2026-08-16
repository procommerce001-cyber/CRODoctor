'use strict';

// ---------------------------------------------------------------------------
// beta-safety.service.js — Controlled Beta write kill switch (PR C).
//
// Pure, fail-closed helpers that decide whether Shopify writes / Apply / Rollback
// must be blocked. Used to make a real-store read-only beta PROVABLE: when a
// write-disable flag is set, no Shopify product mutation can occur.
//
// Env flags (any explicit-truthy value enables):
//   CONTROLLED_BETA_READ_ONLY  — master beta read-only switch
//   DISABLE_SHOPIFY_WRITES     — hard Shopify write kill switch
//   APPLY_DISABLED             — disables Apply/Rollback/batch-apply routes
//
// Guarantees: no Prisma / Shopify / Anthropic / network / DB / mutation / logs.
// Fail-closed: once any disable flag is truthy, writes are blocked. Absence or
// any non-truthy value leaves existing behavior unchanged (writes allowed).
// ---------------------------------------------------------------------------

const TRUTHY = new Set(['true', '1', 'yes', 'on']);

// Only explicit, well-known truthy strings enable a flag. Everything else
// (false/0/no/off/""/null/undefined/other) is treated as NOT set.
function isTruthyFlag(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return TRUTHY.has(value.trim().toLowerCase());
}

function isBetaReadOnly(env = process.env) {
  return !!env && isTruthyFlag(env.CONTROLLED_BETA_READ_ONLY);
}

function isShopifyWritesDisabled(env = process.env) {
  return !!env && isTruthyFlag(env.DISABLE_SHOPIFY_WRITES);
}

function isApplyDisabled(env = process.env) {
  return !!env && isTruthyFlag(env.APPLY_DISABLED);
}

// The chokepoint decision: block Shopify writes when read-only OR writes-disabled.
function shouldBlockShopifyWrites(env = process.env) {
  return isBetaReadOnly(env) || isShopifyWritesDisabled(env);
}

// The route decision for dangerous (Apply/Rollback/batch-apply) endpoints:
// block on read-only, writes-disabled, OR apply-disabled.
function shouldBlockApplyRoutes(env = process.env) {
  return shouldBlockShopifyWrites(env) || isApplyDisabled(env);
}

const BETA_READ_ONLY_MESSAGE =
  'Shopify writes are disabled in controlled beta read-only mode.';

function betaReadOnlyResponseBody() {
  return { error: 'beta_read_only', message: BETA_READ_ONLY_MESSAGE };
}

// Stable error for the write chokepoint. Carries a machine code + HTTP status.
function createBetaReadOnlyError() {
  const err = new Error(BETA_READ_ONLY_MESSAGE);
  err.name = 'BetaReadOnlyWriteBlocked';
  err.code = 'BETA_READ_ONLY_WRITE_BLOCKED';
  err.status = 403;
  return err;
}

// Route helper: returns { status, body } to short-circuit a dangerous route,
// or null when the route may proceed. Lets handlers block BEFORE any DB/Shopify
// work with a single line and stay unit-testable without Express.
function getBetaReadOnlyRouteBlock(env = process.env) {
  if (shouldBlockApplyRoutes(env)) {
    return { status: 403, body: betaReadOnlyResponseBody() };
  }
  return null;
}

module.exports = {
  isTruthyFlag,
  isBetaReadOnly,
  isShopifyWritesDisabled,
  isApplyDisabled,
  shouldBlockShopifyWrites,
  shouldBlockApplyRoutes,
  betaReadOnlyResponseBody,
  createBetaReadOnlyError,
  getBetaReadOnlyRouteBlock,
};
