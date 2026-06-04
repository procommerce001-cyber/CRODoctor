'use client';

import { useState } from 'react';
import { fetchRecommendations, issueLabel } from '@/lib/api';
import type { Recommendation, RecommendationStatus } from '@/lib/api';

// Display config per status group. Order here is the render order.
const GROUPS: { status: RecommendationStatus; label: string; hint: string }[] = [
  { status: 'ready_to_apply', label: 'Ready to apply',  hint: 'Reviewed and safe to apply now.' },
  { status: 'needs_review',   label: 'Needs review',    hint: 'Preview and review before applying.' },
  { status: 'manual_setup',   label: 'Manual setup',    hint: 'Open the product to configure manually.' },
  { status: 'measuring',      label: 'Measuring',       hint: 'Applied — currently measuring impact.' },
  { status: 'blocked',        label: 'Not available',   hint: 'Cannot be auto-applied right now.' },
];

export default function MoreRecommendations({
  shop,
  onOpen,
  onUndo,
}: {
  shop:   string;
  onOpen: (rec: Recommendation) => void;
  // Reuses the dashboard's existing rollback flow (rollbackAction). Resolves on success.
  onUndo: (productId: string, issueId: string) => Promise<void>;
}) {
  const [open,    setOpen]    = useState(false);
  const [phase,   setPhase]   = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [items,   setItems]   = useState<Recommendation[]>([]);
  const [error,   setError]   = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [undoingKey, setUndoingKey] = useState<string | null>(null);
  const [undoErrors, setUndoErrors] = useState<Record<string, string>>({});

  async function load() {
    setPhase('loading');
    try {
      const data = await fetchRecommendations(shop);
      setItems(data.items);
      setPhase('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recommendations');
      setPhase('error');
    }
  }

  async function handleToggle() {
    const next = !open;
    setOpen(next);
    // Lazy-load once on first expand.
    if (next && phase === 'idle') await load();
  }

  async function handleUndo(rec: Recommendation) {
    const key = `${rec.productId}::${rec.issueId}`;
    setConfirmKey(null);
    setUndoErrors(prev => { const n = { ...prev }; delete n[key]; return n; });
    setUndoingKey(key);
    try {
      await onUndo(rec.productId, rec.issueId);
      // Refresh the list so the reverted item leaves "Measuring".
      await load();
    } catch (err) {
      setUndoErrors(prev => ({ ...prev, [key]: err instanceof Error ? err.message : 'Undo failed' }));
    } finally {
      setUndoingKey(null);
    }
  }

  return (
    <section style={s.wrap}>
      <button style={s.toggle} onClick={handleToggle} aria-expanded={open}>
        <span>{open ? '▾' : '▸'} View more recommendations</span>
        {phase === 'ready' && <span style={s.count}>{items.length}</span>}
      </button>

      {open && (
        <div style={s.body}>
          {phase === 'loading' && <p style={s.muted}>Loading recommendations…</p>}

          {phase === 'error' && (
            <p style={s.error}>Couldn&apos;t load recommendations: {error}</p>
          )}

          {phase === 'ready' && items.length === 0 && (
            <p style={s.muted}>No additional recommendations are ready right now.</p>
          )}

          {phase === 'ready' && items.length > 0 && GROUPS.map(group => {
            const groupItems = items.filter(i => i.status === group.status);
            if (groupItems.length === 0) return null;
            return (
              <div key={group.status} style={s.group}>
                <div style={s.groupHead}>
                  <span style={s.groupLabel}>{group.label}</span>
                  <span style={s.groupCount}>{groupItems.length}</span>
                </div>
                <ul style={s.list}>
                  {groupItems.map(rec => {
                    const key        = `${rec.productId}::${rec.issueId}`;
                    const isMeasuring = rec.status === 'measuring';
                    const canUndo     = isMeasuring && rec.rollbackAvailable === true;
                    const isUndoing   = undoingKey === key;
                    const isConfirming = confirmKey === key;
                    return (
                      <li key={key} style={s.row}>
                        <div style={s.rowMain}>
                          <span style={s.rowTitle}>{rec.productTitle ?? '(untitled product)'}</span>
                          <span style={s.rowIssue}>
                            {issueLabel(rec.issueId)}
                            {rec.manualSetup && <span style={s.manualTag}>Manual</span>}
                          </span>
                          {rec.reason && <span style={s.reason}>{rec.reason}</span>}
                          {undoErrors[key] && <span style={s.error}>{undoErrors[key]}</span>}
                        </div>
                        {canUndo ? (
                          isConfirming ? (
                            <span style={s.confirmWrap}>
                              <button style={s.confirmBtn} disabled={isUndoing} onClick={() => handleUndo(rec)}>
                                {isUndoing ? 'Undoing…' : 'Confirm'}
                              </button>
                              <button style={s.cancelBtn} disabled={isUndoing} onClick={() => setConfirmKey(null)}>
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button style={s.undoBtn} onClick={() => setConfirmKey(key)}>
                              Undo
                            </button>
                          )
                        ) : rec.previewable ? (
                          <button style={s.reviewBtn} onClick={() => onOpen(rec)}>
                            {rec.status === 'ready_to_apply' ? 'Review' : 'Preview'}
                          </button>
                        ) : (
                          <span style={s.noAction}>{isMeasuring ? 'Measuring' : rec.manualSetup ? 'Manual' : '—'}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const s: Record<string, React.CSSProperties> = {
  wrap:       { marginTop: 8 },
  toggle:     { display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: '#d1d5db', fontSize: 13, fontWeight: 600, padding: '9px 14px', cursor: 'pointer' },
  count:      { fontSize: 11, fontWeight: 700, color: '#9ca3af', background: 'rgba(255,255,255,0.06)', borderRadius: 10, padding: '1px 8px' },
  body:       { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 16 },
  muted:      { fontSize: 12, color: '#9ca3af', margin: 0 },
  error:      { fontSize: 12, color: '#f87171', margin: 0 },
  group:      { display: 'flex', flexDirection: 'column', gap: 6 },
  groupHead:  { display: 'flex', alignItems: 'center', gap: 8 },
  groupLabel: { fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' as const, color: '#6b7280' },
  groupCount: { fontSize: 10, fontWeight: 700, color: '#9ca3af' },
  list:       { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  row:        { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 12px', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, background: 'rgba(255,255,255,0.02)' },
  rowMain:    { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  rowTitle:   { fontSize: 13, fontWeight: 600, color: '#e5e7eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  rowIssue:   { fontSize: 11, color: '#9ca3af', display: 'flex', alignItems: 'center', gap: 6 },
  manualTag:  { fontSize: 9, fontWeight: 700, color: '#fbbf24', background: 'rgba(251,191,36,0.12)', borderRadius: 4, padding: '1px 5px', textTransform: 'uppercase' as const },
  reason:     { fontSize: 11, color: '#6b7280' },
  reviewBtn:  { flexShrink: 0, background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.35)', borderRadius: 6, color: '#c7d2fe', fontSize: 12, fontWeight: 600, padding: '6px 14px', cursor: 'pointer' },
  noAction:   { flexShrink: 0, fontSize: 11, color: '#6b7280' },
  undoBtn:    { flexShrink: 0, background: 'transparent', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 6, color: '#d1d5db', fontSize: 12, fontWeight: 600, padding: '6px 14px', cursor: 'pointer' },
  confirmWrap:{ flexShrink: 0, display: 'flex', gap: 6 },
  confirmBtn: { background: 'rgba(248,113,113,0.15)', border: '1px solid rgba(248,113,113,0.4)', borderRadius: 6, color: '#fca5a5', fontSize: 12, fontWeight: 600, padding: '6px 12px', cursor: 'pointer' },
  cancelBtn:  { background: 'transparent', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, color: '#9ca3af', fontSize: 12, fontWeight: 600, padding: '6px 12px', cursor: 'pointer' },
};
