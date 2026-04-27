'use client';

import { useEffect, useState } from 'react';
import { fetchAttributedRevenue, issueLabel } from '@/lib/api';
import type { DashboardOverview, ReviewPayload, ActivityItem, AttributedRevenueData } from '@/lib/api';

interface Props {
  shop:           string;
  overview:       DashboardOverview;
  review:         ReviewPayload;
  recentActivity: ActivityItem[];
  demoMode?:      boolean;
}

export default function MerchantSummary({ shop, overview, review, recentActivity, demoMode }: Props) {
  const [attr, setAttr] = useState<AttributedRevenueData | null>(null);

  useEffect(() => {
    fetchAttributedRevenue(shop, demoMode ? 1 : 30)
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

  const attrPct = attr && attr.storeRevenue > 0
    ? Math.round((attr.improvedProductRevenue / attr.storeRevenue) * 100)
    : null;

  let heroBody: React.ReactNode;

  if (liveCount === 0) {
    heroBody = (
      <div style={s.emptyState}>
        <div style={s.emptyTitle}>Apply your first change to start tracking revenue impact</div>
        {pendingCount > 0 && (
          <div style={s.emptyHint}>{pendingCount} change{pendingCount === 1 ? '' : 's'} ready to apply</div>
        )}
      </div>
    );
  } else if (attr === null) {
    heroBody = (
      <div style={s.loadingState}>
        <div style={s.loadingDot} />
        <div style={s.loadingText}>Attributing revenue to improved products…</div>
        <div style={s.loadingHint}>{liveCount} change{liveCount === 1 ? '' : 's'} live — data will appear shortly</div>
      </div>
    );
  } else if (attr.improvedProductRevenue === 0) {
    const zero = fmtRev(0);
    heroBody = demoMode ? (
      <>
        <div style={s.zeroRevenue}>{zero}</div>
        <div style={s.zeroLabel}>No sales from improved products yet today</div>
        <div style={s.zeroHint}>Results will appear here as orders come in today.</div>
      </>
    ) : (
      <>
        <div style={s.zeroRevenue}>{zero}</div>
        <div style={s.zeroLabel}>Improved products generated {zero} so far</div>
        <div style={s.zeroHint}>No attributed sales recorded yet this period. Results will appear as orders come in.</div>
      </>
    );
  } else {
    heroBody = (
      <>
        {demoMode && (
          <div style={s.demoTag}>Preview · today&apos;s real sales · no data changed</div>
        )}
        <div style={s.heroRevenue}>{fmtRev(attr.improvedProductRevenue)}</div>
        <div style={s.heroRevenueLabel}>
          {attr.improvedProductOrders > 0 && attrPct !== null
            ? `Brought in by ${attr.improvedProductOrders.toLocaleString()} order${attr.improvedProductOrders === 1 ? '' : 's'} on improved products — ${attrPct}% of store revenue this period`
            : attr.improvedProductOrders > 0
            ? `Brought in by ${attr.improvedProductOrders.toLocaleString()} order${attr.improvedProductOrders === 1 ? '' : 's'} on improved products`
            : attrPct !== null
            ? `${attrPct}% of your store revenue this period`
            : 'From improved products this period'}
        </div>
        {recentProducts.length > 0 && (
          <div style={s.chipsSection}>
            <div style={s.chipsLabel}>Products contributing</div>
            <div style={s.chips}>
              {recentProducts.map(name => (
                <span key={name} style={s.chip}>{name}</span>
              ))}
            </div>
          </div>
        )}
        {attr.unattributedRevenue > 0 && (
          <div style={s.unattributed}>
            {fmtRev(attr.unattributedRevenue)} in store revenue came from products the system did not change
          </div>
        )}
      </>
    );
  }

  return (
    <div style={{ ...s.card, ...(demoMode ? s.cardDemo : {}) }}>
      <div style={s.headerRow}>
        <span style={s.heading}>Improved Product Revenue</span>
        <span style={s.window}>{demoMode ? 'Today' : 'Last 30 days'}</span>
      </div>
      <div style={s.heroBody}>
        {heroBody}
      </div>
      {liveCount > 0 && (pendingCount > 0 || measuringCount > 0) && (
        <div style={s.footer}>
          {pendingCount > 0 && (
            <span style={s.footerAccent}>{pendingCount} change{pendingCount === 1 ? '' : 's'} ready to apply</span>
          )}
          {measuringCount > 0 && (
            <span style={s.footerMuted}>{measuringCount} still measuring</span>
          )}
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  card:             { background: '#0d0d0d', border: '1px solid #222', borderRadius: 14, padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 16 },
  cardDemo:         { border: '1px solid #2d3a1e' },
  headerRow:        { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  heading:          { fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: '#666' },
  window:           { fontSize: 10, color: '#555' },
  heroBody:         { display: 'flex', flexDirection: 'column', gap: 6 },
  // Revenue positive state
  demoTag:          { fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' as const, color: '#4a7a28', marginBottom: 4 },
  heroRevenue:      { fontSize: 52, fontWeight: 800, letterSpacing: '-0.04em', color: '#326F0D', lineHeight: 1, marginBottom: 2 },
  heroRevenueLabel: { fontSize: 13, color: '#999', fontWeight: 400, lineHeight: 1.5, marginBottom: 4 },
  heroMeta:         { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' as const },
  heroMetaStrong:   { fontSize: 16, fontWeight: 700, color: '#e0e0e0' },
  heroMetaDot:      { fontSize: 14, color: '#555' },
  heroMetaMuted:    { fontSize: 13, color: '#888' },
  chipsSection:     { display: 'flex', flexDirection: 'column' as const, gap: 7, marginTop: 12 },
  chipsLabel:       { fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: '#666' },
  chips:            { display: 'flex', flexWrap: 'wrap' as const, gap: 6 },
  chip:             { fontSize: 11, fontWeight: 500, color: '#b8b8b8', background: '#181818', border: '1px solid #2a2a2a', borderRadius: 20, padding: '4px 12px' },
  unattributed:     { fontSize: 11, color: '#666', marginTop: 14, lineHeight: 1.5 },
  // Zero-result state
  zeroRevenue:      { fontSize: 40, fontWeight: 800, letterSpacing: '-0.04em', color: '#555', lineHeight: 1 },
  zeroLabel:        { fontSize: 13, color: '#888', marginTop: 4 },
  zeroHint:         { fontSize: 11, color: '#777', lineHeight: 1.6, marginTop: 6 },
  // Loading state
  loadingState:     { display: 'flex', flexDirection: 'column' as const, gap: 8, paddingTop: 8 },
  loadingDot:       { width: 8, height: 8, borderRadius: '50%', background: '#326F0D', opacity: 0.4 },
  loadingText:      { fontSize: 13, color: '#888' },
  loadingHint:      { fontSize: 11, color: '#777' },
  // Empty state
  emptyState:       { display: 'flex', flexDirection: 'column' as const, gap: 8, padding: '8px 0' },
  emptyTitle:       { fontSize: 14, color: '#888', lineHeight: 1.5, fontWeight: 500 },
  emptyHint:        { fontSize: 11, color: '#4a7a28' },
  // Footer — secondary next steps
  footer:           { display: 'flex', alignItems: 'center', gap: 14, paddingTop: 14, borderTop: '1px solid #1a1a1a', flexWrap: 'wrap' as const },
  footerAccent:     { fontSize: 11, fontWeight: 700, color: '#4a7a28', letterSpacing: '0.01em' },
  footerMuted:      { fontSize: 11, color: '#666' },
};
