'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { DashboardPayload, ApplyResponse, TopAction, ExecutionResult } from '@/lib/api';
import { applySelected, fetchTopActions, executeAction, fetchExecutionResults } from '@/lib/api';
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

function confidenceLabel(severity: string): string {
  if (severity === 'critical' || severity === 'high') return 'High';
  if (severity === 'medium') return 'Medium';
  return 'Low';
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

  const [topActions,  setTopActions]  = useState<TopAction[]>([]);
  const [executing,   setExecuting]   = useState<Set<string>>(new Set());
  const [roiMap,      setRoiMap]      = useState<Record<string, ExecutionResult>>({});

  useEffect(() => {
    fetchTopActions(SHOP).then(setTopActions).catch(() => {});
  }, []);

  const handleExecute = async (actionKey: string) => {
    setExecuting(prev => new Set(prev).add(actionKey));
    try {
      const executionId = await executeAction(SHOP, actionKey);
      const [refreshed, result] = await Promise.all([
        fetchTopActions(SHOP),
        fetchExecutionResults(SHOP, executionId),
      ]);
      setTopActions(refreshed);
      if (result) setRoiMap(prev => ({ ...prev, [actionKey]: result }));
    } catch (_) {
      // silently keep existing state on error
    } finally {
      setExecuting(prev => { const n = new Set(prev); n.delete(actionKey); return n; });
    }
  };

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

      {topActions.length > 0 && (
        <section>
          <div style={styles.dailyBar}>
            <span style={styles.dailyTitle}>Today&apos;s opportunities</span>
            <span style={styles.dailyMsg}>
              {topActions.filter(a => a.executionStatus === 'pending').length > 0
                ? `${topActions.filter(a => a.executionStatus === 'pending').length} new opportunit${topActions.filter(a => a.executionStatus === 'pending').length === 1 ? 'y' : 'ies'} detected today`
                : 'Your store is stable today — no urgent fixes'}
            </span>
          </div>
          <h2 style={styles.sectionHeading}>Top Actions</h2>
          <div style={styles.actionList}>
            {topActions.map((action, idx) => {
              const isHero    = idx === 0;
              const isDone    = action.executionStatus === 'completed';
              const isRunning = executing.has(action.actionKey);
              return (
                <div key={action.actionKey} style={isHero ? styles.heroCard : styles.actionCard}>
                  <div style={styles.actionMeta}>
                    {isHero && <span style={styles.priorityBadge}>Top Priority</span>}
                    {!isHero && <span style={styles.actionRank}>#{action.rank}</span>}
                    <span style={styles.actionProduct}>{action.productTitle}</span>
                  </div>
                  <div style={isHero ? styles.heroTitle : styles.actionTitle}>
                    {action.recommendedAction}
                  </div>
                  {isHero && (
                    <>
                      <div style={styles.heroUrgency}>This is your highest-impact opportunity right now</div>
                      <div style={styles.heroTrust}>Based on your store performance data</div>
                      {action.estimatedImpactLabel && (
                        <div style={styles.heroImpactLine}>
                          Potential impact:{' '}
                          <strong>
                            {action.estimatedImpactLabel.startsWith('High')
                              ? 'High (top 10% opportunity)'
                              : action.estimatedImpactLabel}
                          </strong>
                        </div>
                      )}
                      <div style={styles.heroConfidence}>
                        Confidence: <strong>{confidenceLabel(action.severity)}</strong>
                      </div>
                    </>
                  )}
                  <div style={isHero ? styles.heroWhy : styles.actionWhy}>{action.whyNow}</div>
                  <div style={styles.actionFooter}>
                    {isDone ? (
                      <>
                        <span style={styles.doneBadge}>Done</span>
                        {roiMap[action.actionKey] && (
                          <span style={styles.roiPending}>
                            {roiMap[action.actionKey].status === 'measured' ? 'Impact measured' : 'Measuring impact…'}
                          </span>
                        )}
                      </>
                    ) : (
                      <div style={styles.btnWrap}>
                        {isHero && (
                          <div style={styles.startHereLabel}>
                            {topActions.every(a => a.executionStatus === 'pending')
                              ? 'Fix this first — highest impact'
                              : 'Start here'}
                          </div>
                        )}
                        <button
                          style={isHero ? styles.heroDoneBtn : styles.doneBtn}
                          disabled={isRunning}
                          onClick={() => handleExecute(action.actionKey)}
                        >
                          {isRunning ? 'Marking…' : isHero ? 'Fix this now' : 'Mark as Done'}
                        </button>
                      </div>
                    )}
                    {!isHero && action.estimatedImpactLabel && (
                      <span style={styles.impact}>{action.estimatedImpactLabel}</span>
                    )}
                  </div>
                  <RoiBlock roi={roiMap[action.actionKey] ?? null} />
                  {isHero && isDone && topActions[1] && topActions[1].executionStatus === 'pending' && (
                    <div style={styles.nextAction}>
                      <span style={styles.nextLabel}>Next best action:</span>
                      <span style={styles.nextTitle}>{topActions[1].recommendedAction}</span>
                      <button
                        style={styles.nextBtn}
                        disabled={executing.has(topActions[1].actionKey)}
                        onClick={() => handleExecute(topActions[1].actionKey)}
                      >
                        {executing.has(topActions[1].actionKey) ? 'Marking…' : 'Fix this next'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
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
// ---------------------------------------------------------------------------
// RoiBlock — shows before/after metrics under a completed action card
// ---------------------------------------------------------------------------
function fmt(n: number, prefix = '') {
  return `${prefix}${Math.round(n).toLocaleString()}`;
}

function fmtPct(n: number | null) {
  if (n === null) return null;
  return `${n > 0 ? '+' : ''}${Math.round(n)}%`;
}

function RoiBlock({ roi }: { roi: ExecutionResult | null }) {
  if (!roi) return null;

  if (roi.status === 'waiting_for_more_data' || !roi.summary) {
    return (
      <div style={roiStyles.wrap}>
        <span style={roiStyles.measuring}>Measuring impact…</span>
      </div>
    );
  }

  const { revenue, orders } = roi.summary;
  const revPct = fmtPct(revenue.changePercent);
  const ordPct = fmtPct(orders.changePercent);

  return (
    <div style={roiStyles.wrap}>
      <div style={roiStyles.row}>
        <span style={roiStyles.label}>Revenue</span>
        <span style={roiStyles.values}>
          ${fmt(revenue.before)} → ${fmt(revenue.after)}
          {revPct && <strong style={{ color: revenue.diff >= 0 ? '#16a34a' : '#dc2626' }}> ({revPct})</strong>}
        </span>
      </div>
      <div style={roiStyles.row}>
        <span style={roiStyles.label}>Orders</span>
        <span style={roiStyles.values}>
          {fmt(orders.before)} → {fmt(orders.after)}
          {ordPct && <strong style={{ color: orders.diff >= 0 ? '#16a34a' : '#dc2626' }}> ({ordPct})</strong>}
        </span>
      </div>
    </div>
  );
}

const roiStyles: Record<string, React.CSSProperties> = {
  wrap:      { marginTop: 10, paddingTop: 10, borderTop: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column', gap: 4 },
  measuring: { fontSize: 12, color: '#9ca3af', fontStyle: 'italic' },
  row:       { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 },
  label:     { color: '#9ca3af', minWidth: 52 },
  values:    { color: '#374151' },
};

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
  sections:       { display: 'flex', flexDirection: 'column', gap: 40 },
  sectionHeading: { fontSize: 16, fontWeight: 600, marginBottom: 12 },
  actionList:     { display: 'flex', flexDirection: 'column', gap: 8 },
  // hero card — rank 1
  heroCard:       { background: '#fffbeb', border: '2px solid #fbbf24', borderRadius: 10, padding: '18px 20px' },
  heroTitle:      { fontSize: 15, fontWeight: 700, color: '#111827', margin: '6px 0 8px' },
  heroWhy:        { fontSize: 13, color: '#4b5563', marginBottom: 12, lineHeight: 1.5 },
  heroDoneBtn:    { fontSize: 13, fontWeight: 700, padding: '7px 16px', borderRadius: 6, border: 'none', background: '#f59e0b', cursor: 'pointer', color: '#fff' },
  heroImpact:     { fontSize: 13, fontWeight: 700, color: '#92400e' },
  heroUrgency:    { fontSize: 12, fontWeight: 500, color: '#b45309', marginBottom: 4, fontStyle: 'italic' },
  heroTrust:      { fontSize: 11, color: '#9ca3af', marginBottom: 6 },
  heroImpactLine:  { fontSize: 12, color: '#4b5563', marginBottom: 4 },
  heroConfidence:  { fontSize: 12, color: '#6b7280', marginBottom: 10 },
  priorityBadge:  { fontSize: 10, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' as const, color: '#b45309', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 4, padding: '2px 7px' },
  // secondary cards — ranks 2 & 3
  actionCard:     { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 16px' },
  actionMeta:     { display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 4 },
  actionRank:     { fontSize: 11, fontWeight: 700, color: '#9ca3af' },
  actionTitle:    { fontSize: 13, fontWeight: 600, color: '#111827', margin: '2px 0 6px' },
  actionProduct:  { fontSize: 12, color: '#6b7280' },
  actionWhy:      { fontSize: 12, color: '#6b7280', marginBottom: 10 },
  actionFooter:   { display: 'flex', alignItems: 'center', gap: 12 },
  doneBtn:        { fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 6, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', color: '#374151' },
  doneBadge:      { fontSize: 12, fontWeight: 600, color: '#16a34a', padding: '5px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6 },
  roiText:        { fontSize: 12, color: '#16a34a', fontWeight: 500 },
  roiPending:     { fontSize: 12, color: '#9ca3af' },
  nextAction:     { marginTop: 10, paddingTop: 10, borderTop: '1px solid #fde68a', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const },
  nextLabel:      { fontSize: 11, color: '#b45309', fontWeight: 600 },
  nextTitle:      { fontSize: 12, color: '#374151', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  nextBtn:        { fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 5, border: '1px solid #fbbf24', background: '#fffbeb', cursor: 'pointer', color: '#92400e', whiteSpace: 'nowrap' as const },
  btnWrap:        { display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-start', gap: 4 },
  startHereLabel: { fontSize: 11, fontWeight: 700, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 4, padding: '2px 8px' },
  dailyBar:       { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 },
  dailyTitle:     { fontSize: 13, fontWeight: 700, color: '#111827' },
  dailyMsg:       { fontSize: 12, color: '#6b7280' },
  impact:         { fontSize: 11, color: '#9ca3af' },
  errorBox:     { padding: '12px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#dc2626', fontSize: 13 },
  resultBox:    { padding: '16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8 },
  resultHeader: { fontSize: 14, fontWeight: 600, color: '#111827', marginBottom: 12 },
  resultList:   { display: 'flex', flexDirection: 'column', gap: 6 },
  resultRow:    { display: 'flex', gap: 12, alignItems: 'baseline', fontSize: 12 },
  resultKey:    { color: '#374151', fontFamily: 'monospace' },
  resultReason: { color: '#9ca3af' },
};
