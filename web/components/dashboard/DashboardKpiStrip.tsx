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

export default function DashboardKpiStrip({ shop, overview, review }: Props) {
  const [revenue, setRevenue]   = useState<RevenueDashboardData | null>(null);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    fetchRevenueDashboard(shop)
      .then(d => setRevenue(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [shop]);

  const scanned  = review.summary.requestedProductCount ?? 0;
  const improved = overview.totalAppliedExecutions;
  const hasData  = !loading && revenue !== null && !revenue.empty;

  const liftPct  = hasData ? (revenue!.ordersGrowthPercent  ?? null) : null;
  const revAdded = hasData ? (revenue!.totalRevenueImpact   ?? null) : null;

  const summary =
    improved === 0
      ? `${scanned} product${scanned === 1 ? '' : 's'} scanned — your first improvements are ready to review.`
      : hasData && liftPct !== null
      ? `${improved} improvement${improved === 1 ? '' : 's'} live · ${fmtPct(liftPct)} orders growth measured so far.`
      : `${improved} improvement${improved === 1 ? '' : 's'} live on your store · measuring commercial impact now.`;

  return (
    <div style={s.wrap}>
      <p style={s.summary}>{summary}</p>
      <div style={s.grid}>

        <KpiCard
          label="Products Monitored"
          value={scanned > 0 ? String(scanned) : '—'}
          sub="in optimization scope"
          state="ready"
          positive={null}
        />

        <KpiCard
          label="Improvements Live"
          value={improved > 0 ? String(improved) : '—'}
          sub={improved > 0 ? 'live on store' : 'none yet'}
          state="ready"
          positive={improved > 0 ? true : null}
        />

        <KpiCard
          label="Conversion Lift"
          value={liftPct !== null ? fmtPct(liftPct) : null}
          sub={liftPct !== null ? 'orders growth measured' : null}
          state={loading ? 'loading' : !hasData ? 'pending' : liftPct === null ? 'pending' : 'ready'}
          positive={liftPct !== null ? liftPct >= 0 : null}
          pendingLabel="Collecting data"
        />

        <KpiCard
          label="Revenue Added"
          value={revAdded !== null ? fmtRevenue(revAdded) : null}
          sub={revAdded !== null ? 'measured impact' : null}
          state={loading ? 'loading' : !hasData ? 'pending' : revAdded === null ? 'pending' : 'ready'}
          positive={revAdded !== null ? revAdded >= 0 : null}
          pendingLabel="Building baseline"
        />

      </div>
    </div>
  );
}

function KpiCard({ label, value, sub, state, positive, pendingLabel }: {
  label:         string;
  value:         string | null;
  sub:           string | null;
  state:         'ready' | 'loading' | 'pending';
  positive:      boolean | null;
  pendingLabel?: string;
}) {
  const valueColor =
    positive === true  ? '#4ade80' :
    positive === false ? '#f87171' :
    '#ffffff';

  return (
    <div style={s.card}>
      <div style={s.cardLabel}>{label}</div>
      {state === 'loading' ? (
        <div style={s.cardPending}>Measuring…</div>
      ) : state === 'pending' || value === null ? (
        <div style={s.cardPending}>{pendingLabel ?? 'Tracking now'}</div>
      ) : (
        <>
          <div style={{ ...s.cardValue, color: valueColor }}>{value}</div>
          {sub && <div style={s.cardSub}>{sub}</div>}
        </>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  wrap:       {
    background:   '#0f140f',
    border:       '1px solid rgba(255,255,255,0.07)',
    borderTop:    '2px solid rgba(34,197,94,0.35)',
    borderRadius: 14,
    padding:      '20px 24px',
    marginBottom: 4,
  },
  summary:    {
    margin:        '0 0 18px',
    fontSize:      14,
    color:         '#d1d5db',
    lineHeight:    1.6,
    letterSpacing: '0.01em',
    fontWeight:    400,
  },
  grid:       {
    display:             'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap:                 10,
  },
  card:       {
    background:    'rgba(255,255,255,0.03)',
    border:        '1px solid rgba(255,255,255,0.07)',
    borderRadius:  10,
    padding:       '16px 14px',
    display:       'flex',
    flexDirection: 'column',
    gap:           5,
  },
  cardLabel:  {
    fontSize:      10,
    fontWeight:    700,
    letterSpacing: '0.10em',
    textTransform: 'uppercase' as const,
    color:         '#6b7280',
  },
  cardValue:  {
    fontSize:      26,
    fontWeight:    800,
    lineHeight:    1,
    letterSpacing: '-0.03em',
  },
  cardSub:    {
    fontSize:  11,
    color:     '#9ca3af',
    marginTop: 2,
  },
  cardPending: {
    fontSize:   12,
    color:      '#6b7280',
    fontStyle:  'italic',
    paddingTop: 4,
  },
};
