'use client';

import type { DecisionV2 } from '@/lib/api';

// ---------------------------------------------------------------------------
// DecisionV2Card — read-only display of the additive conversion-first decision
// object. Advisory only: renders no action buttons and never triggers
// Apply/Rollback/Undo. Used in both the light ExecutionDetailsPanel drawer and
// the dark ProductInspectorPanel dashboard card via the `variant` prop.
// ---------------------------------------------------------------------------

const V2_ACTION: Record<string, { label: string; color: string; bg: string; border: string }> = {
  keep:               { label: 'Keep',               color: '#16a34a', bg: 'rgba(34,197,94,0.10)',   border: 'rgba(34,197,94,0.30)' },
  undo_suggested:     { label: 'Undo suggested',      color: '#d97706', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.35)' },
  try_alternative:    { label: 'Try alternative',     color: '#2563eb', bg: 'rgba(96,165,250,0.10)',  border: 'rgba(96,165,250,0.30)' },
  continue_measuring: { label: 'Continue measuring',  color: '#6b7280', bg: 'rgba(156,163,175,0.10)', border: 'rgba(156,163,175,0.30)' },
  manual_review:      { label: 'Manual review',       color: '#d97706', bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.30)' },
  stack_next_change:  { label: 'Stack next change',   color: '#16a34a', bg: 'rgba(34,197,94,0.10)',   border: 'rgba(34,197,94,0.30)' },
};

export default function DecisionV2Card({ d, variant = 'light' }: { d: DecisionV2; variant?: 'light' | 'dark' }) {
  const cfg    = V2_ACTION[d.recommendedAction] ?? V2_ACTION.continue_measuring;
  const isUndo = d.recommendedAction === 'undo_suggested';
  const s      = variant === 'dark' ? DARK : LIGHT;
  const pct    = (n: number | null) => (n == null ? null : `${n > 0 ? '+' : ''}${n}%`);
  const score  = (n: number | null) => (n == null ? null : `${n}/100`);

  const chips: Array<[string, string | null]> = [
    ['Confidence',   score(d.confidenceScore)],
    ['Data quality', score(d.dataQualityScore)],
    ['Attribution',  score(d.attributionConfidence)],
    ...(isUndo ? [['Downside risk', score(d.downsideRiskScore)] as [string, string | null]] : []),
  ];
  const visibleChips = chips.filter(([, v]) => v != null);

  return (
    <div style={{ ...s.card, background: cfg.bg, borderColor: cfg.border }}>
      <div style={s.head}>
        <span style={{ ...s.chip, color: cfg.color, borderColor: cfg.border }}>{cfg.label}</span>
        {d.shouldNotTouchReason && <span style={s.paused}>Paused</span>}
      </div>

      <p style={s.expl}>{d.shouldNotTouchReason ?? d.explanationForMerchant}</p>

      {d.primaryMetric && d.primaryMetricLift != null && (
        <p style={s.metric}>
          {d.primaryMetric.replace(/_/g, ' ')}:{' '}
          <strong style={{ color: d.primaryMetricLift >= 0 ? '#16a34a' : '#d97706' }}>{pct(d.primaryMetricLift)}</strong>
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
        <p style={s.thin}>Not enough data yet</p>
      )}

      {(d.internalReasonCodes?.length > 0 || d.confoundFlags?.length > 0) && (
        <details style={s.details}>
          <summary style={s.summary}>Why?</summary>
          <div style={s.why}>
            {d.confoundFlags?.length > 0 && <div>Confounds: {d.confoundFlags.join(', ')}</div>}
            {d.internalReasonCodes?.length > 0 && <div>{d.internalReasonCodes.join(' · ')}</div>}
          </div>
        </details>
      )}
    </div>
  );
}

const BASE: Record<string, React.CSSProperties> = {
  card:       { border: '1px solid', borderRadius: 8, padding: '12px 14px', marginBottom: 12 },
  head:       { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  chip:       { fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' as const, border: '1px solid', borderRadius: 6, padding: '2px 8px' },
  paused:     { fontSize: 10, fontWeight: 700, color: '#92400e', background: 'rgba(245,158,11,0.18)', borderRadius: 4, padding: '2px 6px', textTransform: 'uppercase' as const },
  metric:     { fontSize: 12, margin: '0 0 8px' },
  scores:     { display: 'flex', flexWrap: 'wrap' as const, gap: 8 },
  score:      { display: 'flex', flexDirection: 'column' as const, gap: 1, borderRadius: 6, padding: '4px 8px', minWidth: 64 },
  scoreLabel: { fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  thin:       { fontSize: 12, fontStyle: 'italic' as const, margin: 0 },
  details:    { marginTop: 8 },
  summary:    { fontSize: 11, cursor: 'pointer', userSelect: 'none' as const },
  why:        { fontSize: 11, lineHeight: 1.5, marginTop: 6, display: 'flex', flexDirection: 'column' as const, gap: 3 },
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
