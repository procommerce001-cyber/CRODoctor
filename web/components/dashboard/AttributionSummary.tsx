'use client';

import { useEffect, useState } from 'react';
import { fetchAttributedRevenue } from '@/lib/api';
import type { AttributedRevenueData } from '@/lib/api';

interface Props {
  shop: string;
  windowDays?: number;
}

export default function AttributionSummary({ shop, windowDays = 30 }: Props) {
  const [data,    setData]    = useState<AttributedRevenueData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAttributedRevenue(shop, windowDays)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [shop, windowDays]);

  if (loading) return <div style={styles.skeleton} />;
  if (!data)   return null;

  const fmtRev = (n: number) => {
    try {
      if (data.currency) {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: data.currency }).format(n);
      }
    } catch { /* unknown currency code — fall through */ }
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const fmt    = (n: number) => Math.round(n).toLocaleString();
  const pct    = data.storeRevenue > 0
    ? Math.round((data.improvedProductRevenue / data.storeRevenue) * 100)
    : null;

  return (
    <div style={styles.card}>
      <div style={styles.heading}>
        <span style={styles.label}>Revenue attribution</span>
        <span style={styles.window}>Last {windowDays} days</span>
      </div>

      <div style={styles.grid}>
        <Tile
          title="Revenue from improved products"
          value={fmtRev(data.improvedProductRevenue)}
          sub={pct !== null ? `${pct}% of total store revenue` : undefined}
          highlight
        />
        <Tile
          title="Unattributed revenue"
          value={fmtRev(data.unattributedRevenue)}
        />
        <Tile
          title="Orders containing improved products"
          value={fmt(data.improvedProductOrders)}
        />
        <Tile
          title="Units sold from improved products"
          value={fmt(data.improvedProductUnits)}
        />
      </div>

      <div style={styles.footer}>
        Total store revenue this period: <strong>{fmtRev(data.storeRevenue)}</strong>
        {' '}across <strong>{fmt(data.storeOrderCount)}</strong>{' '}
        order{data.storeOrderCount === 1 ? '' : 's'}
      </div>
    </div>
  );
}

function Tile({ title, value, sub, highlight }: {
  title: string;
  value: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div style={{ ...styles.tile, ...(highlight ? styles.tileHighlight : {}) }}>
      <span style={styles.tileTitle}>{title}</span>
      <span style={highlight ? styles.tileValueHL : styles.tileValue}>{value}</span>
      {sub && <span style={styles.tileSub}>{sub}</span>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  skeleton:      { height: 120, borderRadius: 10, background: '#f3f4f6', animation: 'pulse 1.5s ease-in-out infinite' },
  card:          { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 },
  heading:       { display: 'flex', alignItems: 'baseline', gap: 10 },
  label:         { fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase' as const, color: '#6b7280' },
  window:        { fontSize: 11, color: '#9ca3af' },
  grid:          { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 },
  tile:          { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 2 },
  tileHighlight: { background: '#f0fdf4', border: '1px solid #bbf7d0' },
  tileTitle:     { fontSize: 11, color: '#6b7280', lineHeight: 1.4 },
  tileValue:     { fontSize: 20, fontWeight: 700, color: '#111827', letterSpacing: '-0.02em' },
  tileValueHL:   { fontSize: 20, fontWeight: 700, color: '#166534', letterSpacing: '-0.02em' },
  tileSub:       { fontSize: 11, color: '#16a34a', fontWeight: 500 },
  footer:        { fontSize: 12, color: '#9ca3af', borderTop: '1px solid #f3f4f6', paddingTop: 10 },
};
