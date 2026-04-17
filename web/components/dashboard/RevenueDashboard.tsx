'use client';

import { useState, useEffect, useRef }             from 'react';
import type { RevenueDashboardData, RecentImpact } from '@/lib/api';
import { fetchRevenueDashboard }                   from '@/lib/api';

interface Props { shop: string }

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
function fmtHeroMoney(n: number) {
  return `+$${Math.round(n).toLocaleString()}`;
}

function fmtDeltaMoney(n: number) {
  const abs = Math.round(Math.abs(n));
  return `${n >= 0 ? '+' : '−'}$${abs.toLocaleString()}`;
}

function fmtPct(n: number | null) {
  if (n === null) return null;
  return `${n >= 0 ? '+' : ''}${Math.round(n)}%`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// useCountUp — animates from 0 to target over `duration` ms (ease-out cubic)
// ---------------------------------------------------------------------------
function useCountUp(target: number, duration = 1400): number {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (target === 0) { setValue(0); return; }
    const start = performance.now();
    let raf: number;

    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);   // ease-out cubic
      setValue(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}

// ---------------------------------------------------------------------------
// KpiTile — one supporting metric
// ---------------------------------------------------------------------------
function KpiTile({
  value, label, positive,
}: {
  value: string;
  label: string;
  positive?: boolean;
}) {
  const valueColor = positive === false ? '#dc2626'
                   : positive === true  ? '#16a34a'
                   : '#111827';
  return (
    <div style={s.kpiTile}>
      <div style={{ ...s.kpiValue, color: valueColor }}>{value}</div>
      <div style={s.kpiLabel}>{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WinRow — one line in Recent wins
// ---------------------------------------------------------------------------
function WinRow({ item }: { item: RecentImpact }) {
  const pos = item.revenueDelta >= 0;
  return (
    <div style={s.winRow}>
      <span style={s.winProduct}>{item.productTitle}</span>
      <div style={s.winRight}>
        <span style={{ ...s.winDelta, color: pos ? '#16a34a' : '#dc2626' }}>
          {fmtDeltaMoney(item.revenueDelta)}
        </span>
        {item.ordersDelta !== 0 && (
          <span style={s.winOrders}>
            {item.ordersDelta > 0 ? '+' : ''}{item.ordersDelta} orders
          </span>
        )}
        <span style={s.winDate}>{fmtDate(item.executedAt)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RevenueDashboard
// ---------------------------------------------------------------------------
const POLL_MS = 45_000;

export default function RevenueDashboard({ shop }: Props) {
  const [data,        setData]        = useState<RevenueDashboardData | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [justUpdated, setJustUpdated] = useState(false);
  const prevRevenue                   = useRef<number | null>(null);

  // Initial fetch
  useEffect(() => {
    fetchRevenueDashboard(shop)
      .then(d => { setData(d); if (d) prevRevenue.current = d.totalRevenueImpact; })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [shop]);

  // Polling — 45 s interval, silent unless value changed
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const fresh = await fetchRevenueDashboard(shop);
        if (!fresh) return;
        const changed = fresh.totalRevenueImpact !== prevRevenue.current;
        if (changed) {
          prevRevenue.current = fresh.totalRevenueImpact;
          setData(fresh);          // triggers count-up via new target
          setJustUpdated(true);
          setTimeout(() => setJustUpdated(false), 6_000);
        }
      } catch {}
    }, POLL_MS);

    return () => clearInterval(id);
  }, [shop]);

  if (loading) return null;

  // ── Empty state ────────────────────────────────────────────────────────────
  if (!data || data.empty) {
    return (
      <section style={s.wrap}>
        <div style={s.emptyState}>
          <div style={s.emptyIcon}>$</div>
          <div style={s.emptyHeadline}>No revenue impact tracked yet</div>
          <div style={s.emptyBody}>
            Apply your first fix to start generating measurable impact
          </div>
        </div>
      </section>
    );
  }

  const {
    totalRevenueImpact, revenueGrowthPercent, ordersGrowthPercent,
    aovChangePercent, productsImproved, executionsCount, recentImpacts,
  } = data;

  // ── Count-up animation ────────────────────────────────────────────────────
  const animatedRevenue = useCountUp(totalRevenueImpact);

  // ── Today's activity — derived from recentImpacts, no new API ────────────
  const todayStr = new Date().toDateString();
  const todayItems = recentImpacts.filter(
    i => new Date(i.executedAt).toDateString() === todayStr
  );
  const todayRevenue     = todayItems.reduce((sum, i) => sum + i.revenueDelta, 0);
  const hasActivityToday = todayItems.length > 0;

  // Collect KPIs — only include metrics that have data
  const kpis: { value: string; label: string; positive?: boolean }[] = [];
  if (revenueGrowthPercent !== null) kpis.push({ value: fmtPct(revenueGrowthPercent)!, label: 'Conversion uplift',   positive: revenueGrowthPercent >= 0 });
  if (aovChangePercent     !== null) kpis.push({ value: fmtPct(aovChangePercent)!,     label: 'Avg. order value',   positive: aovChangePercent     >= 0 });
  if (ordersGrowthPercent  !== null) kpis.push({ value: fmtPct(ordersGrowthPercent)!,  label: 'Orders growth',      positive: ordersGrowthPercent  >= 0 });
  kpis.push({ value: String(productsImproved), label: `Product${productsImproved === 1 ? '' : 's'} improved` });

  return (
    <section style={s.wrap}>

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <div style={s.heroSection}>
        <div style={s.heroEyebrowRow}>
          <span style={s.heroEyebrow}>Revenue impact</span>
          {hasActivityToday && (
            <span style={s.liveDot}>
              <span style={s.livePulse} />
              Live
            </span>
          )}
          {justUpdated && (
            <span style={s.updatedLabel}>Updated just now</span>
          )}
        </div>
        <div style={s.heroNumber}>{fmtHeroMoney(animatedRevenue)}</div>
        <div style={s.heroSubline}>Revenue generated from applied improvements</div>
        {todayRevenue > 0 && (
          <div style={s.todayLine}>
            Today: <strong>{fmtDeltaMoney(todayRevenue)}</strong>
          </div>
        )}
        <div style={s.trustLine}>Based on real changes applied to your store</div>
      </div>

      {/* ── KPI grid ──────────────────────────────────────────────────────── */}
      <div style={s.kpiGrid}>
        {kpis.map((k, i) => (
          <KpiTile key={i} value={k.value} label={k.label} positive={k.positive} />
        ))}
      </div>

      {/* ── Recent wins ───────────────────────────────────────────────────── */}
      {recentImpacts.length > 0 && (
        <div style={s.winsSection}>
          <div style={s.winsSectionLabel}>Recent wins</div>
          <div style={s.winsList}>
            {recentImpacts.map((item, i) => (
              <WinRow key={i} item={item} />
            ))}
          </div>
        </div>
      )}

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <div style={s.footer}>
        {executionsCount} change{executionsCount === 1 ? '' : 's'} measured
      </div>

    </section>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const s: Record<string, React.CSSProperties> = {

  // Shell
  wrap: {
    background:   '#fff',
    border:       '1px solid #e5e7eb',
    borderRadius: 12,
    overflow:     'hidden',
  },

  // Hero block — light green wash, full width
  heroSection: {
    padding:    '28px 28px 24px',
    background: '#f0fdf4',
    borderBottom: '1px solid #dcfce7',
  },
  heroEyebrowRow: {
    display:       'flex',
    alignItems:    'center',
    gap:           10,
    marginBottom:  10,
  },
  heroEyebrow: {
    fontSize:      11,
    fontWeight:    600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color:         '#16a34a',
  },
  liveDot: {
    display:       'flex',
    alignItems:    'center',
    gap:           5,
    fontSize:      10,
    fontWeight:    700,
    color:         '#16a34a',
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
  },
  livePulse: {
    display:      'inline-block',
    width:        7,
    height:       7,
    borderRadius: '50%',
    background:   '#16a34a',
    boxShadow:    '0 0 0 2px #bbf7d0',
    flexShrink:   0,
  },
  updatedLabel: {
    fontSize:   10,
    fontWeight: 500,
    color:      '#16a34a',
    opacity:    0.7,
  },
  todayLine: {
    fontSize:     13,
    color:        '#166534',
    marginBottom: 6,
    marginTop:    4,
  },
  heroNumber: {
    fontSize:      56,
    fontWeight:    800,
    color:         '#14532d',
    letterSpacing: '-0.04em',
    lineHeight:    1,
    marginBottom:  10,
  },
  heroSubline: {
    fontSize:   14,
    fontWeight: 500,
    color:      '#166534',
    marginBottom: 6,
  },
  trustLine: {
    fontSize: 11,
    color:    '#86efac',
  },

  // KPI row
  kpiGrid: {
    display:       'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    borderBottom:  '1px solid #f3f4f6',
  },
  kpiTile: {
    padding:      '20px 20px 18px',
    borderRight:  '1px solid #f3f4f6',
  },
  kpiValue: {
    fontSize:      28,
    fontWeight:    800,
    letterSpacing: '-0.03em',
    lineHeight:    1,
    marginBottom:  5,
  },
  kpiLabel: {
    fontSize:      11,
    color:         '#9ca3af',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    lineHeight:    1.3,
  },

  // Recent wins
  winsSection: {
    padding: '20px 24px',
    borderBottom: '1px solid #f9fafb',
  },
  winsSectionLabel: {
    fontSize:      10,
    fontWeight:    700,
    color:         '#d1d5db',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    marginBottom:  10,
  },
  winsList: {
    display:       'flex',
    flexDirection: 'column' as const,
    gap:           2,
  },
  winRow: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
    padding:        '7px 0',
    borderBottom:   '1px solid #f9fafb',
  },
  winProduct: {
    fontSize:     13,
    color:        '#374151',
    flex:         1,
    minWidth:     0,
    overflow:     'hidden',
    textOverflow: 'ellipsis',
    whiteSpace:   'nowrap' as const,
  },
  winRight: {
    display:    'flex',
    alignItems: 'center',
    gap:        10,
    flexShrink: 0,
  },
  winDelta:  { fontSize: 13, fontWeight: 700 },
  winOrders: { fontSize: 12, color: '#9ca3af' },
  winDate:   { fontSize: 11, color: '#d1d5db' },

  // Footer
  footer: {
    padding:   '10px 24px',
    fontSize:  11,
    color:     '#e5e7eb',
    textAlign: 'right' as const,
  },

  // Empty state
  emptyState: {
    padding:   '40px 28px',
    textAlign: 'center' as const,
  },
  emptyIcon: {
    fontSize:     32,
    fontWeight:   800,
    color:        '#e5e7eb',
    marginBottom: 12,
  },
  emptyHeadline: {
    fontSize:     15,
    fontWeight:   600,
    color:        '#9ca3af',
    marginBottom: 6,
  },
  emptyBody: {
    fontSize: 13,
    color:    '#d1d5db',
  },
};
