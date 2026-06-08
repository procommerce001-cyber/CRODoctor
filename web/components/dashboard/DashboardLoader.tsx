'use client';

import { useEffect, useState } from 'react';
import { fetchDashboard, fetchMe } from '@/lib/api';
import type { DashboardPayload } from '@/lib/api';
import DashboardClient from './DashboardClient';

// Client-side dashboard bootstrap.
// The API session cookie lives on the Render API domain and the dashboard is
// served from Vercel — a cross-site pair. The session cookie can only be sent
// by the *browser*, so identity (fetchMe) and data (fetchDashboard) must be
// fetched client-side with credentials:'include'. (A Server Component on Vercel
// has no access to the API-domain cookie.) UI/error markup mirrors the prior
// server-rendered page so behavior is unchanged.

type LoadState =
  | { status: 'loading' }
  | { status: 'no-shop' }
  | { status: 'error'; message: string }
  | { status: 'api-error'; shop: string }
  | { status: 'ready'; data: DashboardPayload };

export default function DashboardLoader() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me   = await fetchMe();
      const shop = me?.shopDomain ?? process.env.NEXT_PUBLIC_SHOP ?? '';
      if (!shop) {
        if (!cancelled) setState({ status: 'no-shop' });
        return;
      }
      try {
        const data = await fetchDashboard(shop);
        if (cancelled) return;
        setState(data.success ? { status: 'ready', data } : { status: 'api-error', shop });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', message: String(err) });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (state.status === 'loading') {
    return (
      <div style={styles.shell}>
        <div style={styles.loading}>Loading dashboard…</div>
      </div>
    );
  }

  if (state.status === 'no-shop') {
    return (
      <div style={styles.shell}>
        <div style={styles.error}>Shop could not be resolved. Complete the Shopify install or set NEXT_PUBLIC_SHOP for local dev.</div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div style={styles.shell}>
        <div style={styles.error}>
          Failed to load dashboard. Check that the API is running and NEXT_PUBLIC_API_BASE_URL is correct.
          <br />
          <code style={{ fontSize: 12, color: '#4b5563' }}>{state.message}</code>
        </div>
      </div>
    );
  }

  if (state.status === 'api-error') {
    return (
      <div style={styles.shell}>
        <div style={styles.error}>API returned an error for shop: {state.shop}</div>
      </div>
    );
  }

  const { data } = state;
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
  loading:  {
    padding:    32,
    color:      '#9ca3af',
    fontFamily: 'sans-serif',
    fontSize:   14,
  },
  error:    {
    padding:    32,
    color:      '#f87171',
    fontFamily: 'sans-serif',
    fontSize:   14,
  },
};
