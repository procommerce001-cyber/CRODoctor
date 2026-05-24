'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiHeaders, API_BASE, issueLabel } from '@/lib/api';
import type { ActivityItem } from '@/lib/api';

const STATUS_COLOR: Record<string, string> = {
  applied:               '#4ade80',
  rolled_back:           '#6b7280',
  failed:                '#f87171',
  measured:              '#60a5fa',
  waiting_for_more_data: '#fbbf24',
};

const STATUS_LABEL: Record<string, string> = {
  applied:               'Live',
  rolled_back:           'Rolled back',
  failed:                'Failed',
  measured:              'Measured',
  waiting_for_more_data: 'Measuring impact',
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function RecentActivityList({ shop, items, selectedExecId, onSelect }: { shop: string; items: ActivityItem[]; selectedExecId?: string | null; onSelect?: (id: string) => void }) {
  const router = useRouter();
  const [isRollingBack,   setIsRollingBack]   = useState<Record<string, boolean>>({});
  const [rollbackError,   setRollbackError]   = useState<Record<string, string>>({});
  const [rollbackSuccess, setRollbackSuccess] = useState<Record<string, boolean>>({});

  const handleRollback = async (item: ActivityItem) => {
    const { executionId, productId, issueId } = item;
    setIsRollingBack(prev  => ({ ...prev,  [executionId]: true }));
    setRollbackError(prev  => ({ ...prev,  [executionId]: '' }));
    setRollbackSuccess(prev => ({ ...prev, [executionId]: false }));
    try {
      const res = await fetch(
        `${API_BASE}/action-center/products/${encodeURIComponent(productId)}/rollback`,
        {
          method:      'POST',
          credentials: 'include',
          headers:     apiHeaders({ 'Content-Type': 'application/json' }),
          body:        JSON.stringify({ shop, issueId }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      setRollbackError(prev  => ({ ...prev,  [executionId]: '' }));
      setRollbackSuccess(prev => ({ ...prev, [executionId]: true }));
      router.refresh();
    } catch (err) {
      setRollbackSuccess(prev => ({ ...prev, [executionId]: false }));
      setRollbackError(prev  => ({ ...prev,  [executionId]: err instanceof Error ? err.message : 'Rollback failed' }));
    } finally {
      setIsRollingBack(prev => ({ ...prev, [executionId]: false }));
    }
  };

  if (!items.length) {
    return <p style={styles.empty}>No activity yet — improvements will appear here once applied.</p>;
  }

  return (
    <section>
      <div style={styles.list}>
        {items.map((item) => (
          <div
            key={item.executionId}
            style={{
              ...styles.row,
              cursor: onSelect ? 'pointer' : 'default',
              ...(item.executionId === selectedExecId ? styles.rowSelected : {}),
            }}
            onClick={() => onSelect?.(item.executionId)}
          >
            <div style={styles.left}>
              {item.productTitle && <span style={styles.productTitle}>{item.productTitle}</span>}
              <span style={styles.issueId}>{issueLabel(item.issueId)}</span>
              {item.insight && <span style={styles.insight}>{item.insight}</span>}
              <LiftBadge item={item} />
              {(item.decisionSignal === 'revise' || item.decisionSignal === 'rollback_candidate') && (
                <DecisionTag signal={item.decisionSignal} />
              )}
            </div>
            <div style={styles.right}>
              <span style={{ ...styles.statusBadge, color: STATUS_COLOR[item.status] ?? '#6b7280' }}>
                {STATUS_LABEL[item.status] ?? item.status}
              </span>
              <span style={styles.date}>{formatDate(item.createdAt)}</span>
              {item.status === 'applied' && (
                <>
                  <button
                    style={styles.rollbackBtn}
                    disabled={isRollingBack[item.executionId] || !!rollbackSuccess[item.executionId]}
                    onClick={(e) => { e.stopPropagation(); handleRollback(item); }}
                  >
                    {isRollingBack[item.executionId] ? 'Undoing…' : rollbackSuccess[item.executionId] ? 'Undone' : 'Undo change'}
                  </button>
                  {rollbackError[item.executionId] && (
                    <span style={styles.rollbackError}>{rollbackError[item.executionId]}</span>
                  )}
                  {rollbackSuccess[item.executionId] && (
                    <span style={styles.rollbackSuccess}>Change undone — product restored</span>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// LiftBadge
//
// Publish rule:
//   show lift    — resultStatus === 'measured' AND confidence is low/medium/high
//   show pending — resultStatus === 'waiting_for_more_data'
//                  OR (measured AND confidence === 'insufficient')
//   show nothing — resultStatus === null (not applied / no measurement state)
//
// Wording is factual. No causation claim. No attribution language.
// ---------------------------------------------------------------------------
const DECISION_TAG: Record<string, { label: string; color: string; background: string; borderColor: string }> = {
  revise:             { label: 'Needs review',       color: '#fbbf24', background: 'rgba(251,191,36,0.08)',  borderColor: 'rgba(251,191,36,0.22)' },
  rollback_candidate: { label: 'Rollback candidate', color: '#fb923c', background: 'rgba(251,146,60,0.08)', borderColor: 'rgba(251,146,60,0.22)' },
};

function DecisionTag({ signal }: { signal: string }) {
  const cfg = DECISION_TAG[signal];
  if (!cfg) return null;
  return (
    <span style={{ ...liftStyles.badge, color: cfg.color, background: cfg.background, borderColor: cfg.borderColor }}>
      {cfg.label}
    </span>
  );
}

function LiftBadge({ item }: { item: ActivityItem }) {
  const { resultStatus, measurementConfidence, revenueChangePercent } = item;

  const publishable =
    resultStatus === 'measured' &&
    (measurementConfidence === 'low' ||
     measurementConfidence === 'medium' ||
     measurementConfidence === 'high');

  const windowClosed = resultStatus === 'measured' && measurementConfidence === 'insufficient';

  if (publishable && revenueChangePercent !== null) {
    const sign     = revenueChangePercent > 0 ? '+' : '';
    const pct      = Math.round(revenueChangePercent);
    const positive = revenueChangePercent > 0;
    const neutral  = revenueChangePercent === 0;
    const color    = neutral ? '#6b7280' : positive ? '#4ade80' : '#f87171';
    const bg       = neutral ? 'rgba(255,255,255,0.04)' : positive ? 'rgba(34,197,94,0.08)'  : 'rgba(239,68,68,0.08)';
    const border   = neutral ? 'rgba(255,255,255,0.08)' : positive ? 'rgba(34,197,94,0.22)'  : 'rgba(239,68,68,0.2)';
    return (
      <span style={{ ...liftStyles.badge, color, background: bg, borderColor: border }}>
        {sign}{pct}% revenue — 7-day after vs. before
      </span>
    );
  }

  if (windowClosed) {
    return (
      <span style={liftStyles.measuring}>
        Window complete — not enough orders to report a result
      </span>
    );
  }

  if (resultStatus === 'waiting_for_more_data') {
    return (
      <span style={liftStyles.measuring}>
        Measuring — 7-day window in progress
      </span>
    );
  }

  return null;
}

const liftStyles: Record<string, React.CSSProperties> = {
  badge:     { display: 'inline-block', marginTop: 4, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, border: '1px solid' },
  measuring: { display: 'inline-block', marginTop: 4, fontSize: 11, color: '#4b5563', fontStyle: 'italic' },
};

const styles: Record<string, React.CSSProperties> = {
  empty:         { color: '#4b5563', fontSize: 13 },
  list:          { display: 'flex', flexDirection: 'column', gap: 0, border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, overflow: 'hidden' },
  row:           { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '14px 18px', background: '#0f140f', borderBottom: '1px solid rgba(255,255,255,0.05)', gap: 12 },
  rowSelected:   { background: 'rgba(59,130,246,0.07)', borderLeft: '3px solid rgba(96,165,250,0.5)' },
  left:          { display: 'flex', flexDirection: 'column', gap: 3, flex: 1 },
  right:         { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 },
  productTitle:  { fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 1 },
  issueId:       { fontSize: 13, fontWeight: 600, color: '#e5e7eb' },
  insight:       { fontSize: 12, color: '#6b7280' },
  statusBadge:   { fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.06em' },
  date:          { fontSize: 11, color: '#4b5563' },
  rollbackBtn:     { fontSize: 11, padding: '3px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 4, background: 'rgba(255,255,255,0.04)', color: '#9ca3af', cursor: 'pointer' },
  rollbackError:   { fontSize: 11, color: '#f87171' },
  rollbackSuccess: { fontSize: 11, color: '#4ade80' },
};
