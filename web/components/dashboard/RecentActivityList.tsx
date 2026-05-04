'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiHeaders, API_BASE, issueLabel } from '@/lib/api';
import type { ActivityItem } from '@/lib/api';

const SHOP = process.env.NEXT_PUBLIC_SHOP ?? '';

const STATUS_COLOR: Record<string, string> = {
  applied:               '#16a34a',
  rolled_back:           '#9ca3af',
  failed:                '#dc2626',
  measured:              '#2563eb',
  waiting_for_more_data: '#d97706',
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

export default function RecentActivityList({ items, selectedExecId, onSelect }: { items: ActivityItem[]; selectedExecId?: string | null; onSelect?: (id: string) => void }) {
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
          body:        JSON.stringify({ shop: SHOP, issueId }),
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
    return (
      <section>
        <h2 style={styles.heading}>Recent Activity</h2>
        <p style={styles.empty}>No recent activity.</p>
      </section>
    );
  }

  return (
    <section>
      <h2 style={styles.heading}>Recent Activity</h2>
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
            </div>
            <div style={styles.right}>
              <span style={{ ...styles.statusBadge, color: STATUS_COLOR[item.status] ?? '#374151' }}>
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
    const color    = neutral ? '#6b7280' : positive ? '#166534' : '#dc2626';
    const bg       = neutral ? '#f3f4f6' : positive ? '#dcfce7'  : '#fee2e2';
    const border   = neutral ? '#e5e7eb' : positive ? '#bbf7d0'  : '#fecaca';
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
  badge:     { display: 'inline-block', marginTop: 4, fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 4, border: '1px solid' },
  measuring: { display: 'inline-block', marginTop: 4, fontSize: 11, color: '#9ca3af', fontStyle: 'italic' },
};

const styles: Record<string, React.CSSProperties> = {
  heading:     { fontSize: 16, fontWeight: 600, marginBottom: 12 },
  empty:       { color: '#9ca3af', fontSize: 14 },
  list:        { display: 'flex', flexDirection: 'column', gap: 1, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' },
  row:         { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '12px 16px', background: '#fff', borderBottom: '1px solid #f3f4f6', gap: 12 },
  rowSelected: { background: '#eff6ff', borderLeft: '3px solid #2563eb' },
  left:        { display: 'flex', flexDirection: 'column', gap: 3, flex: 1 },
  right:       { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 },
  productTitle:{ fontSize: 12, color: '#6b7280', marginBottom: 1 },
  issueId:     { fontSize: 13, fontWeight: 600, color: '#111827' },
  insight:     { fontSize: 12, color: '#6b7280' },
  statusBadge: { fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const },
  date:        { fontSize: 11, color: '#9ca3af' },
  rollbackBtn:   { fontSize: 11, padding: '2px 8px', border: '1px solid #e5e7eb', borderRadius: 4, background: '#fff', color: '#374151', cursor: 'pointer' },
  rollbackError:   { fontSize: 11, color: '#dc2626' },
  rollbackSuccess: { fontSize: 11, color: '#16a34a' },
};
