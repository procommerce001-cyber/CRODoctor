import type { TopWin } from '@/lib/api';

function pct(v: number | null) {
  if (v === null) return '—';
  return `${v > 0 ? '+' : ''}${v}%`;
}

function pctColor(v: number | null): string {
  if (v === null) return '#6b7280';
  return v > 0 ? '#16a34a' : v < 0 ? '#dc2626' : '#6b7280';
}

export default function TopWinsList({ items }: { items: TopWin[] }) {
  if (!items.length) {
    return (
      <section>
        <h2 style={styles.heading}>Top Wins</h2>
        <p style={styles.empty}>No measured wins yet.</p>
      </section>
    );
  }

  return (
    <section>
      <h2 style={styles.heading}>Top Wins</h2>
      <div style={styles.list}>
        {items.map((win) => (
          <div key={win.executionId} style={styles.card}>
            <div style={styles.issueId}>{win.issueId}</div>
            <div style={styles.metrics}>
              <span style={{ color: pctColor(win.revenueChangePercent) }}>
                Revenue {pct(win.revenueChangePercent)}
              </span>
              <span style={{ color: pctColor(win.unitsSoldChangePercent) }}>
                Units {pct(win.unitsSoldChangePercent)}
              </span>
              <span style={{ color: pctColor(win.ordersChangePercent) }}>
                Orders {pct(win.ordersChangePercent)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  heading: { fontSize: 16, fontWeight: 600, marginBottom: 12 },
  empty:   { color: '#9ca3af', fontSize: 14 },
  list:    { display: 'flex', flexDirection: 'column', gap: 8 },
  card:    { background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '12px 16px' },
  issueId: { fontSize: 13, fontWeight: 600, color: '#111827', marginBottom: 6 },
  metrics: { display: 'flex', gap: 20, fontSize: 13, fontWeight: 500 },
};
