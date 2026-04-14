'use client';

import { useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { DashboardPayload, ApplyResponse } from '@/lib/api';
import { applySelected } from '@/lib/api';
import StoreOverview                from './StoreOverview';
import ReadyToApplyList             from './ReadyToApplyList';
import TopWinsList                  from './TopWinsList';
import RecentActivityList           from './RecentActivityList';
import ExecutionDetailsPanel        from './ExecutionDetailsPanel';
import StoreSuggestionsList         from './StoreSuggestionsList';
import DashboardStickySummaryBar    from './DashboardStickySummaryBar';
import type { FilterValue }         from './StoreSuggestionsList';

const SHOP = process.env.NEXT_PUBLIC_SHOP ?? '';

interface Props {
  data: DashboardPayload;
}

export default function DashboardClient({ data }: Props) {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const selectedExecId = searchParams.get('executionId');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [suggestionCounts, setSuggestionCounts] = useState({ open: 0, completed: 0, blocked: 0 });
  const [activeFilter, setActiveFilter] = useState<FilterValue>('ALL');
  const [isApplying,  setIsApplying]  = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResponse | null>(null);
  const [applyError,  setApplyError]  = useState<string | null>(null);

  const selectableKeys = data.review.groups.readyToApply
    .filter(i => i.selectable)
    .map(i => i.selectionKey);

  const toggle = useCallback((key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const selectAll   = () => setSelected(new Set(selectableKeys));
  const clearSelect = () => setSelected(new Set());

  const handleApply = async () => {
    if (!selected.size || isApplying) return;

    setIsApplying(true);
    setApplyResult(null);
    setApplyError(null);

    try {
      const result = await applySelected(SHOP, Array.from(selected));
      setApplyResult(result);
      setSelected(new Set());   // clear selection after success
      router.refresh();         // re-run server component to reflect new backend state
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div>
      <DashboardStickySummaryBar
        overview={data.overview}
        review={data.review}
        openCount={suggestionCounts.open}
        completedCount={suggestionCounts.completed}
        blockedCount={suggestionCounts.blocked}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
      />
    <div style={styles.sections}>
      <StoreOverview overview={data.overview} />

      <ReadyToApplyList
        items={data.review.groups.readyToApply}
        selected={selected}
        isApplying={isApplying}
        onToggle={toggle}
        onSelectAll={selectAll}
        onClearSelection={clearSelect}
        onApply={handleApply}
      />

      {/* Result feedback — shown inline after apply */}
      {applyError && (
        <div style={styles.errorBox}>
          {applyError}
        </div>
      )}
      {applyResult && (
        <ApplyResultBox result={applyResult} />
      )}

      <TopWinsList          items={data.topWins} />
      <StoreSuggestionsList
        onSelectMatches={keys =>
          setSelected(prev => new Set([...prev, ...keys]))
        }
        onAppliedSelectionKeys={keys =>
          setSelected(prev => { const n = new Set(prev); keys.forEach(k => n.delete(k)); return n; })
        }
        onSuggestionCounts={setSuggestionCounts}
        activeFilter={activeFilter}
        onFilterChange={setActiveFilter}
      />
      <RecentActivityList
        items={data.recentActivity}
        selectedExecId={selectedExecId}
        onSelect={id => router.push(`/dashboard?executionId=${id}`)}
      />

      {selectedExecId && (
        <ExecutionDetailsPanel
          executionId={selectedExecId}
          onClose={() => router.push('/dashboard')}
        />
      )}
    </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ApplyResultBox — compact inline result after apply completes
// ---------------------------------------------------------------------------
function ApplyResultBox({ result }: { result: ApplyResponse }) {
  const STATUS_COLOR: Record<string, string> = {
    applied: '#16a34a', skipped: '#d97706', failed: '#dc2626',
  };

  return (
    <div style={styles.resultBox}>
      <div style={styles.resultHeader}>
        Apply complete —{' '}
        <span style={{ color: '#16a34a' }}>{result.appliedCount} applied</span>
        {result.skippedCount > 0 && <span style={{ color: '#d97706' }}> · {result.skippedCount} skipped</span>}
        {result.failedCount  > 0 && <span style={{ color: '#dc2626' }}> · {result.failedCount} failed</span>}
      </div>
      <div style={styles.resultList}>
        {result.results.map(item => (
          <div key={item.selectionKey} style={styles.resultRow}>
            <span style={{ color: STATUS_COLOR[item.status] ?? '#374151', fontWeight: 600, minWidth: 60 }}>
              {item.status}
            </span>
            <span style={styles.resultKey}>{item.selectionKey}</span>
            {item.reason && <span style={styles.resultReason}>{item.reason}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sections:     { display: 'flex', flexDirection: 'column', gap: 40 },
  errorBox:     { padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#dc2626', fontSize: 13 },
  resultBox:    { padding: '16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8 },
  resultHeader: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 12 },
  resultList:   { display: 'flex', flexDirection: 'column', gap: 6 },
  resultRow:    { display: 'flex', gap: 12, alignItems: 'baseline', fontSize: 12 },
  resultKey:    { color: '#374151', fontFamily: 'monospace' },
  resultReason: { color: '#9ca3af' },
};
