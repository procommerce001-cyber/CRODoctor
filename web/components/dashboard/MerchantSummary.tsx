'use client';

import { useEffect, useState } from 'react';
import { fetchAttributedRevenue, issueLabel } from '@/lib/api';
import type { DashboardOverview, ReviewPayload, ActivityItem, AttributedRevenueData } from '@/lib/api';

interface Props {
  shop:           string;
  overview:       DashboardOverview;
  review:         ReviewPayload;
  recentActivity: ActivityItem[];
}

export default function MerchantSummary({ shop, overview, review, recentActivity }: Props) {
  const [attr, setAttr] = useState<AttributedRevenueData | null>(null);

  useEffect(() => {
    fetchAttributedRevenue(shop, 30)
      .then(setAttr)
      .catch(() => setAttr(null));
  }, [shop]);

  // Derive recently changed product names (last 3 unique, applied only)
  const recentProducts: string[] = [];
  for (const item of recentActivity) {
    if (item.status !== 'applied') continue;
    const name = item.productTitle ?? issueLabel(item.issueId);
    if (!recentProducts.includes(name)) recentProducts.push(name);
    if (recentProducts.length >= 3) break;
  }

  // Format money with correct currency when available, neutral otherwise
  const fmtRev = (n: number) => {
    try {
      if (attr?.currency) {
        return new Intl.NumberFormat(undefined, { style: 'currency', currency: attr.currency }).format(n);
      }
    } catch { /* fall through */ }
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const liveCount      = overview.totalAppliedExecutions;
  const measuringCount = overview.waitingExecutions;
  const pendingCount   = review.summary.readyToApplyCount;

  // Short headline sentence
  let headline = '';
  if (liveCount === 0) {
    headline = 'No changes have been applied to your store yet.';
  } else {
    headline = `${liveCount} change${liveCount === 1 ? '' : 's'} ${liveCount === 1 ? 'is' : 'are'} currently live on your store.`;
    if (measuringCount > 0) {
      headline += ` ${measuringCount} ${measuringCount === 1 ? 'is' : 'are'} still being measured.`;
    }
    if (pendingCount > 0) {
      headline += ` ${pendingCount} more ${pendingCount === 1 ? 'change is' : 'changes are'} ready to apply.`;
    }
  }

  const attrPct = attr && attr.storeRevenue > 0
    ? Math.round((attr.improvedProductRevenue / attr.storeRevenue) * 100)
    : null;

  return (
    <div style={s.card}>
      {/* Header */}
      <div style={s.headerRow}>
        <span style={s.heading}>What changed and what happened since</span>
        <span style={s.window}>Last 30 days</span>
      </div>

      {/* Headline sentence */}
      <p style={s.headline}>{headline}</p>

      {/* Summary rows */}
      <div style={s.rows}>
        <SummaryRow
          label="Changes currently live"
          value={liveCount > 0 ? String(liveCount) : 'None yet'}
          muted={liveCount === 0}
        />

        {recentProducts.length > 0 && (
          <SummaryRow
            label="Products changed recently"
            value={recentProducts.join(', ')}
          />
        )}

        {attr && (
          <SummaryRow
            label="Revenue from improved products"
            value={fmtRev(attr.improvedProductRevenue)}
            sub={attrPct !== null ? `${attrPct}% of total store revenue` : undefined}
            highlight
          />
        )}

        {attr && attr.improvedProductOrders > 0 && (
          <SummaryRow
            label="Orders containing improved products"
            value={String(attr.improvedProductOrders)}
          />
        )}

        {measuringCount > 0 && (
          <SummaryRow
            label="Still measuring impact"
            value={`${measuringCount} change${measuringCount === 1 ? '' : 's'}`}
            muted
          />
        )}

        {pendingCount > 0 && (
          <SummaryRow
            label="Ready to apply"
            value={`${pendingCount} change${pendingCount === 1 ? '' : 's'} waiting`}
            accent
          />
        )}
      </div>

      {/* Footer note */}
      {attr && attr.unattributedRevenue > 0 && (
        <p style={s.note}>
          {fmtRev(attr.unattributedRevenue)} in store revenue this period came from products the system did not change.
        </p>
      )}
    </div>
  );
}

function SummaryRow({ label, value, sub, highlight, muted, accent }: {
  label:     string;
  value:     string;
  sub?:      string;
  highlight?: boolean;
  muted?:    boolean;
  accent?:   boolean;
}) {
  const valueColor = highlight ? '#166534' : muted ? '#9ca3af' : accent ? '#b45309' : '#111827';
  return (
    <div style={s.row}>
      <span style={s.rowLabel}>{label}</span>
      <div style={s.rowRight}>
        <span style={{ ...s.rowValue, color: valueColor }}>{value}</span>
        {sub && <span style={s.rowSub}>{sub}</span>}
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  card:      { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 },
  headerRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' },
  heading:   { fontSize: 13, fontWeight: 700, color: '#111827' },
  window:    { fontSize: 11, color: '#9ca3af' },
  headline:  { fontSize: 13, color: '#374151', lineHeight: 1.5, margin: 0, padding: '2px 0' },
  rows:      { display: 'flex', flexDirection: 'column', gap: 0, borderTop: '1px solid #f3f4f6', paddingTop: 10 },
  row:       { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '7px 0', borderBottom: '1px solid #f9fafb' },
  rowLabel:  { fontSize: 12, color: '#6b7280' },
  rowRight:  { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 },
  rowValue:  { fontSize: 13, fontWeight: 600 },
  rowSub:    { fontSize: 11, color: '#16a34a' },
  note:      { fontSize: 11, color: '#9ca3af', margin: 0, paddingTop: 6, borderTop: '1px solid #f3f4f6', lineHeight: 1.5 },
};
