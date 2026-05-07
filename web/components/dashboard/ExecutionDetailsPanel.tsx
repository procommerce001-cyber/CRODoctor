'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fetchExecutionDetails, apiHeaders, API_BASE, issueLabel } from '@/lib/api';
import type { ExecutionDetails, MetricStat, ExposureSummary, ExposureFunnelGroup } from '@/lib/api';

const EXECUTION_STATUS_LABEL: Record<string, string> = {
  applied:     'Live on your store',
  rolled_back: 'Rolled back',
  failed:      'Failed',
  previewed:   'Preview only',
};

const DECISION_LABEL: Record<string, string> = {
  still_measuring:    'Still measuring',
  keep:               'Stable — keep live',
  revise:             'Needs review',
  rollback_candidate: 'Rollback candidate',
};

const DECISION_COLORS: Record<string, { background: string; color: string; borderColor: string }> = {
  still_measuring:    { background: '#f3f4f6', color: '#6b7280',  borderColor: '#e5e7eb' },
  keep:               { background: '#f0fdf4', color: '#166534',  borderColor: '#bbf7d0' },
  revise:             { background: '#fffbeb', color: '#92400e',  borderColor: '#fde68a' },
  rollback_candidate: { background: '#fef3c7', color: '#b45309',  borderColor: '#fde68a' },
};

const SHOP = process.env.NEXT_PUBLIC_SHOP ?? '';

interface Props {
  executionId: string;
  onClose: () => void;
}

export default function ExecutionDetailsPanel({ executionId, onClose }: Props) {
  const router = useRouter();

  const [data,            setData]            = useState<ExecutionDetails | null>(null);
  const [loading,         setLoading]         = useState(true);
  const [error,           setError]           = useState<string | null>(null);
  const [isRollingBack,   setIsRollingBack]   = useState(false);
  const [rollbackError,   setRollbackError]   = useState<string | null>(null);
  const [rollbackSuccess, setRollbackSuccess] = useState(false);

  const handleRollback = async () => {
    if (!data) return;
    setIsRollingBack(true);
    setRollbackError(null);
    setRollbackSuccess(false);
    try {
      const res = await fetch(
        `${API_BASE}/action-center/products/${encodeURIComponent(data.productId)}/rollback`,
        {
          method:      'POST',
          credentials: 'include',
          headers:     apiHeaders({ 'Content-Type': 'application/json' }),
          body:        JSON.stringify({ shop: SHOP, issueId: data.issueId }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      setRollbackSuccess(true);
      router.refresh();
    } catch (err) {
      setRollbackError(err instanceof Error ? err.message : 'Rollback failed');
    } finally {
      setIsRollingBack(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);
    fetchExecutionDetails(SHOP, executionId)
      .then(setData)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, [executionId]);

  return (
    <>
      {/* Backdrop */}
      <div style={styles.backdrop} onClick={onClose} />

      {/* Drawer */}
      <div style={styles.drawer}>
        {/* Header */}
        <div style={styles.header}>
          <span style={styles.headerTitle}>Change Details</span>
          <button style={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {loading && <p style={styles.muted}>Loading...</p>}
          {error   && <p style={styles.errorText}>{error}</p>}
          {!loading && !error && !data && <p style={styles.muted}>No data.</p>}

          {data && (
            <>
              {/* ── Meta ─────────────────────────────────────── */}
              <section style={styles.section}>
                <Row label="Change type" value={issueLabel(data.issueId)} />
                <Row label="Status"      value={EXECUTION_STATUS_LABEL[data.status] ?? data.status} />
                <Row label="Applied on"  value={new Date(data.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} />
              </section>

              {/* ── Content ──────────────────────────────────── */}
              <section style={styles.section}>
                <h3 style={styles.sectionTitle}>What changed</h3>
                <ContentBlock label="Before this change" html={data.previousContent} />
                <ContentBlock label="After this change"  html={data.appliedContent} />
              </section>

              {/* ── Impact Snapshot ──────────────────────────── */}
              <section style={styles.section}>
                <h3 style={styles.sectionTitle}>7-Day Impact Snapshot</h3>

                {data.decisionSignal && <DecisionBadge signal={data.decisionSignal} />}

                {data.resultStatus === 'measured' && data.summary && (
                  <>
                    {data.insight && <p style={styles.insight}>{data.insight}</p>}
                    <div style={styles.snapshotHeader}>
                      <span style={styles.snapshotLabel}>Metric</span>
                      <span style={styles.snapshotLabel}>Before</span>
                      <span style={styles.snapshotLabel}>After</span>
                      <span style={styles.snapshotLabel}>Change</span>
                    </div>
                    <MetricRow label="Orders"     stat={data.summary.orders} />
                    <MetricRow label="Units sold" stat={data.summary.unitsSold} />
                    <MetricRow label="Revenue"    stat={data.summary.revenue} prefix="$" />
                    {data.confounds?.detected && data.confounds.overlappingExecutions.length > 0 && (
                      <div style={styles.confoundBox}>
                        <p style={styles.confoundTitle}>Another change was also live during this measurement window. Results may reflect both changes.</p>
                        {data.confounds.overlappingExecutions.map(ex => (
                          <p key={ex.executionId} style={styles.confoundDetail}>
                            Also active: {issueLabel(ex.issueId)} &bull; {new Date(ex.appliedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </p>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {data.resultStatus === 'waiting_for_more_data' && (
                  <div style={styles.measuringBox}>
                    <span style={styles.measuringDot} />
                    <div>
                      <p style={styles.measuringTitle}>Measuring impact</p>
                      <p style={styles.measuringBody}>
                        {data.afterReadyAt
                          ? `7-day window closes on ${new Date(data.afterReadyAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. Results will appear here automatically.`
                          : 'Collecting post-apply order data. Check back in a few days.'}
                      </p>
                    </div>
                  </div>
                )}

                {!data.resultStatus && (
                  <p style={styles.muted}>No impact data available for this execution.</p>
                )}

                {data.exposure && <ExposureSection e={data.exposure} />}
              </section>

              {/* ── Rollback ─────────────────────────────────── */}
              {data.status === 'applied' && (
                <section style={styles.section}>
                  <h3 style={styles.sectionTitle}>Actions</h3>
                  {rollbackSuccess ? (
                    <p style={styles.rollbackSuccess}>Change undone — your product has been restored.</p>
                  ) : (
                    <>
                      <button
                        style={styles.rollbackBtn}
                        disabled={isRollingBack}
                        onClick={handleRollback}
                      >
                        {isRollingBack ? 'Undoing…' : 'Undo this change'}
                      </button>
                      {rollbackError && (
                        <p style={styles.rollbackError}>{rollbackError}</p>
                      )}
                    </>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DecisionBadge({ signal }: { signal: string }) {
  const label  = DECISION_LABEL[signal]  ?? signal;
  const colors = DECISION_COLORS[signal] ?? DECISION_COLORS.still_measuring;
  return <span style={{ ...styles.decisionBadge, ...colors }}>{label}</span>;
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowLabel}>{label}</span>
      <span style={mono ? styles.rowValueMono : styles.rowValue}>{value}</span>
    </div>
  );
}

function ContentBlock({ label, html }: { label: string; html: string | null }) {
  if (!html) return (
    <div style={styles.contentBlock}>
      <div style={styles.contentLabel}>{label}</div>
      <div style={{ ...styles.contentText, color: '#9ca3af' }}>—</div>
    </div>
  );
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return (
    <div style={styles.contentBlock}>
      <div style={styles.contentLabel}>{label}</div>
      <div style={styles.contentText}>{text}</div>
    </div>
  );
}

function ExposureSection({ e }: { e: ExposureSummary }) {
  const rate = e.exposureRate != null ? `${Math.round(e.exposureRate * 100)}%` : '—';
  return (
    <div style={styles.exposureBox}>
      <p style={styles.exposureTitle}>Visitor exposure</p>
      <div style={styles.exposureRow}><span>PDP sessions</span><span>{e.pdpSessionCount}</span></div>
      <div style={styles.exposureRow}><span>Exposed to change</span><span>{e.exposedSessionCount}</span></div>
      <div style={styles.exposureRow}><span>Not exposed</span><span>{e.unexposedPdpSessionCount}</span></div>
      <div style={styles.exposureRow}><span>Block views</span><span>{e.blockViewedCount}</span></div>
      <div style={styles.exposureRow}><span>Exposure rate</span><span>{rate}</span></div>
      {e.funnel && (
        <>
          <div style={styles.funnelDivider} />
          <FunnelRow label="Add to cart" g={e.funnel.exposed} u={e.funnel.unexposed} field="atc" />
          <FunnelRow label="Checkout"    g={e.funnel.exposed} u={e.funnel.unexposed} field="checkout" />
        </>
      )}
    </div>
  );
}

function FunnelRow({
  label, g, u, field,
}: {
  label:  string;
  g:      ExposureFunnelGroup;
  u:      ExposureFunnelGroup;
  field:  'atc' | 'checkout';
}) {
  const pct  = (r: number | null) => r != null ? `${Math.round(r * 100)}%` : '—';
  const expN = field === 'atc' ? g.atcSessions      : g.checkoutSessions;
  const expR = field === 'atc' ? g.atcRate          : g.checkoutRate;
  const unxN = field === 'atc' ? u.atcSessions      : u.checkoutSessions;
  const unxR = field === 'atc' ? u.atcRate          : u.checkoutRate;
  return (
    <div style={styles.funnelBlock}>
      <span style={styles.funnelLabel}>{label}</span>
      <div style={styles.funnelSubRow}><span>Exposed</span><span>{expN} ({pct(expR)})</span></div>
      <div style={styles.funnelSubRow}><span>Not exposed</span><span>{unxN} ({pct(unxR)})</span></div>
    </div>
  );
}

function MetricRow({ label, stat, prefix = '' }: { label: string; stat: MetricStat; prefix?: string }) {
  const pct   = stat.changePercent;
  const color = pct == null ? '#6b7280' : pct > 0 ? '#16a34a' : pct < 0 ? '#dc2626' : '#6b7280';
  const sign  = pct != null && pct > 0 ? '+' : '';
  return (
    <div style={styles.metricRow}>
      <span style={styles.metricLabel}>{label}</span>
      <span style={styles.metricBefore}>{prefix}{stat.before}</span>
      <span style={styles.metricArrow}>→</span>
      <span style={styles.metricAfter}>{prefix}{stat.after}</span>
      {pct != null && (
        <span style={{ ...styles.metricPct, color }}>{sign}{pct}%</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const styles: Record<string, React.CSSProperties> = {
  backdrop:     { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.25)', zIndex: 100 },
  drawer:       { position: 'fixed', top: 0, right: 0, bottom: 0, width: 440, background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,0.12)', zIndex: 101, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header:       { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #e5e7eb', flexShrink: 0 },
  headerTitle:  { fontSize: 15, fontWeight: 600, color: '#111827' },
  closeBtn:     { background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#6b7280', padding: '4px 6px' },
  body:         { flex: 1, overflowY: 'auto', padding: '20px' },
  section:      { marginBottom: 28 },
  sectionTitle: { fontSize: 12, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em', color: '#6b7280', marginBottom: 10 },
  row:          { display: 'flex', gap: 8, marginBottom: 6, alignItems: 'baseline' },
  rowLabel:     { fontSize: 12, color: '#6b7280', minWidth: 96, flexShrink: 0 },
  rowValue:     { fontSize: 13, color: '#111827' },
  rowValueMono: { fontSize: 12, color: '#374151', fontFamily: 'monospace', wordBreak: 'break-all' as const },
  contentBlock: { marginBottom: 12 },
  contentLabel: { fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, color: '#9ca3af', marginBottom: 4 },
  contentText:  { fontSize: 13, color: '#374151', lineHeight: 1.6, maxHeight: 120, overflowY: 'auto', background: '#f9fafb', padding: '8px 10px', borderRadius: 6, border: '1px solid #e5e7eb', wordBreak: 'break-word' as const },
  insight:      { fontSize: 13, color: '#111827', fontStyle: 'italic', marginBottom: 12, padding: '8px 12px', background: '#f0fdf4', borderRadius: 6, border: '1px solid #bbf7d0' },
  metricRow:    { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13 },
  metricLabel:  { color: '#374151', minWidth: 80 },
  metricBefore: { color: '#9ca3af' },
  metricArrow:  { color: '#d1d5db' },
  metricAfter:  { color: '#111827', fontWeight: 600 },
  metricPct:    { fontWeight: 600, fontSize: 12 },
  muted:           { fontSize: 13, color: '#9ca3af' },
  errorText:       { fontSize: 13, color: '#dc2626' },
  rollbackBtn:     { fontSize: 13, padding: '7px 14px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', color: '#374151', cursor: 'pointer' },
  rollbackError:   { fontSize: 12, color: '#dc2626', marginTop: 8 },
  rollbackSuccess: { fontSize: 13, color: '#16a34a' },
  snapshotHeader:  { display: 'flex', gap: 8, marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid #f3f4f6' },
  snapshotLabel:   { fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, color: '#9ca3af', flex: 1 },
  measuringBox:    { display: 'flex', gap: 10, alignItems: 'flex-start', background: '#fefce8', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 14px' },
  measuringDot:    { width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', flexShrink: 0, marginTop: 4 },
  measuringTitle:  { fontSize: 13, fontWeight: 600, color: '#92400e', marginBottom: 2 },
  measuringBody:   { fontSize: 12, color: '#78350f', lineHeight: 1.5 },
  confoundBox:     { marginTop: 12, padding: '10px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6 },
  confoundTitle:   { fontSize: 12, color: '#92400e', lineHeight: 1.5, margin: 0 },
  confoundDetail:  { fontSize: 12, color: '#78350f', marginTop: 4, marginBottom: 0, lineHeight: 1.4 },
  exposureBox:     { marginTop: 16, padding: '10px 12px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6 },
  exposureTitle:   { fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.05em', color: '#9ca3af', marginBottom: 8, marginTop: 0 },
  exposureRow:     { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6b7280', marginBottom: 4, lineHeight: 1.5 },
  decisionBadge:   { display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10, border: '1px solid', marginBottom: 10 },
  funnelDivider:   { height: 1, background: '#e5e7eb', margin: '8px 0' },
  funnelBlock:     { marginBottom: 6 },
  funnelLabel:     { fontSize: 11, fontWeight: 600, color: '#9ca3af', display: 'block', marginBottom: 2 },
  funnelSubRow:    { display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#6b7280', lineHeight: 1.5, paddingLeft: 4 },
};
