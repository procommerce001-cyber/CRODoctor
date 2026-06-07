'use client';

import type { DecisionV2 } from '@/lib/api';

// ---------------------------------------------------------------------------
// DecisionV2Card — read-only display of the additive conversion-first decision
// object. Advisory only: renders no action buttons and never triggers
// Apply/Rollback/Undo. Used in both the light ExecutionDetailsPanel drawer and
// the dark ProductInspectorPanel dashboard card via the `variant` prop.
//
// This file is COPY-ONLY presentation of backend fields: it never changes the
// backend enum values or decision logic — it maps them to merchant-friendly text.
// ---------------------------------------------------------------------------

// Merchant-facing action labels (backend enum → friendly display).
const ACTION_LABEL: Record<string, string> = {
  continue_measuring: 'Still collecting data',
  keep:               'Keep this change',
  undo_suggested:     'Undo suggested',
  try_alternative:    'Try another improvement',
  manual_review:      'Needs review',
  stack_next_change:  'Ready for next improvement',
};

const ACTION_TONE: Record<string, { color: string; bg: string; border: string }> = {
  keep:               { color: '#16a34a', bg: 'rgba(34,197,94,0.10)',   border: 'rgba(34,197,94,0.30)' },
  undo_suggested:     { color: '#d97706', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.35)' },
  try_alternative:    { color: '#2563eb', bg: 'rgba(96,165,250,0.10)',  border: 'rgba(96,165,250,0.30)' },
  continue_measuring: { color: '#6b7280', bg: 'rgba(156,163,175,0.10)', border: 'rgba(156,163,175,0.30)' },
  manual_review:      { color: '#d97706', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.30)' },
  stack_next_change:  { color: '#16a34a', bg: 'rgba(34,197,94,0.10)',   border: 'rgba(34,197,94,0.30)' },
};

// Merchant-facing explanation, driven by action + measurement status.
// Confident, protective, non-technical — never says "low confidence" bluntly.
function explanationFor(d: DecisionV2): string {
  if (d.measurementStatus === 'cooling_down' || d.recommendedAction === 'continue_measuring') {
    return 'The change is live. We’re giving early visitor behavior time to stabilize before judging the result. ' +
      'Once enough visitors have seen it, CRODoctor will recommend whether to keep it, undo it, or test a different improvement.';
  }
  switch (d.recommendedAction) {
    case 'keep':              return 'This change is showing a positive signal. We recommend keeping it active while monitoring the result.';
    case 'undo_suggested':    return 'This change may be hurting performance. We recommend reviewing it and undoing if the trend continues.';
    case 'try_alternative':   return 'This change did not create a clear lift. A different improvement may be a better fit for this product.';
    case 'manual_review':     return 'The result is noisy or affected by outside factors. Review before making a decision.';
    case 'stack_next_change': return 'This change is performing well. The next step can target a different part of the buying journey.';
    default:                  return d.explanationForMerchant;
  }
}

// Plain-language "Why?" mapping. Raw snake_case codes are never shown.
const REASON_COPY: Record<string, string> = {
  in_cooldown:            'We wait briefly after applying a change so early traffic, cache, and random fluctuations don’t create a false result.',
  window_not_complete:    'The measurement window is still open.',
  low_data_quality:       'More visitors need to see this product before the result is reliable.',
  insufficient_views:     'Not enough product views yet.',
  insufficient_atc:       'Not enough add-to-cart events yet.',
  insufficient_orders:    'Not enough orders yet.',
  exposure_data_missing:  'We don’t have enough exposed-vs-unexposed visitor data yet, so the system is using a safer fallback.',
  exposure_data_available:'The system is comparing visitors who saw the change against visitors who did not.',
  revenue_only_fallback:  'Session data is limited, so revenue is being treated as a weaker signal.',
  manual_review_required: 'Outside factors may be affecting the result, so the system is avoiding an automatic recommendation.',
  storewide_spike_detected:'A store-wide sales or traffic spike may be affecting this product’s numbers.',
  product_traffic_spike:  'This product had unusual traffic during the measurement window.',
  inventory_changed:      'Inventory changed during the measurement window.',
  overlapping_execution:  'Another change overlaps this one, so the result may be harder to attribute.',
  no_clear_effect:        'The change has not created a clear positive or negative signal yet.',
  positive_cvr_lift:      'Conversion is trending up.',
  positive_atc_lift:      'Add-to-cart behavior is trending up.',
  negative_cvr_lift:      'Conversion is trending down.',
  negative_atc_lift:      'Add-to-cart behavior is trending down.',
  revenue_per_view_drop:  'Revenue per visitor is trending down.',
  effect_below_floor:     'The change is too small to judge confidently yet.',
  ready_to_stack:         'This change may be strong enough to test another improvement later.',
  // Attribution-safety (exposure is directional, not a randomized A/B test).
  exposure_directional_only: 'This signal is directional because visitors who saw the block may already be more engaged.',
  exposure_selection_bias:   'This signal is directional because visitors who saw the block may already be more engaged.',
  no_randomized_holdout:     'This is not a randomized A/B test yet, so CRODoctor avoids treating the result as proven lift.',
  before_after_primary:      'CRODoctor is comparing performance against the product’s recent baseline before making a recommendation.',
  exposure_supports_trend:   'Visitor behavior around the change supports the current trend, but it is not used alone.',
  exposure_conflicts_with_baseline: 'Visitor behavior and baseline performance are not aligned yet, so CRODoctor is waiting for a clearer signal.',
  causal_lift_not_proven:    'The result is still directional, not proven.',
  // confoundFlag types alias to the same plain copy
  store_revenue_spike:    'A store-wide sales or traffic spike may be affecting this product’s numbers.',
  inventory_depletion:    'Inventory changed during the measurement window.',
};
const GENERIC_REASON = 'CRODoctor is still checking whether this result is reliable.';

// Score band — softens raw 0–100 numbers into a readable label.
function band(n: number | null): string | null {
  if (n == null) return null;
  if (n < 40) return 'Low';
  if (n < 70) return 'Building';
  if (n < 85) return 'Good';
  return 'Strong';
}

export default function DecisionV2Card({ d, variant = 'light' }: { d: DecisionV2; variant?: 'light' | 'dark' }) {
  const cfg  = ACTION_TONE[d.recommendedAction] ?? ACTION_TONE.continue_measuring;
  const s    = variant === 'dark' ? DARK : LIGHT;
  const isUndo = d.recommendedAction === 'undo_suggested';
  const stabilizing = d.measurementStatus === 'cooling_down';

  const scoreText = (n: number | null) => {
    const b = band(n);
    return b == null ? null : `${b} · ${n}/100`;
  };

  const chips: Array<[string, string | null]> = [
    ['Decision clarity', scoreText(d.confidenceScore)],
    ['Data collected',   scoreText(d.dataQualityScore)],
    ['Impact clarity',   scoreText(d.attributionConfidence)],
    ...(isUndo ? [['Risk signal', scoreText(d.downsideRiskScore)] as [string, string | null]] : []),
  ];
  const visibleChips = chips.filter(([, v]) => v != null);

  // Map reason codes + confound flags → plain language (dedup, no raw codes).
  const rawReasons = [...new Set([...(d.confoundFlags ?? []), ...(d.internalReasonCodes ?? [])])];
  const mapped = [...new Set(rawReasons.map(r => REASON_COPY[r]).filter(Boolean))] as string[];
  const whyLines = mapped.length > 0 ? mapped : [GENERIC_REASON];

  return (
    <div style={{ ...s.card, background: cfg.bg, borderColor: cfg.border }}>
      <div style={s.head}>
        <span style={{ ...s.chip, color: cfg.color, borderColor: cfg.border }}>
          {ACTION_LABEL[d.recommendedAction] ?? d.recommendedAction}
        </span>
        {stabilizing && <span style={s.badge}>Stabilizing</span>}
      </div>

      <p style={s.expl}>{explanationFor(d)}</p>

      {d.primaryMetric && d.primaryMetricLift != null && (
        <p style={s.metric}>
          {d.primaryMetric.replace(/_/g, ' ')}:{' '}
          <strong style={{ color: d.primaryMetricLift >= 0 ? '#16a34a' : '#d97706' }}>
            {`${d.primaryMetricLift > 0 ? '+' : ''}${d.primaryMetricLift}%`}
          </strong>
        </p>
      )}

      {visibleChips.length > 0 ? (
        <div style={s.scores}>
          {visibleChips.map(([label, val]) => (
            <span key={label} style={s.score}>
              <span style={s.scoreLabel}>{label}</span>
              <span style={s.scoreVal}>{val}</span>
            </span>
          ))}
        </div>
      ) : (
        <p style={s.thin}>We’ll show clarity scores once more visitors have seen this change.</p>
      )}

      <details style={s.details}>
        <summary style={s.summary}>Why?</summary>
        <div style={s.why}>
          {whyLines.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </details>
    </div>
  );
}

const BASE: Record<string, React.CSSProperties> = {
  card:       { border: '1px solid', borderRadius: 8, padding: '12px 14px', marginBottom: 12 },
  head:       { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  chip:       { fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' as const, border: '1px solid', borderRadius: 6, padding: '2px 8px' },
  badge:      { fontSize: 10, fontWeight: 700, color: '#2563eb', background: 'rgba(37,99,235,0.12)', borderRadius: 4, padding: '2px 6px', textTransform: 'uppercase' as const },
  metric:     { fontSize: 12, margin: '0 0 8px' },
  scores:     { display: 'flex', flexWrap: 'wrap' as const, gap: 8 },
  score:      { display: 'flex', flexDirection: 'column' as const, gap: 1, borderRadius: 6, padding: '4px 8px', minWidth: 84 },
  scoreLabel: { fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  thin:       { fontSize: 12, fontStyle: 'italic' as const, margin: 0 },
  details:    { marginTop: 8 },
  summary:    { fontSize: 11, cursor: 'pointer', userSelect: 'none' as const },
  why:        { fontSize: 11, lineHeight: 1.5, marginTop: 6, display: 'flex', flexDirection: 'column' as const, gap: 4 },
};

const LIGHT: Record<string, React.CSSProperties> = {
  ...BASE,
  expl:       { fontSize: 13, color: '#374151', lineHeight: 1.5, margin: '0 0 8px' },
  metric:     { ...BASE.metric, color: '#4b5563' },
  score:      { ...BASE.score, background: 'rgba(0,0,0,0.04)' },
  scoreLabel: { ...BASE.scoreLabel, color: '#6b7280' },
  scoreVal:   { fontSize: 13, fontWeight: 700, color: '#111827' },
  thin:       { ...BASE.thin, color: '#9ca3af' },
  summary:    { ...BASE.summary, color: '#6b7280' },
  why:        { ...BASE.why, color: '#6b7280' },
};

const DARK: Record<string, React.CSSProperties> = {
  ...BASE,
  expl:       { fontSize: 13, color: '#d1d5db', lineHeight: 1.5, margin: '0 0 8px' },
  metric:     { ...BASE.metric, color: '#9ca3af' },
  score:      { ...BASE.score, background: 'rgba(255,255,255,0.06)' },
  scoreLabel: { ...BASE.scoreLabel, color: '#9ca3af' },
  scoreVal:   { fontSize: 13, fontWeight: 700, color: '#e5e7eb' },
  thin:       { ...BASE.thin, color: '#9ca3af' },
  summary:    { ...BASE.summary, color: '#9ca3af' },
  why:        { ...BASE.why, color: '#9ca3af' },
};
