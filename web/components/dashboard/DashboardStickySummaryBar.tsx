'use client';

import { useState } from 'react';
import type { DashboardOverview, ReviewPayload } from '@/lib/api';
import type { FilterValue } from './StoreSuggestionsList';

interface Props {
  overview:         DashboardOverview;
  review:           ReviewPayload;
  openCount:        number;
  completedCount:   number;
  blockedCount:     number;
  activeFilter:     FilterValue;
  onFilterChange:   (f: FilterValue) => void;
}

export default function DashboardStickySummaryBar({ overview, review, openCount, completedCount, blockedCount, activeFilter, onFilterChange }: Props) {
  const { revenueUpCount, revenueDownCount } = overview;
  const readyToApply = review.summary.readyToApplyCount ?? 0;

  const hasRevenue = revenueUpCount > 0 || revenueDownCount > 0;
  const revenueLabel = hasRevenue
    ? `${revenueUpCount} up / ${revenueDownCount} down`
    : 'not enough data';

  // clicking an already-active metric resets to ALL
  const handleClick = (filter: FilterValue) =>
    onFilterChange(activeFilter === filter ? 'ALL' : filter);

  return (
    <div style={styles.bar}>
      <Metric label="Open"          value={openCount}    color="#2563eb" active={activeFilter === 'OPEN'}      onClick={() => handleClick('OPEN')} />
      <Divider />
      <Metric label="Ready to apply" sublabel="in Open"  value={readyToApply} color="#15803d" active={activeFilter === 'OPEN'} onClick={() => handleClick('OPEN')} />
      <Divider />
      <Metric label="Completed"     value={completedCount} color="#6b7280" active={activeFilter === 'COMPLETED'} onClick={() => handleClick('COMPLETED')} />
      <Divider />
      <Metric label="Blocked"       value={blockedCount}  color="#d97706" active={activeFilter === 'BLOCKED'}   onClick={() => handleClick('BLOCKED')} />
      <Divider />
      <div style={styles.revenue}>
        <span style={styles.revenueLabel}>Revenue wins</span>
        <span style={{ ...styles.revenueValue, color: hasRevenue ? '#111827' : '#9ca3af' }}>
          {revenueLabel}
        </span>
      </div>
    </div>
  );
}

function Metric({ label, sublabel, value, color, active, onClick }: {
  label: string; sublabel?: string; value: number; color: string; active: boolean; onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ ...styles.metric, ...(active || hovered ? styles.metricHover : {}), ...(active ? styles.metricActive : {}) }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={{ ...styles.metricValue, color }}>{value}</span>
      <span style={styles.metricLabel}>
        {label}
        {sublabel && <span style={styles.sublabel}> ({sublabel})</span>}
      </span>
    </div>
  );
}

function Divider() {
  return <div style={styles.divider} />;
}

const styles: Record<string, React.CSSProperties> = {
  bar:          { position: 'sticky', top: 0, zIndex: 20, display: 'flex', alignItems: 'center', gap: 0, padding: '10px 24px', background: '#fff', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' as const },
  metric:       { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', padding: '6px 20px', gap: 2, borderRadius: 6, cursor: 'pointer', transition: 'background 0.1s' },
  metricHover:  { background: '#f8fafc' },
  metricActive: { background: '#f1f5f9' },
  metricValue:  { fontSize: 20, fontWeight: 700, lineHeight: 1 },
  metricLabel:  { fontSize: 11, color: '#9ca3af', fontWeight: 500, textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  sublabel:     { fontSize: 10, color: '#c4c9d1', fontWeight: 400, textTransform: 'none' as const, letterSpacing: 0 },
  divider:      { width: 1, height: 32, background: '#e5e7eb', flexShrink: 0 },
  revenue:      { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', padding: '6px 20px', gap: 2, cursor: 'default', opacity: 0.7 },
  revenueLabel: { fontSize: 11, color: '#9ca3af', fontWeight: 500, textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  revenueValue: { fontSize: 13, fontWeight: 600 },
};
