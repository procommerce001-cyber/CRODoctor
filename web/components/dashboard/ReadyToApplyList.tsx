import type { ReviewItem } from '@/lib/api';

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#65a30d',
};

interface Props {
  items: ReviewItem[];
  selected: Set<string>;
  isApplying: boolean;
  onToggle: (key: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onApply: () => void;
}

export default function ReadyToApplyList({
  items, selected, isApplying, onToggle, onSelectAll, onClearSelection, onApply,
}: Props) {
  const selectableCount = items.filter(i => i.selectable).length;

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
          </div>
          {items.map((item) => {
            const isChecked  = selected.has(item.selectionKey);
            const isDisabled = !item.selectable;
            return (
              <div
                key={item.selectionKey}
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
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  headingRow:  { display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 10 },
  heading:     { fontSize: 16, fontWeight: 600, margin: 0 },
  badge:       { background: '#dcfce7', color: '#166534', borderRadius: 12, padding: '1px 8px', fontSize: 12, fontWeight: 600, marginLeft: 8 },
  summary:     { fontSize: 13, color: '#6b7280' },
  controls:    { display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' },
  btnSecondary:{ fontSize: 12, padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#374151' },
  btnPrimary:  { fontSize: 12, padding: '4px 14px', border: 'none', borderRadius: 6, background: '#16a34a', color: '#fff', cursor: 'pointer', fontWeight: 600, transition: 'opacity 0.15s' },
  empty:       { color: '#9ca3af', fontSize: 14 },
  table:       { border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' },
  headerRow:   { display: 'grid', gridTemplateColumns: '32px 2fr 1fr 1fr 1fr 1fr', gap: 8, padding: '8px 16px', background: '#f9fafb', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' },
  row:         { display: 'grid', gridTemplateColumns: '32px 2fr 1fr 1fr 1fr 1fr', gap: 8, padding: '10px 16px', borderTop: '1px solid #f3f4f6', fontSize: 13, alignItems: 'center', cursor: 'pointer' },
  title:       { color: '#111827', fontWeight: 500 },
  pill:        { fontWeight: 600, fontSize: 12 },
  mono:        { color: '#374151' },
};
