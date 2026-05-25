'use client';

import { useState, useEffect } from 'react';
import type { DashboardOverview, ReviewPayload, RevenueDashboardData } from '@/lib/api';
import { fetchRevenueDashboard } from '@/lib/api';

interface Props {
  shop:     string;
  overview: DashboardOverview;
  review:   ReviewPayload;
}

function fmtRevenue(n: number): string {
  const abs = Math.abs(n);
  const sign = n >= 0 ? '+' : '-';
  if (abs >= 1_000_000) return `${sign}£${(abs / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000)     return `${sign}£${(abs / 1_000).toFixed(1)}k`;
  return `${sign}£${Math.round(abs).toLocaleString()}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${Math.round(n)}%`;
}

// ── Hero number waterfall: show highest-value real signal available ──────────
function resolveHero(
  improved: number,
  waiting:  number,
  scanned:  number,
  liftPct:  number | null,
  revAdded: number | null,
  loading:  boolean,
): { value: string; label: string; sub: string | null; color: string } {

  if (!loading && revAdded !== null && Math.abs(revAdded) >= 1) {
    return {
      value: fmtRevenue(revAdded),
      label: revAdded >= 0 ? 'measured revenue impact' : 'revenue change measured',
      sub:   improved > 0 ? `${improved} improvement${improved !== 1 ? 's' : ''} live on store` : null,
      color: revAdded >= 0 ? '#4ade80' : '#f87171',
    };
  }
  if (!loading && liftPct !== null && Math.abs(liftPct) >= 1) {
    return {
      value: fmtPct(liftPct),
      label: 'orders lift measured',
      sub:   waiting > 0 ? `${waiting} still validating` : (improved > 0 ? `${improved} live` : null),
      color: liftPct >= 0 ? '#4ade80' : '#f87171',
    };
  }
  if (improved > 0) {
    return {
      value: String(improved),
      label: `improvement${improved !== 1 ? 's' : ''} live on store`,
      sub:   waiting > 0 ? `${waiting} measuring impact now` : 'tracking revenue impact',
      color: '#22c55e',
    };
  }
  if (scanned > 0) {
    return {
      value: String(scanned),
      label: 'products in active optimization',
      sub:   'First improvements ready to apply',
      color: '#9ca3af',
    };
  }
  return {
    value: '—',
    label: 'Monitoring active',
    sub:   'Improvements loading',
    color: '#6b7280',
  };
}

export default function DashboardKpiStrip({ shop, overview, review }: Props) {
  const [revenue, setRevenue] = useState<RevenueDashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchRevenueDashboard(shop)
      .then(d => setRevenue(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [shop]);

  const improved = overview.totalAppliedExecutions;
  const waiting  = overview.waitingExecutions;
  const scanned  = review.summary.requestedProductCount ?? 0;
  const hasData  = !loading && revenue !== null && !revenue.empty;

  const liftPct  = hasData ? (revenue!.ordersGrowthPercent ?? null) : null;
  const revAdded = hasData ? (revenue!.totalRevenueImpact  ?? null) : null;

  const hero = resolveHero(improved, waiting, scanned, liftPct, revAdded, loading);

  return (
    <div style={s.wrap}>
      <div style={s.heroLayout}>

        {/* ── Left: hero outcome number ──────────────────────────────────── */}
        <div style={s.heroLeft}>
          <div style={{ ...s.heroNumber, color: hero.color }}>{hero.value}</div>
          <div style={s.heroLabel}>{hero.label}</div>
          {hero.sub && <div style={s.heroSub}>{hero.sub}</div>}
        </div>

        <div style={s.divider} />

        {/* ── Right: 4 compact supporting stats in 2×2 ──────────────────── */}
        <div style={s.statsGrid}>
          <StatCell
            label="Live on Store"
            value={improved > 0 ? String(improved) : null}
            pending="None yet"
            color={improved > 0 ? '#22c55e' : undefined}
          />
          <StatCell
            label="Measuring Now"
            value={waiting > 0 ? String(waiting) : null}
            pending="None active"
            color={waiting > 0 ? '#fbbf24' : undefined}
          />
          <StatCell
            label="Orders Lift"
            value={liftPct !== null ? fmtPct(liftPct) : null}
            pending={loading ? '—' : 'Collecting'}
            color={liftPct !== null ? (liftPct >= 0 ? '#4ade80' : '#f87171') : undefined}
          />
          <StatCell
            label="Revenue Impact"
            value={revAdded !== null ? fmtRevenue(revAdded) : null}
            pending={loading ? '—' : 'Measuring'}
            color={revAdded !== null ? (revAdded >= 0 ? '#4ade80' : '#f87171') : undefined}
          />
        </div>

      </div>

      {/* ── Trust bar ──────────────────────────────────────────────────────── */}
      <div style={s.trustBar}>
        <span style={s.trustDot} />
        <span style={s.trustText}>
          System active · All changes reversible · Store auto-protected
        </span>
      </div>
    </div>
  );
}

function StatCell({ label, value, pending, color }: {
  label:   string;
  value:   string | null;
  pending: string;
  color?:  string;
}) {
  const isReal = value !== null;
  return (
    <div style={sc.cell}>
      <span style={sc.label}>{label}</span>
      <span style={{ ...sc.value, color: isReal ? (color ?? '#ffffff') : '#374151' }}>
        {isReal ? value : pending}
      </span>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  wrap: {
    background:   '#0f140f',
    border:       '1px solid rgba(255,255,255,0.09)',
    borderTop:    '2px solid rgba(34,197,94,0.45)',
    borderRadius: 14,
    padding:      '20px 24px 16px',
    marginBottom: 4,
  },
  heroLayout: {
    display:     'flex',
    alignItems:  'center',
    gap:         28,
  },
  heroLeft: {
    width:     200,
    flexShrink: 0,
  },
  heroNumber: {
    fontSize:      42,
    fontWeight:    800,
    lineHeight:    1,
    letterSpacing: '-0.04em',
    marginBottom:  8,
  },
  heroLabel: {
    fontSize:      13,
    fontWeight:    600,
    color:         '#d1d5db',
    letterSpacing: '-0.01em',
    lineHeight:    1.3,
  },
  heroSub: {
    fontSize:  11,
    color:     '#4b5563',
    marginTop: 5,
    lineHeight: 1.4,
  },
  divider: {
    width:      1,
    height:     72,
    background: 'rgba(255,255,255,0.07)',
    flexShrink: 0,
  },
  statsGrid: {
    flex:                1,
    display:             'grid',
    gridTemplateColumns: '1fr 1fr',
    gap:                 2,
  },
  trustBar: {
    display:     'flex',
    alignItems:  'center',
    gap:         8,
    marginTop:   16,
    paddingTop:  12,
    borderTop:   '1px solid rgba(255,255,255,0.04)',
  },
  trustDot: {
    width:        5,
    height:       5,
    borderRadius: '50%',
    background:   '#22c55e',
    boxShadow:    '0 0 4px rgba(34,197,94,0.5)',
    flexShrink:   0,
  },
  trustText: {
    fontSize:      11,
    color:         '#4b5563',
    letterSpacing: '0.01em',
  },
};

const sc: Record<string, React.CSSProperties> = {
  cell: {
    padding:       '8px 14px',
    display:       'flex',
    flexDirection: 'column' as const,
    gap:           4,
    background:    'rgba(255,255,255,0.015)',
    border:        '1px solid rgba(255,255,255,0.05)',
    borderRadius:  8,
  },
  label: {
    fontSize:      9,
    fontWeight:    700,
    letterSpacing: '0.10em',
    textTransform: 'uppercase' as const,
    color:         '#4b5563',
  },
  value: {
    fontSize:      18,
    fontWeight:    800,
    lineHeight:    1,
    letterSpacing: '-0.02em',
  },
};
