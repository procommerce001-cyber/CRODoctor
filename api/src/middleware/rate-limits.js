'use strict';

// ---------------------------------------------------------------------------
// rate-limits.js — basic, beta-safe Express rate limiting.
//
// Dependency-free, in-memory fixed-window limiter. This is intentionally simple
// for a single-instance beta: it protects against public-event spam, accidental
// repeated writes, and runaway expensive (LLM/Shopify) requests without adding a
// dependency. It does NOT change any business logic.
//
// PRODUCTION NOTES (follow-ups, not this task):
//   - Multi-instance deploys need a shared store (e.g. Redis) instead of in-memory.
//   - If behind a proxy/load balancer, set `app.set('trust proxy', 1)` so req.ip
//     reflects the real client IP for the IP-keyed public limiter.
//
// Tunable via env (defaults are beta-safe and generous for manual QA):
//   RATE_LIMIT_ENABLED            ('false' disables all limiters; default on)
//   RATE_LIMIT_EVENTS_PER_MIN     (default 60)
//   RATE_LIMIT_DASHBOARD_PER_MIN  (default 120)
//   RATE_LIMIT_EXPENSIVE_PER_MIN  (default 20)
//   RATE_LIMIT_WRITE_PER_MIN      (default 5)
// ---------------------------------------------------------------------------

const ENABLED   = process.env.RATE_LIMIT_ENABLED !== 'false';
const WINDOW_MS = 60 * 1000;

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

const LIMITS = {
  events:    intEnv('RATE_LIMIT_EVENTS_PER_MIN', 60),
  dashboard: intEnv('RATE_LIMIT_DASHBOARD_PER_MIN', 120),
  expensive: intEnv('RATE_LIMIT_EXPENSIVE_PER_MIN', 20),
  write:     intEnv('RATE_LIMIT_WRITE_PER_MIN', 5),
};

// keyFn: how a caller is identified for a given limiter bucket.
function makeLimiter(name, max, keyFn) {
  const hits = new Map(); // `${name}:${key}` -> { count, resetAt }
  return function limiter(req, res, next) {
    if (!ENABLED) return next();
    const now = Date.now();
    const key = `${name}:${keyFn(req) || 'unknown'}`;
    let entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      hits.set(key, entry);
    }
    entry.count++;
    const resetSec = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('RateLimit-Reset', String(resetSec));
    if (entry.count > max) {
      res.setHeader('Retry-After', String(resetSec));
      // Opportunistic cleanup so the Map can't grow unbounded.
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
      }
      // No tenant details leaked in the response.
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    return next();
  };
}

// Public ingest: IP-keyed (no session). Protected routes: tenant-keyed, IP fallback.
const ipKey     = (req) => req.ip;
const tenantKey = (req) => (req.session && req.session.storeId) || (req.query && req.query.shop) || req.ip;

const eventsLimiter    = makeLimiter('events',    LIMITS.events,    ipKey);
const dashboardLimiter = makeLimiter('dashboard', LIMITS.dashboard, tenantKey);
const expensiveLimiter = makeLimiter('expensive', LIMITS.expensive, tenantKey);
const writeLimiter     = makeLimiter('write',     LIMITS.write,     tenantKey);

module.exports = {
  ENABLED,
  LIMITS,
  makeLimiter,
  eventsLimiter,
  dashboardLimiter,
  expensiveLimiter,
  writeLimiter,
};
