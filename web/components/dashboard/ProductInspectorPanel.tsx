import type { FeedRow } from './OptimizationFeed';
import { issueLabel } from '@/lib/api';

// Grounded in ISSUE_LABELS — maps every known issueId to its improvement area
const ISSUE_CATEGORY: Record<string, string> = {
  weak_desire_creation:         'Desire & copy',
  features_before_desire:       'Desire & copy',
  no_future_pacing:             'Desire & copy',
  no_sensory_language:          'Desire & copy',
  no_outcome_sentence:          'Desire & copy',
  spec_pivot_early:             'Desire & copy',
  no_description:               'Description',
  description_too_short:        'Description',
  description_center_aligned:   'Description',
  no_risk_reversal:             'Trust & risk',
  no_social_proof:              'Trust & risk',
  no_trust_bullets:             'Trust & risk',
  no_urgency:                   'Urgency & price',
  no_compare_price:             'Urgency & price',
  weak_discount:                'Urgency & price',
  strong_discount_not_featured: 'Urgency & price',
  no_size_guide:                'UX & media',
  no_images:                    'UX & media',
  few_images:                   'UX & media',
  missing_alt_text:             'UX & media',
  no_bundle_pricing:            'Pricing',
  low_inventory_unused:         'Availability',
  all_variants_oos:             'Availability',
  some_variants_oos:            'Availability',
  product_is_draft:             'Availability',
};

const STATUS_CFG: Record<string, { label: string; color: string }> = {
  ready:       { label: 'Ready to apply',  color: '#22c55e' },
  live:        { label: 'Live · measuring', color: '#4ade80' },
  measuring:   { label: 'Measuring now',   color: '#fbbf24' },
  measured:    { label: 'Measured',        color: '#60a5fa' },
  queued:      { label: 'Up next',         color: '#9ca3af' },
  rolled_back: { label: 'Protected',       color: '#6b7280' },
};

const DECISION_SIGNAL_LABEL: Record<string, string> = {
  keep:               'Keep live — performing well',
  revise:             'Consider revision',
  rollback_candidate: 'Rollback candidate',
  still_measuring:    'Still measuring',
};

function pctStr(v: number | null): string {
  if (v === null) return '—';
  return `${v > 0 ? '+' : ''}${Math.round(v)}%`;
}

function pctColor(v: number | null): string {
  if (v === null) return '#6b7280';
  return v > 0 ? '#4ade80' : v < 0 ? '#f87171' : '#9ca3af';
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function ProductInspectorPanel({ row }: { row: FeedRow | null }) {
  if (!row) {
    return (
      <div style={p.wrap}>
        <div style={p.headerBar}>
          <span style={p.headerLabel}>Product inspector</span>
        </div>
        <div style={p.emptyBody}>
          <div style={p.emptyDot} />
          <span style={p.emptyText}>Hover a product in the feed to inspect it</span>
        </div>
      </div>
    );
  }

  const action   = row.topAction;
  const activity = row.activityItem;
  const ready    = row.readyItem;
  const status   = STATUS_CFG[row.feedStatus] ?? { label: row.feedStatus, color: '#9ca3af' };
  const category = ISSUE_CATEGORY[row.issueId] ?? 'Optimization';

  return (
    <div style={p.wrap}>
      {/* Header */}
      <div style={p.headerBar}>
        <span style={p.headerLabel}>Product inspector</span>
      </div>

      {/* S1 — Product snapshot */}
      <div style={p.section}>
        <div style={p.statusRow}>
          <span style={{ ...p.statusDot, background: status.color }} />
          <span style={{ ...p.statusText, color: status.color }}>{status.label}</span>
        </div>
        <div style={p.productName}>{row.productTitle ?? 'Unknown product'}</div>
        <div style={p.issueName}>{issueLabel(row.issueId)}</div>
        <span style={p.categoryChip}>{category}</span>
      </div>

      <div style={p.divider} />

      {/* S2 — Commercial snapshot (TopAction path) */}
      {action && (
        <div style={p.section}>
          <div style={p.sectionTitle}>Commercial signal</div>
          {action.estimatedImpactLabel && (
            <div style={p.metricRow}>
              <span style={p.metricLabel}>Expected impact</span>
              <span style={{ ...p.metricValue, color: '#4ade80' }}>{action.estimatedImpactLabel}</span>
            </div>
          )}
          {action.revenue > 0 && (
            <div style={p.metricRow}>
              <span style={p.metricLabel}>Revenue at stake</span>
              <span style={p.metricValue}>${Math.round(action.revenue).toLocaleString()}</span>
            </div>
          )}
          {action.opportunityScore > 0 && (
            <div style={p.metricRow}>
              <span style={p.metricLabel}>Opportunity score</span>
              <span style={p.metricValue}>{action.opportunityScore}</span>
            </div>
          )}
          {action.quickWin && <span style={p.quickWinTag}>Quick win</span>}
        </div>
      )}

      {/* S2 — Measurement result (ActivityItem path) */}
      {activity && (
        <div style={p.section}>
          <div style={p.sectionTitle}>Measurement result</div>
          <div style={p.metricRow}>
            <span style={p.metricLabel}>Revenue</span>
            <span style={{ ...p.metricValue, color: pctColor(activity.revenueChangePercent) }}>
              {pctStr(activity.revenueChangePercent)}
            </span>
          </div>
          <div style={p.metricRow}>
            <span style={p.metricLabel}>Orders</span>
            <span style={{ ...p.metricValue, color: pctColor(activity.ordersChangePercent) }}>
              {pctStr(activity.ordersChangePercent)}
            </span>
          </div>
          {activity.measurementConfidence && activity.measurementConfidence !== 'insufficient' && (
            <div style={p.metricRow}>
              <span style={p.metricLabel}>Confidence</span>
              <span style={p.metricValue}>{activity.measurementConfidence}</span>
            </div>
          )}
          {activity.insight && <div style={p.insightText}>{activity.insight}</div>}
        </div>
      )}

      {/* S2 — Readiness (ReviewItem only, no action or activity) */}
      {ready && !action && !activity && (
        <div style={p.section}>
          <div style={p.sectionTitle}>Readiness</div>
          {ready.severity && (
            <div style={p.metricRow}>
              <span style={p.metricLabel}>Severity</span>
              <span style={p.metricValue}>{ready.severity}</span>
            </div>
          )}
          {ready.score !== null && (
            <div style={p.metricRow}>
              <span style={p.metricLabel}>Score</span>
              <span style={p.metricValue}>{ready.score}</span>
            </div>
          )}
          {ready.riskLevel && (
            <div style={p.metricRow}>
              <span style={p.metricLabel}>Risk level</span>
              <span style={p.metricValue}>{ready.riskLevel}</span>
            </div>
          )}
        </div>
      )}

      <div style={p.divider} />

      {/* S3 — Why now (TopAction) */}
      {action && (action.whyNow || action.recommendedAction) && (
        <div style={p.section}>
          <div style={p.sectionTitle}>Why now</div>
          {action.recommendedAction && (
            <div style={p.whyAction}>{action.recommendedAction}</div>
          )}
          {action.whyNow && (
            <div style={p.whyText}>{action.whyNow}</div>
          )}
          {action.expectedTimeToImpact && (
            <div style={p.metricRow}>
              <span style={p.metricLabel}>Time to impact</span>
              <span style={p.metricValue}>{action.expectedTimeToImpact}</span>
            </div>
          )}
        </div>
      )}

      {/* S3 — Decision signal (ActivityItem) */}
      {activity?.decisionSignal && activity.decisionSignal !== 'still_measuring' && (
        <div style={p.section}>
          <div style={p.sectionTitle}>Decision signal</div>
          <span style={p.signalChip}>
            {DECISION_SIGNAL_LABEL[activity.decisionSignal] ?? activity.decisionSignal}
          </span>
        </div>
      )}

      {activity?.createdAt && (
        <div style={p.appliedRow}>Applied {fmtDate(activity.createdAt)}</div>
      )}

      <div style={p.divider} />

      {/* S4 — Behavior data: honest unavailable state */}
      <div style={p.section}>
        <div style={p.sectionTitle}>Behavior data</div>
        <div style={p.unavailable}>Add-to-cart rate — not yet at product level</div>
        <div style={p.unavailable}>Scroll depth — not yet captured</div>
      </div>
    </div>
  );
}

const p: Record<string, React.CSSProperties> = {
  wrap:         { width: 220, flexShrink: 0, background: 'rgba(255,255,255,0.015)',
                  border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10,
                  overflow: 'hidden', position: 'sticky' as const, top: 76,
                  alignSelf: 'flex-start' as const },
  headerBar:    { padding: '9px 14px', borderBottom: '1px solid rgba(255,255,255,0.06)',
                  background: 'rgba(255,255,255,0.02)' },
  headerLabel:  { fontSize: 9, fontWeight: 800, letterSpacing: '0.10em',
                  textTransform: 'uppercase' as const, color: '#4b5563' },
  emptyBody:    { padding: '20px 14px', display: 'flex', flexDirection: 'column' as const,
                  gap: 8, alignItems: 'center', textAlign: 'center' as const },
  emptyDot:     { width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.10)' },
  emptyText:    { fontSize: 11, color: '#374151', lineHeight: 1.45 },
  section:      { padding: '11px 14px' },
  divider:      { height: 1, background: 'rgba(255,255,255,0.05)' },
  sectionTitle: { fontSize: 9, fontWeight: 800, letterSpacing: '0.10em',
                  textTransform: 'uppercase' as const, color: '#4b5563', marginBottom: 8 },
  statusRow:    { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 },
  statusDot:    { width: 5, height: 5, borderRadius: '50%', flexShrink: 0 },
  statusText:   { fontSize: 10, fontWeight: 700, letterSpacing: '0.03em' },
  productName:  { fontSize: 13, fontWeight: 700, color: '#e5e7eb', lineHeight: 1.3, marginBottom: 3 },
  issueName:    { fontSize: 11, color: '#9ca3af', lineHeight: 1.4, marginBottom: 6 },
  categoryChip: { display: 'inline-block', fontSize: 9, fontWeight: 700,
                  letterSpacing: '0.07em', textTransform: 'uppercase' as const,
                  color: '#6b7280', background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)', borderRadius: 3, padding: '2px 6px' },
  metricRow:    { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                  gap: 8, marginBottom: 5 },
  metricLabel:  { fontSize: 10, color: '#4b5563' },
  metricValue:  { fontSize: 11, fontWeight: 700, color: '#9ca3af' },
  quickWinTag:  { display: 'inline-block', marginTop: 4, fontSize: 9, fontWeight: 700,
                  letterSpacing: '0.07em', textTransform: 'uppercase' as const,
                  color: '#4ade80', background: 'rgba(34,197,94,0.08)',
                  border: '1px solid rgba(34,197,94,0.18)', borderRadius: 3, padding: '2px 6px' },
  insightText:  { fontSize: 11, color: '#6b7280', lineHeight: 1.5, marginTop: 6,
                  fontStyle: 'italic' as const },
  whyAction:    { fontSize: 12, fontWeight: 600, color: '#d1d5db', lineHeight: 1.35,
                  marginBottom: 6 },
  whyText:      { fontSize: 11, color: '#6b7280', lineHeight: 1.5, marginBottom: 8 },
  signalChip:   { fontSize: 10, fontWeight: 600, color: '#9ca3af',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 4, padding: '3px 8px', display: 'inline-block' },
  appliedRow:   { padding: '0 14px 10px', fontSize: 10, color: '#374151' },
  unavailable:  { fontSize: 10, color: '#374151', lineHeight: 1.5, marginBottom: 3,
                  fontStyle: 'italic' as const },
};
