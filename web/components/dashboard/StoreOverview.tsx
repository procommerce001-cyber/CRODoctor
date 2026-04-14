import type { DashboardOverview } from '@/lib/api';

const stats: Array<{ key: keyof DashboardOverview; label: string }> = [
  { key: 'totalAppliedExecutions', label: 'Applied' },
  { key: 'measuredExecutions',     label: 'Measured' },
  { key: 'waitingExecutions',      label: 'Waiting' },
  { key: 'revenueUpCount',         label: 'Revenue ↑' },
  { key: 'revenueDownCount',       label: 'Revenue ↓' },
  { key: 'unitsSoldUpCount',       label: 'Units ↑' },
  { key: 'ordersUpCount',          label: 'Orders ↑' },
];

export default function StoreOverview({ overview }: { overview: DashboardOverview }) {
  return (
    <section>
      <h2 style={styles.heading}>Store Overview</h2>
      <div style={styles.grid}>
        {stats.map(({ key, label }) => (
          <div key={key} style={styles.card}>
            <div style={styles.value}>{overview[key] ?? 0}</div>
            <div style={styles.label}>{label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  heading: { fontSize: 16, fontWeight: 600, marginBottom: 12 },
  grid:    { display: 'flex', gap: 12, flexWrap: 'wrap' },
  card:    { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '14px 20px', minWidth: 110, textAlign: 'center' },
  value:   { fontSize: 28, fontWeight: 700, color: '#111827' },
  label:   { fontSize: 12, color: '#6b7280', marginTop: 4 },
};
