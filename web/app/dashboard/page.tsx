import { cookies }         from 'next/headers';
import { fetchDashboard, fetchMe } from '@/lib/api';
import DashboardClient    from '@/components/dashboard/DashboardClient';

export default async function DashboardPage() {
  // Resolve shop at runtime: session cookie (production) → NEXT_PUBLIC_SHOP (dev fallback)
  const cookieStore  = await cookies();
  const cookieHeader = cookieStore.getAll().map(c => `${c.name}=${c.value}`).join('; ');
  const me   = await fetchMe(cookieHeader);
  const shop = me?.shopDomain ?? process.env.NEXT_PUBLIC_SHOP ?? '';

  if (!shop) {
    return <div style={styles.error}>Shop could not be resolved. Complete the Shopify install or set NEXT_PUBLIC_SHOP for local dev.</div>;
  }

  let data;
  try {
    data = await fetchDashboard(shop);
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
    return <div style={styles.error}>API returned an error for shop: {shop}</div>;
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
  main:     { maxWidth: 960, margin: '0 auto', padding: '24px 24px 40px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', color: '#111827' },
  header:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, borderBottom: '1px solid #f3f4f6', paddingBottom: 16 },
  title:    { fontSize: 17, fontWeight: 800, margin: 0, letterSpacing: '-0.025em', color: '#111827' },
  shop:     { fontSize: 11, color: '#9ca3af', background: '#f9fafb', border: '1px solid #f3f4f6', borderRadius: 20, padding: '4px 12px', letterSpacing: '0.01em' },
  sections: { display: 'flex', flexDirection: 'column', gap: 40 },
  error:    { padding: 32, color: '#dc2626', fontFamily: 'sans-serif', fontSize: 14 },
};
