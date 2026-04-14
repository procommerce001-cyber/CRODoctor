import { fetchDashboard } from '@/lib/api';
import DashboardClient    from '@/components/dashboard/DashboardClient';

const SHOP = process.env.NEXT_PUBLIC_SHOP ?? '';

export default async function DashboardPage() {
  if (!SHOP) {
    return <div style={styles.error}>NEXT_PUBLIC_SHOP is not configured.</div>;
  }

  let data;
  try {
    data = await fetchDashboard(SHOP);
  } catch (err) {
    return (
      <div style={styles.error}>
        Failed to load dashboard. Check that the API is running and NEXT_PUBLIC_API_BASE_URL is correct.
        <br />
        <code style={{ fontSize: 12, color: '#9ca3af' }}>{String(err)}</code>
      </div>
    );
  }

  if (!data.success) {
    return <div style={styles.error}>API returned an error for shop: {SHOP}</div>;
  }

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.title}>CRO Doctor</h1>
        <span style={styles.shop}>{data.shop}</span>
      </header>
      <DashboardClient data={data} />
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main:     { maxWidth: 960, margin: '0 auto', padding: '32px 24px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: '#111827' },
  header:   { display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 32, borderBottom: '1px solid #e5e7eb', paddingBottom: 16 },
  title:    { fontSize: 22, fontWeight: 700, margin: 0 },
  shop:     { fontSize: 13, color: '#9ca3af' },
  sections: { display: 'flex', flexDirection: 'column', gap: 40 },
  error:    { padding: 32, color: '#dc2626', fontFamily: 'sans-serif', fontSize: 14 },
};
