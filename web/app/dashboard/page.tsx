import { cookies }         from 'next/headers';
import { fetchDashboard, fetchMe } from '@/lib/api';
import DashboardClient    from '@/components/dashboard/DashboardClient';

export default async function DashboardPage() {
  const cookieStore  = await cookies();
  const cookieHeader = cookieStore.getAll().map(c => `${c.name}=${c.value}`).join('; ');
  const me   = await fetchMe(cookieHeader);
  const shop = me?.shopDomain ?? process.env.NEXT_PUBLIC_SHOP ?? '';

  if (!shop) {
    return (
      <div style={styles.shell}>
        <div style={styles.error}>Shop could not be resolved. Complete the Shopify install or set NEXT_PUBLIC_SHOP for local dev.</div>
      </div>
    );
  }

  let data;
  try {
    data = await fetchDashboard(shop);
  } catch (err) {
    return (
      <div style={styles.shell}>
        <div style={styles.error}>
          Failed to load dashboard. Check that the API is running and NEXT_PUBLIC_API_BASE_URL is correct.
          <br />
          <code style={{ fontSize: 12, color: '#4b5563' }}>{String(err)}</code>
        </div>
      </div>
    );
  }

  if (!data.success) {
    return (
      <div style={styles.shell}>
        <div style={styles.error}>API returned an error for shop: {shop}</div>
      </div>
    );
  }

  return (
    <div style={styles.shell}>
      <main style={styles.main}>
        <header style={styles.header}>
          <div style={styles.brand}>
            <span style={styles.brandDot} />
            <h1 style={styles.title}>CRODoctor</h1>
          </div>
          <span style={styles.shop}>{data.shop}</span>
        </header>
        <DashboardClient data={data} />
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell:    {
    background: '#0c0e0c',
    minHeight:  '100vh',
    width:      '100%',
    borderTop:  '2px solid rgba(34,197,94,0.22)',
  },
  main:     {
    maxWidth:   1280,
    margin:     '0 auto',
    padding:    '0 40px 72px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    color:      '#f9fafb',
  },
  header:   {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    marginBottom:   28,
    padding:        '18px 0 16px',
    borderBottom:   '1px solid rgba(255,255,255,0.09)',
    position:       'sticky' as const,
    top:            0,
    zIndex:         20,
    background:     'rgba(12,14,12,0.97)',
    backdropFilter: 'blur(6px)',
  },
  brand:    { display: 'flex', alignItems: 'center', gap: 10 },
  brandDot: {
    width:        8,
    height:       8,
    borderRadius: '50%',
    background:   '#22c55e',
    flexShrink:   0,
    boxShadow:    '0 0 6px rgba(34,197,94,0.6)',
  },
  title:    {
    fontSize:      16,
    fontWeight:    800,
    margin:        0,
    letterSpacing: '-0.03em',
    color:         '#ffffff',
  },
  shop:     {
    fontSize:     11,
    color:        '#6b7280',
    background:   'rgba(255,255,255,0.05)',
    border:       '1px solid rgba(255,255,255,0.08)',
    borderRadius: 20,
    padding:      '4px 12px',
    letterSpacing:'0.02em',
  },
  error:    {
    padding:    32,
    color:      '#f87171',
    fontFamily: 'sans-serif',
    fontSize:   14,
  },
};
