'use strict';

// ---------------------------------------------------------------------------
// CRO Scoring
//
// Score = 0–100. Higher = better optimized. Lower = more urgent to fix.
//
// Algorithm:
//   1. Start at MAX_SCORE (100)
//   2. Deduct points per issue severity (see SEVERITY_DEDUCTIONS)
//   3. Floor at 0
//
// The score represents content/conversion readiness — not traffic volume
// or actual revenue. A draft product can score 100 on content but is still
// invisible (product_is_draft will be a critical issue regardless).
//
// Score bands (from constants.js):
//   80–100 : Strong
//   60–79  : Good
//   40–59  : Needs Work
//   20–39  : Weak
//   0–19   : Critical
// ---------------------------------------------------------------------------

const { SEVERITY_DEDUCTIONS, scoreBand } = require('./constants');

const MAX_SCORE = 100;

// ---------------------------------------------------------------------------
// scoreProduct
// Takes the issues array already produced by analyzeProduct.
// Pure function — same input always produces same output.
// ---------------------------------------------------------------------------
function scoreProduct(issues) {
  let deductions = 0;

  for (const issue of issues) {
    deductions += SEVERITY_DEDUCTIONS[issue.severity] || 0;
  }

  const score = Math.max(0, MAX_SCORE - deductions);
  const band  = scoreBand(score);

  return {
    score,
    label:       band.label,
    description: band.description,
  };
}

// ---------------------------------------------------------------------------
// scoreStore
// Aggregate score across all products (active products weighted 2×).
// Returns a single store-level health score.
// ---------------------------------------------------------------------------
function scoreStore(scoredProducts) {
  if (!scoredProducts.length) return { score: 0, label: 'Critical', description: 'No products synced.' };

  const activeProducts = scoredProducts.filter(p => p.status === 'active');
  const targetProducts = activeProducts.length ? activeProducts : scoredProducts;

  const total  = targetProducts.reduce((sum, p) => sum + p.optimizationScore, 0);
  const avg    = Math.round(total / targetProducts.length);
  const band   = scoreBand(avg);

  return {
    score:       avg,
    label:       band.label,
    description: band.description,
  };
}

module.exports = { scoreProduct, scoreStore };
