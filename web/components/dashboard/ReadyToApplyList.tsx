import { useState } from 'react';
import type { ReviewItem, ContentPreview } from '@/lib/api';
import { fetchContentPreview, applySelected } from '@/lib/api';

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#65a30d',
};

interface PreviewState { loading: boolean; data: ContentPreview | null; error: string | null }
interface ApplyState   { applying: boolean; applied: boolean; error: string | null }

interface Props {
  shop: string;
  items: ReviewItem[];
  selected: Set<string>;
  isApplying: boolean;
  onToggle: (key: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onApply: () => void;
}

export default function ReadyToApplyList({
  shop, items, selected, isApplying, onToggle, onSelectAll, onClearSelection, onApply,
}: Props) {
  const selectableCount = items.filter(i => i.selectable).length;
  const [previews,    setPreviews]    = useState<Record<string, PreviewState>>({});
  const [applyStates, setApplyStates] = useState<Record<string, ApplyState>>({});

  async function handleSingleApply(item: ReviewItem, e: React.MouseEvent) {
    e.stopPropagation();
    const key = item.selectionKey;
    setApplyStates(s => ({ ...s, [key]: { applying: true, applied: false, error: null } }));
    try {
      const result = await applySelected(shop, [key]);
      const row    = result.results[0];
      if (row?.status === 'applied') {
        setApplyStates(s => ({ ...s, [key]: { applying: false, applied: true, error: null } }));
        setPreviews(p => { const n = { ...p }; delete n[key]; return n; });
      } else {
        setApplyStates(s => ({ ...s, [key]: { applying: false, applied: false, error: row?.reason ?? 'Apply did not succeed.' } }));
      }
    } catch (err) {
      setApplyStates(s => ({ ...s, [key]: { applying: false, applied: false, error: (err as Error).message } }));
    }
  }

  async function handlePreview(item: ReviewItem, e: React.MouseEvent) {
    e.stopPropagation();
    const key = item.selectionKey;
    if (previews[key]?.data) {
      // toggle off
      setPreviews(p => { const n = { ...p }; delete n[key]; return n; });
      return;
    }
    setPreviews(p => ({ ...p, [key]: { loading: true, data: null, error: null } }));
    try {
      const data = await fetchContentPreview(shop, item.productId, item.issueId);
      setPreviews(p => ({ ...p, [key]: { loading: false, data, error: null } }));
    } catch (err) {
      setPreviews(p => ({ ...p, [key]: { loading: false, data: null, error: (err as Error).message } }));
    }
  }

  return (
    <section>
      {/* Heading + summary bar */}
      <div style={styles.headingRow}>
        <h2 style={styles.heading}>
          Ready to Apply <span style={styles.badge}>{items.length}</span>
        </h2>
        <span style={styles.summary}>
          {selectableCount} action{selectableCount !== 1 ? 's' : ''} ready
          {' · '}
          <strong>{selected.size}</strong> selected
        </span>
      </div>

      {/* Controls */}
      <div style={styles.controls}>
        <button style={styles.btnSecondary} onClick={onSelectAll}  disabled={isApplying}>Select All</button>
        <button style={styles.btnSecondary} onClick={onClearSelection} disabled={isApplying}>Clear</button>
        <button
          style={{ ...styles.btnPrimary, opacity: (selected.size === 0 || isApplying) ? 0.4 : 1 }}
          onClick={onApply}
          disabled={selected.size === 0 || isApplying}
        >
          {isApplying ? 'Applying…' : `Apply Selected (${selected.size})`}
        </button>
      </div>

      {/* Table */}
      {items.length === 0 ? (
        <p style={styles.empty}>No actions ready to apply.</p>
      ) : (
        <div style={styles.table}>
          <div style={styles.headerRow}>
            <span />
            <span>Title</span>
            <span>Severity</span>
            <span>Score</span>
            <span>Risk</span>
            <span>Review</span>
            <span>Preview</span>
          </div>
          {items.map((item) => {
            const isChecked  = selected.has(item.selectionKey);
            const isDisabled = !item.selectable;
            const ps         = previews[item.selectionKey];
            const as         = applyStates[item.selectionKey];
            return (
              <div key={item.selectionKey}>
                <div
                  style={{ ...styles.row, background: isChecked ? '#f0fdf4' : '#fff', opacity: isDisabled ? 0.5 : 1 }}
                  onClick={() => !isDisabled && onToggle(item.selectionKey)}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={isDisabled}
                    onChange={() => onToggle(item.selectionKey)}
                    onClick={e => e.stopPropagation()}
                    style={{ cursor: isDisabled ? 'not-allowed' : 'pointer' }}
                  />
                  <span style={styles.title}>{item.title ?? item.issueId}</span>
                  <span style={{ ...styles.pill, color: SEVERITY_COLOR[item.severity] ?? '#374151' }}>
                    {item.severity}
                  </span>
                  <span style={styles.mono}>{item.score ?? '—'}</span>
                  <span style={styles.mono}>{item.riskLevel}</span>
                  <span style={styles.mono}>{item.reviewStatus}</span>
                  <button
                    style={{ ...styles.btnPreview, ...(ps?.data ? styles.btnPreviewActive : {}) }}
                    onClick={e => handlePreview(item, e)}
                    disabled={ps?.loading}
                  >
                    {ps?.loading ? '…' : ps?.data ? 'Hide' : 'Preview'}
                  </button>
                </div>
                {ps?.error && (
                  <div style={styles.previewPanel}>
                    <span style={{ color: '#dc2626' }}>{ps.error}</span>
                  </div>
                )}
                {as?.applied && (
                  <div style={{ ...styles.previewPanel, background: '#f0fdf4' }}>
                    <span style={{ color: '#16a34a', fontWeight: 600 }}>✓ Fix applied successfully.</span>
                  </div>
                )}
                {ps?.data && !as?.applied && (
                  <div style={styles.previewPanel}>
                    <div style={styles.previewMeta}>
                      <span>Mode: <strong>{ps.data.patchMode ?? '—'}</strong></span>
                      <span>Safety: <strong style={{ color: ps.data.patchSafety === 'high' ? '#16a34a' : '#d97706' }}>{ps.data.patchSafety ?? '—'}</strong></span>
                      {ps.data.diffSummary && <span>{ps.data.diffSummary.note}</span>}
                    </div>
                    {ps.data.eligibleToApply ? (
                      <>
                        <div style={styles.previewContent}>
                          <div style={styles.previewLabel}>Proposed content</div>
                          <div style={styles.previewText}>{ps.data.proposedContent}</div>
                        </div>
                        <div style={styles.previewActions}>
                          <button
                            style={{ ...styles.btnApprove, opacity: as?.applying ? 0.6 : 1 }}
                            onClick={e => handleSingleApply(item, e)}
                            disabled={as?.applying}
                          >
                            {as?.applying ? 'Applying…' : 'Approve & Apply this fix'}
                          </button>
                          <button
                            style={styles.btnCancel}
                            onClick={e => { e.stopPropagation(); setPreviews(p => { const n = { ...p }; delete n[item.selectionKey]; return n; }); }}
                            disabled={as?.applying}
                          >
                            Cancel
                          </button>
                          {as?.error && <span style={{ color: '#dc2626', fontSize: 12 }}>{as.error}</span>}
                        </div>
                      </>
                    ) : (
                      <div style={{ color: '#dc2626', fontSize: 12 }}>Blocked: {ps.data.blockReason}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  headingRow:       { display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 10 },
  heading:          { fontSize: 16, fontWeight: 600, margin: 0 },
  badge:            { background: '#dcfce7', color: '#166534', borderRadius: 12, padding: '1px 8px', fontSize: 12, fontWeight: 600, marginLeft: 8 },
  summary:          { fontSize: 13, color: '#6b7280' },
  controls:         { display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' },
  btnSecondary:     { fontSize: 12, padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#374151' },
  btnPrimary:       { fontSize: 12, padding: '4px 14px', border: 'none', borderRadius: 6, background: '#16a34a', color: '#fff', cursor: 'pointer', fontWeight: 600, transition: 'opacity 0.15s' },
  btnPreview:       { fontSize: 11, padding: '3px 10px', border: '1px solid #d1d5db', borderRadius: 5, background: '#fff', cursor: 'pointer', color: '#374151', whiteSpace: 'nowrap' },
  btnPreviewActive: { background: '#eff6ff', borderColor: '#3b82f6', color: '#1d4ed8' },
  empty:            { color: '#9ca3af', fontSize: 14 },
  table:            { border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' },
  headerRow:        { display: 'grid', gridTemplateColumns: '32px 2fr 1fr 1fr 1fr 1fr 72px', gap: 8, padding: '8px 16px', background: '#f9fafb', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' },
  row:              { display: 'grid', gridTemplateColumns: '32px 2fr 1fr 1fr 1fr 1fr 72px', gap: 8, padding: '10px 16px', borderTop: '1px solid #f3f4f6', fontSize: 13, alignItems: 'center', cursor: 'pointer' },
  title:            { color: '#111827', fontWeight: 500 },
  pill:             { fontWeight: 600, fontSize: 12 },
  mono:             { color: '#374151' },
  previewPanel:     { padding: '10px 16px 12px 48px', background: '#f8fafc', borderTop: '1px solid #e5e7eb', fontSize: 12 },
  previewMeta:      { display: 'flex', gap: 16, marginBottom: 8, color: '#6b7280', flexWrap: 'wrap' },
  previewContent:   {},
  previewLabel:     { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', marginBottom: 4 },
  previewText:      { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: '8px 12px', color: '#111827', lineHeight: 1.5, whiteSpace: 'pre-wrap' },
  previewActions:   { display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' },
  btnApprove:       { fontSize: 12, padding: '5px 14px', border: 'none', borderRadius: 6, background: '#16a34a', color: '#fff', cursor: 'pointer', fontWeight: 600 },
  btnCancel:        { fontSize: 12, padding: '5px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#374151' },
};
