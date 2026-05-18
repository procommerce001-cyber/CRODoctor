'use client';

import { useEffect, useState } from 'react';
import { fetchMonthlyStatement } from '@/lib/api';
import type { MonthlyStatementData, MonthlyStatementWin } from '@/lib/api';

interface Props {
  shop:         string;
  pendingCount: number;
}

function fmtMonth(isoEnd: string): string {
  return new Date(isoEnd).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function fmtMoney(n: number): string {
  const abs = Math.round(Math.abs(n));
  return `${n >= 0 ? '+' : '−'}$${abs.toLocaleString()}`;
}

export default function MonthlyStatement({ shop, pendingCount }: Props) {
  const [data,    setData]    = useState<MonthlyStatementData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMonthlyStatement(shop)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [shop]);

  if (loading) {
    return (
      <div style={s.card}>
        <div style={s.header}>
          <span style={s.label}>This Month</span>
        </div>
        <div style={s.skeleton} />
        <div style={{ ...s.skeleton, width: '60%', marginTop: 6 }} />
      </div>
    );
  }

  if (!data) return null;

  const { executionsCount, measuredCount, waitingCount, insufficientDataCount,
          totalRevenueImpact, productsImproved, topWins, windowEnd } = data;

  const reliableCount = measuredCount - insufficientDataCount;
  const monthLabel    = fmtMonth(windowEnd);

  // ── No changes applied this month ──────────────────────────────────────
  if (executionsCount === 0) {
    return (
      <div style={s.card}>
        <div style={s.header}>
          <span style={s.label}>This Month</span>
          <span style={s.period}>{monthLabel}</span>
        </div>
        <div style={s.emptyBody}>
          No content changes applied in the last 30 days.
          {pendingCount > 0 && (
            <span style={s.ctaHint}> {pendingCount} change{pendingCount === 1 ? '' : 's'} ready to apply.</span>
          )}
        </div>
      </div>
    );
  }

  // ── Changes applied but none measured yet ──────────────────────────────
  if (measuredCount === 0) {
    return (
      <div style={s.card}>
        <div style={s.header}>
          <span style={s.label}>This Month</span>
          <span style={s.period}>{monthLabel}</span>
        </div>
        <div style={s.measuringBody}>
          <span style={s.measuringDot} />
          <div>
            <div style={s.measuringTitle}>Measuring impact</div>
            <div style={s.measuringText}>
              {executionsCount} change{executionsCount === 1 ? '' : 's'} applied this month — 7-day measurement windows still open.
              Results will appear here once each window closes.
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Some/all measured but all below the confidence threshold ───────────
  if (reliableCount === 0) {
    return (
      <div style={s.card}>
        <div style={s.header}>
          <span style={s.label}>This Month</span>
          <span style={s.period}>{monthLabel}</span>
        </div>
        <div style={s.weakBody}>
          <div style={s.weakTitle}>Not enough orders to estimate impact yet</div>
          <div style={s.weakText}>
            {measuredCount} measurement window{measuredCount === 1 ? '' : 's'} closed this month,
            but each had fewer than 5 orders — not enough to separate signal from noise.
          </div>
          {waitingCount > 0 && (
            <div style={s.weakHint}>{waitingCount} more window{waitingCount === 1 ? '' : 's'} still measuring.</div>
          )}
        </div>
      </div>
    );
  }

  // ── Measured results ────────────────────────────────────────────────────
  const positive = totalRevenueImpact > 0;
  const neutral  = totalRevenueImpact === 0;

  return (
    <div style={s.card}>
      <div style={s.header}>
        <span style={s.label}>This Month</span>
        <span style={s.period}>{monthLabel}</span>
      </div>

      {/* Revenue figure */}
      <div style={{ ...s.revenueNum, color: positive ? '#16a34a' : neutral ? '#6b7280' : '#dc2626' }}>
        {fmtMoney(totalRevenueImpact)}
      </div>

      {/* Attribution label */}
      <div style={s.revenueLabel}>
        Before/after revenue impact across{' '}
        <strong>{reliableCount}</strong> measured content change{reliableCount === 1 ? '' : 's'}
        {productsImproved > 0 && ` on ${productsImproved} product${productsImproved === 1 ? '' : 's'}`}
        {insufficientDataCount > 0 && (
          <span style={s.exclusion}>
            {' '}— {insufficientDataCount} excluded (too few orders)
          </span>
        )}
      </div>

      {/* Top wins row */}
      {topWins.length > 0 && positive && (
        <div style={s.wins}>
          {topWins.map((w: MonthlyStatementWin, i: number) => (
            <WinChip key={i} item={w} />
          ))}
        </div>
      )}

      {/* Footer: still measuring + next action */}
      {(waitingCount > 0 || pendingCount > 0) && (
        <div style={s.footer}>
          {waitingCount > 0 && (
            <span style={s.footerMuted}>
              {waitingCount} change{waitingCount === 1 ? '' : 's'} still collecting data
            </span>
          )}
          {pendingCount > 0 && (
            <span style={s.footerAction}>
              {pendingCount} change{pendingCount === 1 ? '' : 's'} ready to apply
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function WinChip({ item }: { item: MonthlyStatementWin }) {
  const positive = item.revenueDelta >= 0;
  return (
    <div style={s.winChip}>
      <span style={s.winTitle}>{item.productTitle}</span>
      <span style={{ ...s.winDelta, color: positive ? '#16a34a' : '#dc2626' }}>
        {item.revenueDelta >= 0 ? '+' : '−'}${Math.round(Math.abs(item.revenueDelta)).toLocaleString()}
      </span>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  card:          { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 10 },
  header:        { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  label:         { fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' as const, color: '#6b7280' },
  period:        { fontSize: 10, color: '#9ca3af' },
  skeleton:      { height: 36, width: '45%', background: '#f3f4f6', borderRadius: 6 },
  // Revenue display
  revenueNum:    { fontSize: 36, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1 },
  revenueLabel:  { fontSize: 12, color: '#6b7280', lineHeight: 1.5 },
  exclusion:     { color: '#9ca3af' },
  // Top wins chips
  wins:          { display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginTop: 2 },
  winChip:       { display: 'flex', alignItems: 'center', gap: 6, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '5px 10px' },
  winTitle:      { fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, maxWidth: 180 },
  winDelta:      { fontSize: 12, fontWeight: 700, flexShrink: 0 },
  // Footer
  footer:        { display: 'flex', gap: 14, flexWrap: 'wrap' as const, paddingTop: 8, borderTop: '1px solid #f3f4f6', alignItems: 'baseline' },
  footerMuted:   { fontSize: 11, color: '#9ca3af' },
  footerAction:  { fontSize: 11, fontWeight: 700, color: '#16a34a' },
  // Empty state
  emptyBody:     { fontSize: 13, color: '#9ca3af', lineHeight: 1.5 },
  ctaHint:       { color: '#374151', fontWeight: 600 },
  // Measuring state
  measuringBody: { display: 'flex', gap: 10, alignItems: 'flex-start' },
  measuringDot:  { width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', flexShrink: 0, marginTop: 4 },
  measuringTitle:{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 3 },
  measuringText: { fontSize: 12, color: '#6b7280', lineHeight: 1.5 },
  // Insufficient-data state
  weakBody:      { display: 'flex', flexDirection: 'column' as const, gap: 4 },
  weakTitle:     { fontSize: 13, fontWeight: 600, color: '#374151' },
  weakText:      { fontSize: 12, color: '#6b7280', lineHeight: 1.5 },
  weakHint:      { fontSize: 11, color: '#9ca3af' },
};
