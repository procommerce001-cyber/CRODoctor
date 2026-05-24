import type { TopWin } from '@/lib/api';
import { issueLabel } from '@/lib/api';

function pct(v: number | null) {
  if (v === null) return '—';
  return `${v > 0 ? '+' : ''}${v}%`;
}

function pctColor(v: number | null): string {
  if (v === null) return '#4b5563';
  return v > 0 ? '#4ade80' : v < 0 ? '#f87171' : '#6b7280';
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
            <div style={styles.issueId}>{issueLabel(win.issueId)}</div>
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
  heading: { fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' as const, color: '#6b7280', marginBottom: 10 },
  empty:   { color: '#4b5563', fontSize: 13 },
  list:    { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 },
  card:    { background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.14)', borderRadius: 8, padding: '12px 18px' },
  issueId: { fontSize: 13, fontWeight: 600, color: '#e5e7eb', marginBottom: 6 },
  metrics: { display: 'flex', gap: 20, fontSize: 12, fontWeight: 600 },
};
