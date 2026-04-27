'use client';

import { useEffect, useState } from 'react';
import { fetchAttributedRevenue, fetchRevenueDashboard } from '@/lib/api';
import type { DashboardOverview, ReviewPayload, ActivityItem, AttributedRevenueData, RevenueDashboardData } from '@/lib/api';

interface Props {
  shop:           string;
  overview:       DashboardOverview;
  review:         ReviewPayload;
  recentActivity: ActivityItem[];
  demoMode?:      boolean;
}

export default function MerchantSummary({ shop, overview, review, demoMode }: Props) {
  const [attr, setAttr]       = useState<AttributedRevenueData | null>(null);
  const [revDash, setRevDash] = useState<RevenueDashboardData | null>(null);

  useEffect(() => {
    // attr is fetched only for currency — the number itself comes from revDash
    fetchAttributedRevenue(shop, demoMode ? 1 : 30)
      .then(setAttr)
      .catch(() => setAttr(null));
    fetchRevenueDashboard(shop)
      .then(setRevDash)
      .catch(() => setRevDash(null));
  }, [shop]);

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

  const insufficientCount = revDash?.insufficientDataCount ?? 0;
  const reliableCount     = revDash ? revDash.measuredCount - insufficientCount : 0;

  let heroBody: React.ReactNode;

  if (liveCount === 0) {
    // No changes applied yet
    heroBody = (
      <div style={s.emptyState}>
        <div style={s.emptyTitle}>Apply your first change to start tracking revenue lift</div>
        {pendingCount > 0 && (
          <div style={s.emptyHint}>{pendingCount} change{pendingCount === 1 ? '' : 's'} ready to apply</div>
        )}
      </div>
    );
  } else if (revDash === null) {
    // Loading
    heroBody = (
      <div style={s.loadingState}>
        <div style={s.loadingDot} />
        <div style={s.loadingText}>Calculating net revenue impact…</div>
        <div style={s.loadingHint}>{liveCount} change{liveCount === 1 ? '' : 's'} live — data will appear shortly</div>
      </div>
    );
  } else if (revDash.measuredCount === 0) {
    // Applied changes exist, but no 7-day measurement window has closed yet
    heroBody = (
      <div style={s.measuringState}>
        <div style={s.measuringTitle}>Measurement in progress</div>
        <div style={s.measuringBody}>
          {measuringCount > 0
            ? `${measuringCount} change${measuringCount === 1 ? '' : 's'} collecting data — impact appears once each 7-day window closes`
            : `${liveCount} change${liveCount === 1 ? '' : 's'} live — impact data will appear once the 7-day measurement window closes`}
        </div>
      </div>
    );
  } else if (reliableCount === 0) {
    // Windows completed but every one was below the minimum order threshold
    heroBody = (
      <div style={s.weakState}>
        <div style={s.weakTitle}>Not enough orders to estimate lift yet</div>
        <div style={s.weakBody}>
          {revDash.measuredCount} measurement window{revDash.measuredCount === 1 ? '' : 's'} completed,
          but each had fewer than 5 orders — not enough to separate signal from noise
        </div>
        <div style={s.weakHint}>Results will appear as more orders come in on changed products</div>
      </div>
    );
  } else if (revDash.totalRevenueImpact === 0) {
    // Net deltas cancel exactly to zero
    heroBody = (
      <>
        <div style={s.zeroRevenue}>{fmtRev(0)}</div>
        <div style={s.zeroLabel}>
          No net change across {reliableCount} change{reliableCount === 1 ? '' : 's'}
        </div>
        <div style={s.zeroHint}>
          Before/after comparison shows positive and negative results balancing out — more data will sharpen the picture.
        </div>
      </>
    );
  } else if (revDash.totalRevenueImpact < 0) {
    // Net negative — show honestly, not alarmingly
    heroBody = (
      <>
        <div style={s.heroRevenueNeg}>{fmtRev(revDash.totalRevenueImpact)}</div>
        <div style={s.heroRevenueLabel}>
          Net before/after impact across {reliableCount} change{reliableCount === 1 ? '' : 's'} — revenue declined on balance
        </div>
      </>
    );
  } else {
    // Net positive impact
    const productSuffix =
      revDash.productsImproved > 0
        ? ` on ${revDash.productsImproved} product${revDash.productsImproved === 1 ? '' : 's'}`
        : '';
    const exclusionNote =
      insufficientCount > 0
        ? ` — ${insufficientCount} more excluded (too few orders to measure)`
        : '';

    heroBody = (
      <>
        <div style={s.heroRevenue}>{fmtRev(revDash.totalRevenueImpact)}</div>
        <div style={s.heroRevenueLabel}>
          Net before/after impact across {reliableCount} change{reliableCount === 1 ? '' : 's'}{productSuffix}{exclusionNote}
        </div>
        {revDash.topWins.length > 0 && (
          <div style={s.chipsSection}>
            <div style={s.chipsLabel}>Measured products</div>
            <div style={s.chips}>
              {revDash.topWins.slice(0, 3).map(w => (
                <span key={w.productTitle} style={s.chip}>{w.productTitle}</span>
              ))}
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div style={{ ...s.card, ...(demoMode ? s.cardDemo : {}) }}>
      <div style={s.headerRow}>
        <span style={s.heading}>Net Revenue Impact</span>
        <span style={s.window}>Before/after comparison</span>
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
  card:            { background: '#0d0d0d', border: '1px solid #222', borderRadius: 14, padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 16 },
  cardDemo:        { border: '1px solid #2d3a1e' },
  headerRow:       { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  heading:         { fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: '#666' },
  window:          { fontSize: 10, color: '#555' },
  heroBody:        { display: 'flex', flexDirection: 'column', gap: 6 },
  // Positive / negative lift states
  heroRevenue:     { fontSize: 52, fontWeight: 800, letterSpacing: '-0.04em', color: '#326F0D', lineHeight: 1, marginBottom: 2 },
  heroRevenueNeg:  { fontSize: 52, fontWeight: 800, letterSpacing: '-0.04em', color: '#888', lineHeight: 1, marginBottom: 2 },
  heroRevenueLabel:{ fontSize: 13, color: '#999', fontWeight: 400, lineHeight: 1.5, marginBottom: 4 },
  chipsSection:    { display: 'flex', flexDirection: 'column' as const, gap: 7, marginTop: 12 },
  chipsLabel:      { fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: '#666' },
  chips:           { display: 'flex', flexWrap: 'wrap' as const, gap: 6 },
  chip:            { fontSize: 11, fontWeight: 500, color: '#b8b8b8', background: '#181818', border: '1px solid #2a2a2a', borderRadius: 20, padding: '4px 12px' },
  // Zero lift state
  zeroRevenue:     { fontSize: 40, fontWeight: 800, letterSpacing: '-0.04em', color: '#555', lineHeight: 1 },
  zeroLabel:       { fontSize: 13, color: '#888', marginTop: 4 },
  zeroHint:        { fontSize: 11, color: '#777', lineHeight: 1.6, marginTop: 6 },
  // Measuring state (windows not yet closed)
  measuringState:  { display: 'flex', flexDirection: 'column' as const, gap: 8, padding: '4px 0' },
  measuringTitle:  { fontSize: 14, fontWeight: 600, color: '#888' },
  measuringBody:   { fontSize: 12, color: '#777', lineHeight: 1.6 },
  // Weak-signal state (windows closed but too few orders)
  weakState:       { display: 'flex', flexDirection: 'column' as const, gap: 8, padding: '4px 0' },
  weakTitle:       { fontSize: 14, fontWeight: 600, color: '#888' },
  weakBody:        { fontSize: 12, color: '#777', lineHeight: 1.6 },
  weakHint:        { fontSize: 11, color: '#666', marginTop: 2 },
  // Loading state
  loadingState:    { display: 'flex', flexDirection: 'column' as const, gap: 8, paddingTop: 8 },
  loadingDot:      { width: 8, height: 8, borderRadius: '50%', background: '#326F0D', opacity: 0.4 },
  loadingText:     { fontSize: 13, color: '#888' },
  loadingHint:     { fontSize: 11, color: '#777' },
  // Empty state (no changes applied)
  emptyState:      { display: 'flex', flexDirection: 'column' as const, gap: 8, padding: '8px 0' },
  emptyTitle:      { fontSize: 14, color: '#888', lineHeight: 1.5, fontWeight: 500 },
  emptyHint:       { fontSize: 11, color: '#4a7a28' },
  // Footer
  footer:          { display: 'flex', alignItems: 'center', gap: 14, paddingTop: 14, borderTop: '1px solid #1a1a1a', flexWrap: 'wrap' as const },
  footerAccent:    { fontSize: 11, fontWeight: 700, color: '#4a7a28', letterSpacing: '0.01em' },
  footerMuted:     { fontSize: 11, color: '#666' },
};
