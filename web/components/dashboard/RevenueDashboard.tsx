'use client';

import { useState, useEffect, useRef } from 'react';
import type { RevenueDashboardData, RecentImpact } from '@/lib/api';
import { fetchRevenueDashboard } from '@/lib/api';

interface Props { shop: string }

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------
function fmtMoney(n: number) {
  const abs = Math.round(Math.abs(n));
  return `${n >= 0 ? '+' : '−'}$${abs.toLocaleString()}`;
}
function fmtHeroMoney(n: number) {
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
// useCountUp
// ---------------------------------------------------------------------------
function useCountUp(target: number, duration = 1200): number {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (target === 0) { setValue(0); return; }
    const start = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      setValue(Math.round(target * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

// ---------------------------------------------------------------------------
// KPIStrip — compact tile row directly below the hero
// ---------------------------------------------------------------------------
function KPIStrip({
  executionsCount,
  measuredCount,
  ordersGrowthPercent,
  unitsSoldGrowthPercent,
  avgRevenuePerExecution,
}: Pick<RevenueDashboardData,
  'executionsCount' | 'measuredCount' | 'ordersGrowthPercent' | 'unitsSoldGrowthPercent' | 'avgRevenuePerExecution'
>) {
  const tiles: Array<{ value: string; label: string; color: string }> = [
    {
      value: String(executionsCount),
      label: 'Changes applied',
      color: '#111827',
    },
    {
      value: String(measuredCount),
      label: 'Measured',
      color: measuredCount > 0 ? '#16a34a' : '#9ca3af',
    },
    ...(ordersGrowthPercent !== null ? [{
      value: fmtPct(ordersGrowthPercent)!,
      label: 'Orders growth',
      color: ordersGrowthPercent >= 0 ? '#16a34a' : '#dc2626',
    }] : []),
    ...(unitsSoldGrowthPercent !== null ? [{
      value: fmtPct(unitsSoldGrowthPercent)!,
      label: 'Units growth',
      color: unitsSoldGrowthPercent >= 0 ? '#16a34a' : '#dc2626',
    }] : []),
    ...(avgRevenuePerExecution !== null && avgRevenuePerExecution > 0 ? [{
      value: `+$${Math.round(avgRevenuePerExecution).toLocaleString()}`,
      label: 'Avg revenue / execution',
      color: '#16a34a',
    }] : []),
  ];

  return (
    <div style={s.kpiStrip}>
      {tiles.map((tile, i) => (
        <div
          key={i}
          style={{ ...s.kpiTile, borderRight: i < tiles.length - 1 ? '1px solid #f3f4f6' : 'none' }}
        >
          <div style={{ ...s.kpiTileVal, color: tile.color }}>{tile.value}</div>
          <div style={s.kpiTileLbl}>{tile.label}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TopWinRow — ranked card for the top wins section
// ---------------------------------------------------------------------------
function TopWinRow({ item, rank }: { item: RecentImpact; rank: number }) {
  const positive = item.revenueDelta >= 0;
  return (
    <div style={s.topWinRow}>
      <div style={s.topWinRank}>#{rank}</div>
      <div style={s.topWinBody}>
        <div style={s.topWinProduct}>{item.productTitle}</div>
        <div style={s.topWinMeta}>
          {item.ordersDelta !== 0 && (
            <span style={s.topWinPill}>
              {item.ordersDelta > 0 ? '+' : ''}{item.ordersDelta} orders
            </span>
          )}
          {item.unitsSoldDelta !== 0 && (
            <span style={{ ...s.topWinPill, color: '#a78bfa' }}>
              {item.unitsSoldDelta > 0 ? '+' : ''}{item.unitsSoldDelta} units
            </span>
          )}
          {item.roi > 0 && (
            <span style={s.topWinRoiBadge}>${Math.round(item.roi)} ROI</span>
          )}
        </div>
      </div>
      <div style={{ ...s.topWinDelta, color: positive ? '#16a34a' : '#dc2626' }}>
        {fmtMoney(item.revenueDelta)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RecentActivityRow — lightweight chronological row
// ---------------------------------------------------------------------------
function RecentActivityRow({ item }: { item: RecentImpact }) {
  const positive = item.revenueDelta >= 0;
  return (
    <div style={s.actRow}>
      <div style={s.actLeft}>
        <span style={s.actProduct}>{item.productTitle}</span>
        <span style={s.actDate}>{fmtDate(item.executedAt)}</span>
      </div>
      <div style={s.actRight}>
        {item.unitsSoldDelta !== 0 && (
          <span style={s.actUnits}>
            {item.unitsSoldDelta > 0 ? '+' : ''}{item.unitsSoldDelta} units
          </span>
        )}
        {item.ordersDelta !== 0 && (
          <span style={s.actOrders}>
            {item.ordersDelta > 0 ? '+' : ''}{item.ordersDelta} orders
          </span>
        )}
        {item.roi > 0 && (
          <span style={s.actRoi}>${Math.round(item.roi)} ROI</span>
        )}
        <span style={{ ...s.actDelta, color: positive ? '#16a34a' : '#dc2626' }}>
          {fmtMoney(item.revenueDelta)}
        </span>
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
  const [error,       setError]       = useState(false);
  const [justUpdated, setJustUpdated] = useState(false);
  const prevRevenue                   = useRef<number | null>(null);

  useEffect(() => {
    fetchRevenueDashboard(shop)
      .then(d => { setData(d); if (d) prevRevenue.current = d.totalRevenueImpact; })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [shop]);

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const fresh = await fetchRevenueDashboard(shop);
        if (!fresh) return;
        if (fresh.totalRevenueImpact !== prevRevenue.current) {
          prevRevenue.current = fresh.totalRevenueImpact;
          setData(fresh);
          setJustUpdated(true);
          setTimeout(() => setJustUpdated(false), 6_000);
        }
      } catch {}
    }, POLL_MS);
    return () => clearInterval(id);
  }, [shop]);

  if (loading) return <div style={s.skeleton} />;

  if (error || !data) {
    return (
      <section style={s.wrap}>
        <div style={s.errorState}>
          <div style={s.errorHeadline}>Could not load revenue data</div>
          <div style={s.errorBody}>Check your connection or reload the page</div>
        </div>
      </section>
    );
  }

  if (data.empty) {
    return (
      <section style={s.wrap}>
        <div style={s.emptyState}>
          <div style={s.emptyIcon}>$</div>
          <div style={s.emptyHeadline}>No revenue impact tracked yet</div>
          <div style={s.emptyBody}>Apply your first fix to start generating measurable impact</div>
        </div>
      </section>
    );
  }

  const {
    totalRevenueImpact, ordersGrowthPercent, unitsSoldGrowthPercent,
    executionsCount, measuredCount, avgRevenuePerExecution, recentImpacts, topWins,
  } = data;

  const animatedRevenue = useCountUp(totalRevenueImpact);

  return (
    <section style={s.wrap}>

      {/* ── Hero: Revenue impact ─────────────────────────────────────────── */}
      <div style={s.heroSection}>
        <div style={s.heroEyebrow}>
          Revenue impact
          {justUpdated && <span style={s.updatedBadge}>Updated</span>}
        </div>
        <div style={s.heroNumber}>{fmtHeroMoney(animatedRevenue)}</div>
        <div style={s.heroSub}>Measured revenue lift from all changes applied to your store</div>
      </div>

      {/* ── KPI strip ────────────────────────────────────────────────────── */}
      <KPIStrip
        executionsCount={executionsCount}
        measuredCount={measuredCount}
        ordersGrowthPercent={ordersGrowthPercent}
        unitsSoldGrowthPercent={unitsSoldGrowthPercent}
        avgRevenuePerExecution={avgRevenuePerExecution}
      />

      {/* ── Top wins ─────────────────────────────────────────────────────── */}
      {topWins.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionLabel}>Top wins by revenue</div>
          {[...topWins]
            .sort((a, b) => b.revenueDelta - a.revenueDelta)
            .map((item, i) => <TopWinRow key={i} item={item} rank={i + 1} />)}
        </div>
      )}

      {/* ── Recent activity ───────────────────────────────────────────────── */}
      {recentImpacts.length > 0 && (
        <div style={s.section}>
          <div style={s.sectionLabel}>Recent activity</div>
          {recentImpacts.map((item, i) => <RecentActivityRow key={i} item={item} />)}
        </div>
      )}

    </section>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const s: Record<string, React.CSSProperties> = {

  wrap: {
    background:   '#fff',
    border:       '1px solid #e5e7eb',
    borderRadius: 12,
    overflow:     'hidden',
  },

  skeleton: {
    background:   '#f9fafb',
    border:       '1px solid #e5e7eb',
    borderRadius: 12,
    minHeight:    220,
  },

  // Hero
  heroSection: {
    padding:      '24px 24px 20px',
    background:   '#f0fdf4',
    borderBottom: '1px solid #dcfce7',
  },
  heroEyebrow: {
    fontSize:      11,
    fontWeight:    700,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color:         '#16a34a',
    marginBottom:  6,
    display:       'flex',
    alignItems:    'center',
    gap:           8,
  },
  updatedBadge: {
    fontSize:     10,
    background:   '#dcfce7',
    color:        '#15803d',
    padding:      '2px 6px',
    borderRadius: 99,
  },
  heroNumber: {
    fontSize:      48,
    fontWeight:    800,
    color:         '#14532d',
    letterSpacing: '-0.04em',
    lineHeight:    1,
    marginBottom:  6,
  },
  heroSub: {
    fontSize: 12,
    color:    '#166534',
  },

  // KPI strip
  kpiStrip: {
    display:      'flex',
    borderBottom: '1px solid #f3f4f6',
  },
  kpiTile: {
    flex:    1,
    padding: '14px 20px',
  },
  kpiTileVal: {
    fontSize:      20,
    fontWeight:    800,
    letterSpacing: '-0.02em',
    lineHeight:    1,
    marginBottom:  4,
  },
  kpiTileLbl: {
    fontSize:      10,
    color:         '#9ca3af',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },

  // Top win rows
  topWinRow: {
    display:    'flex',
    alignItems: 'center',
    gap:        12,
    padding:    '10px 0',
    borderBottom: '1px solid #f9fafb',
  },
  topWinRank: {
    fontSize:   11,
    fontWeight: 700,
    color:      '#d1d5db',
    width:      20,
    flexShrink: 0,
  },
  topWinBody: {
    flex:     1,
    minWidth: 0,
  },
  topWinProduct: {
    fontSize:     13,
    fontWeight:   600,
    color:        '#111827',
    overflow:     'hidden',
    textOverflow: 'ellipsis',
    whiteSpace:   'nowrap' as const,
    marginBottom: 3,
  },
  topWinMeta: {
    display:  'flex',
    gap:      6,
    flexWrap: 'wrap' as const,
  },
  topWinPill: {
    fontSize: 10,
    color:    '#9ca3af',
  },
  topWinRoiBadge: {
    fontSize:     10,
    color:        '#16a34a',
    background:   '#f0fdf4',
    padding:      '1px 5px',
    borderRadius: 4,
  },
  topWinDelta: {
    fontSize:   15,
    fontWeight: 800,
    flexShrink: 0,
  },

  // Sections (top wins / recent activity)
  section: {
    padding:      '16px 20px',
    borderBottom: '1px solid #f9fafb',
  },
  sectionLabel: {
    fontSize:      10,
    fontWeight:    700,
    color:         '#d1d5db',
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    marginBottom:  10,
  },

  // Recent activity rows
  actRow: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
    padding:        '8px 0',
    borderBottom:   '1px solid #f9fafb',
  },
  actLeft: {
    display:    'flex',
    alignItems: 'baseline',
    gap:        8,
    flex:       1,
    minWidth:   0,
    marginRight: 12,
  },
  actProduct: {
    fontSize:     12,
    fontWeight:   500,
    color:        '#6b7280',
    overflow:     'hidden',
    textOverflow: 'ellipsis',
    whiteSpace:   'nowrap' as const,
  },
  actDate: {
    fontSize:  10,
    color:     '#d1d5db',
    flexShrink: 0,
  },
  actRight: {
    display:    'flex',
    alignItems: 'center',
    gap:        6,
    flexShrink: 0,
  },
  actDelta:  { fontSize: 12, fontWeight: 600, color: '#374151' },
  actOrders: { fontSize: 10, color: '#9ca3af' },
  actUnits:  { fontSize: 10, color: '#c4b5fd' },
  actRoi:    { fontSize: 10, color: '#86efac', background: '#f0fdf4', padding: '1px 4px', borderRadius: 3 },

  // Error state
  errorState: {
    padding:   '36px 28px',
    textAlign: 'center' as const,
  },
  errorHeadline: {
    fontSize:     14,
    fontWeight:   600,
    color:        '#b45309',
    marginBottom: 4,
  },
  errorBody: {
    fontSize: 12,
    color:    '#d97706',
  },

  // Empty state
  emptyState: {
    padding:   '44px 28px',
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
