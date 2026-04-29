'use strict';

// ---------------------------------------------------------------------------
// Phase 2 V1 classification thresholds — single source of truth.
// These are starting defaults, not permanent hard truth.
// Centralized here for future per-store and per-category calibration.
// ---------------------------------------------------------------------------

module.exports = {
  // Sessions below this in the 28-day window: no content fix is measurable.
  TRAFFIC_MIN_SESSIONS: 200,

  // Once content_bottleneck, only re-gate to traffic_problem below this floor.
  TRAFFIC_HYSTERESIS_SESSIONS: 150,

  // Add-to-cart rate below this signals a page-level conversion failure.
  ATC_RATE_BOTTLENECK_THRESHOLD: 0.03,

  // Add-to-cart rate at or above this (with low refund rate) = product performing.
  ATC_RATE_PERFORMING_THRESHOLD: 0.05,

  // Fraction of orders on the cheapest variant above this = pricing problem, not content.
  VARIANT_SKEW_THRESHOLD: 0.80,

  // Refund rate above this, combined with adequate CVR = trust or expectation mismatch.
  REFUND_RATE_THRESHOLD: 0.15,

  // Minimum orders in the window to compute a meaningful refund rate.
  REFUND_MIN_ORDERS: 5,

  // Organic + direct + email fraction required to treat traffic as conversion-intent qualified.
  QUALIFIED_TRAFFIC_THRESHOLD: 0.40,

  // Minimum measured outcomes (issue × archetype × traffic band) for high-confidence tier.
  CONFIDENCE_HIGH: 10,

  // Minimum measured outcomes for medium-confidence tier.
  CONFIDENCE_MEDIUM: 5,

  // Minimum measured outcomes for low-confidence tier.
  CONFIDENCE_LOW: 2,

  // Rolling window length for all profiling queries.
  PROFILE_WINDOW_DAYS: 28,
};
