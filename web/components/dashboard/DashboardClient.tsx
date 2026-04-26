'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { DashboardPayload, ApplyResponse, TopAction, ExecutionResult, EarlySignal, ActivityItem } from '@/lib/api';
import { applySelected, fetchTopActions, executeAction, fetchExecutionResults, fetchEarlySignal, issueLabel } from '@/lib/api';
import StoreOverview                from './StoreOverview';
import ReadyToApplyList             from './ReadyToApplyList';
import TopWinsList                  from './TopWinsList';
import RecentActivityList           from './RecentActivityList';
import ExecutionDetailsPanel        from './ExecutionDetailsPanel';
import RevenueDashboard             from './RevenueDashboard';
import MerchantSummary              from './MerchantSummary';
import StoreSuggestionsList         from './StoreSuggestionsList';
import DashboardStickySummaryBar    from './DashboardStickySummaryBar';
import type { FilterValue }         from './StoreSuggestionsList';

const SHOP = process.env.NEXT_PUBLIC_SHOP ?? '';

interface Props {
  data: DashboardPayload;
}

// ---------------------------------------------------------------------------
// computeNextBestAction
//
// Three possible outcomes (priority order):
//   'action'      — a winning completed action exists + a pending action follows
//   'maintenance' — a winning completed action exists but all actions are done
//   null          — no completed action has measured positive ROI yet → show nothing
//
// "Winning" = executionStatus completed AND roi.summary.revenue.changePercent > 0.
// We pick the highest-ranked such action (first in array = highest priority).
// The suggested next target is the first remaining pending action.
// ---------------------------------------------------------------------------
type NBAResult =
  | { type: 'action';      target: TopAction; sourceTitle: string; reason: string }
  | { type: 'maintenance'; sourceTitle: string }
  | null;

function computeNextBestAction(
  actions:  TopAction[],
  roiMap:   Record<string, ExecutionResult>,
): NBAResult {
  const winner = actions.find(a => {
    if (a.executionStatus !== 'completed') return false;
    const roi = roiMap[a.actionKey];
    return roi?.status === 'measured' && (roi.summary?.revenue?.changePercent ?? 0) > 0;
  });

  if (!winner) return null;

  const nextPending = actions.find(a => a.executionStatus === 'pending');

  if (!nextPending) {
    return { type: 'maintenance', sourceTitle: winner.productTitle };
  }

  return {
    type:        'action',
    target:      nextPending,
    sourceTitle: winner.productTitle,
    reason:      `Your fix for ${winner.productTitle} is working — keep the momentum`,
  };
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

  // Day-1 Momentum — session-scoped, resets each calendar day
  const [sessionStep, setSessionStep] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    try {
      const raw = sessionStorage.getItem('cro_day1_momentum');
      if (!raw) return 0;
      const { step, date } = JSON.parse(raw) as { step: number; date: string };
      const today = new Date().toISOString().slice(0, 10);
      return date === today ? Math.min(step, 3) : 0;
    } catch { return 0; }
  });

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
      setSessionStep(prev => {
        const next = Math.min(prev + 1, 3);
        const today = new Date().toISOString().slice(0, 10);
        try { sessionStorage.setItem('cro_day1_momentum', JSON.stringify({ step: next, date: today })); } catch {}
        return next;
      });
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
      <MerchantSummary
        shop={SHOP}
        overview={data.overview}
        review={data.review}
        recentActivity={data.recentActivity}
      />
      <RevenueDashboard shop={SHOP} />
      {topActions.length > 0 && (() => {
        const pending     = topActions.filter(a => a.executionStatus === 'pending');
        const revenueRisk = pending.reduce((sum, a) => sum + Math.round(a.revenue / 30), 0);
        return (
          <div style={styles.todayCard}>
            <span style={styles.todayTitle}>Today&apos;s opportunities</span>
            {pending.length > 0 ? (
              <div style={styles.todayBody}>
                <span style={styles.todayCount}>
                  {pending.length} new opportunit{pending.length === 1 ? 'y' : 'ies'} detected today
                </span>
                {revenueRisk > 0 && (
                  <span style={styles.todayRisk}>
                    ${revenueRisk.toLocaleString()}/day at risk across your store
                  </span>
                )}
              </div>
            ) : (
              <span style={styles.todayStable}>Your store is stable today — no urgent issues</span>
            )}
          </div>
        );
      })()}
      {(() => {
        const { productsImproved, avgOrders, avgRevenue } = computeWeeklyGrowth(data.recentActivity);
        if (productsImproved === 0) return null;
        const fmtPctStat = (n: number | null) => n === null ? null : `${n >= 0 ? '+' : ''}${Math.round(n)}%`;
        return (
          <div style={styles.weeklyWrap}>
            <span style={styles.weeklyLabel}>This week</span>
            <div style={styles.weeklyStats}>
              {avgOrders !== null && (
                <span style={styles.weeklyStat}>
                  You drove{' '}<strong style={{ color: avgOrders >= 0 ? '#166534' : '#dc2626' }}>{fmtPctStat(avgOrders)}</strong>{' '}conversion improvement
                </span>
              )}
              {avgRevenue !== null && (
                <span style={styles.weeklyStat}>
                  You generated{' '}<strong style={{ color: avgRevenue >= 0 ? '#166534' : '#dc2626' }}>{fmtPctStat(avgRevenue)}</strong>{' '}revenue improvement
                </span>
              )}
              <span style={styles.weeklyStat}>
                You improved{' '}<strong style={{ color: '#166534' }}>{productsImproved}</strong>{' '}product{productsImproved === 1 ? '' : 's'} this week
              </span>
            </div>
          </div>
        );
      })()}
      {data.overview.totalAppliedExecutions > 0 && (
        <div style={styles.successStack}>
          <span style={styles.successMain}>
            You&apos;ve completed{' '}
            <strong>{data.overview.totalAppliedExecutions}</strong>{' '}
            optimization{data.overview.totalAppliedExecutions === 1 ? '' : 's'}
          </span>
          {data.overview.measuredExecutions > 0 && (
            <span style={styles.successSub}>
              {data.overview.measuredExecutions} improvement{data.overview.measuredExecutions === 1 ? '' : 's'} measured this week
            </span>
          )}
        </div>
      )}
      <StoreOverview overview={data.overview} />

      <ReadyToApplyList
        shop={SHOP}
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
          {sessionStep < 3 ? (
            <div style={styles.day1Wrap}>
              <div style={styles.day1Header}>
                <span style={styles.day1Step}>Step {sessionStep + 1} of 3</span>
                <span style={styles.day1Hint}>Complete 3 fixes to hit your daily goal</span>
              </div>
              <div style={styles.day1Track}>
                <div style={{ ...styles.day1Fill, width: `${Math.round((sessionStep / 3) * 100)}%` }} />
              </div>
            </div>
          ) : (
            <div style={styles.day1Complete}>
              <div>You&apos;ve improved 3 products today 🚀</div>
              {(() => {
                const labels = topActions.map(a => a.estimatedImpactLabel).filter(Boolean) as string[];
                const impact = labels.some(l => l.startsWith('High'))
                  ? 'High revenue opportunity'
                  : labels.some(l => l.startsWith('Medium'))
                  ? 'Medium revenue opportunity'
                  : labels.length > 0 ? 'Low revenue opportunity' : null;
                return impact
                  ? <div style={styles.day1Impact}>Estimated impact: {impact}</div>
                  : null;
              })()}
            </div>
          )}
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
                  {isHero && (
                    <div style={styles.momentumRow}>
                      <span style={styles.momentumLabel}>Biggest opportunity today</span>
                      {action.estimatedImpactLabel?.startsWith('High') && (
                        <span style={styles.momentumChipGreen}>Highest impact today</span>
                      )}
                      {action.quickWin && (
                        <span style={styles.momentumChipBlue}>Quick win — see results fast</span>
                      )}
                    </div>
                  )}
                  {isHero && (action.estimatedImpactLabel?.startsWith('High') || action.revenue > 0) && (
                    <div style={styles.lossFrame}>
                      {action.estimatedImpactLabel?.startsWith('High') && (
                        <span style={styles.lossText}>Losing potential revenue if not fixed</span>
                      )}
                      {action.revenue > 0 && (
                        <span style={styles.lossDailyText}>
                          ~${Math.round(action.revenue / 30).toLocaleString()}/day at risk
                        </span>
                      )}
                    </div>
                  )}
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
                  {isDone && (
                    <WinFeedback
                      roi={roiMap[action.actionKey] ?? null}
                      quickWin={action.quickWin}
                      earlySignalEligible={action.earlySignalEligible}
                      shop={SHOP}
                      productId={action.productId}
                    />
                  )}
                  <RoiBlock roi={roiMap[action.actionKey] ?? null} />
                  {isHero && isDone && (() => {
                    const nba = computeNextBestAction(topActions, roiMap);
                    if (!nba) return null;

                    if (nba.type === 'maintenance') {
                      return (
                        <div style={styles.nextAction}>
                          <div style={styles.nbaWrap}>
                            <span style={styles.nbaBadge}>Maintenance Mode</span>
                            <span style={styles.nbaReason}>
                              All high-priority fixes applied — your store is optimized.
                              Run a deep audit to find new opportunities.
                            </span>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div style={styles.nextAction}>
                        <div style={styles.nbaWrap}>
                          <span style={styles.nbaBadge}>Smart Suggestion</span>
                          <span style={styles.nbaReason}>{nba.reason}</span>
                        </div>
                        <span style={styles.nextTitle}>{nba.target.recommendedAction}</span>
                        <button
                          style={styles.nextBtn}
                          disabled={executing.has(nba.target.actionKey)}
                          onClick={() => handleExecute(nba.target.actionKey)}
                        >
                          {executing.has(nba.target.actionKey) ? 'Marking…' : 'Fix this next'}
                        </button>
                      </div>
                    );
                  })()}
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

function computeWeeklyGrowth(items: ActivityItem[]) {
  const weekAgo    = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekItems  = items.filter(i => new Date(i.createdAt).getTime() >= weekAgo);
  const measured   = weekItems.filter(i => i.resultStatus === 'measured');

  const avgOf = (arr: ActivityItem[], key: keyof ActivityItem) => {
    const vals = arr.map(i => i[key] as number | null).filter((v): v is number => v !== null);
    return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };

  return {
    productsImproved: weekItems.length,
    avgOrders:        avgOf(measured, 'ordersChangePercent'),
    avgRevenue:       avgOf(measured, 'revenueChangePercent'),
  };
}

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
              {item.status === 'applied' ? 'Live' : item.status === 'skipped' ? 'Skipped' : 'Failed'}
            </span>
            <span style={styles.resultKey}>{issueLabel(item.issueId)}</span>
            {item.reason && <span style={styles.resultReason}>{item.reason}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WinFeedback
// Shown just above RoiBlock for any completed action.
// Three tiers (priority order): earlySignal > ROI positive > base done.
// ---------------------------------------------------------------------------
function WinFeedback({
  roi, quickWin, earlySignalEligible, shop, productId,
}: {
  roi: ExecutionResult | null;
  quickWin: boolean;
  earlySignalEligible: boolean;
  shop: string;
  productId: string;
}) {
  const [signal, setSignal] = useState<EarlySignal | null>(null);

  useEffect(() => {
    if (!quickWin || !earlySignalEligible) return;
    fetchEarlySignal(shop, productId).then(setSignal).catch(() => {});
  }, [quickWin, earlySignalEligible, shop, productId]);

  if (signal?.signal === 'positive') {
    return (
      <div style={winStyles.early}>
        <span style={winStyles.dot} />
        Early win detected — engagement improving
      </div>
    );
  }

  const roiPositive =
    roi?.status === 'measured' && (roi.summary?.revenue?.changePercent ?? 0) > 0;

  if (roiPositive) {
    return <div style={winStyles.win}>Win unlocked — performance improved</div>;
  }

  return <div style={winStyles.done}>Nice — action completed</div>;
}

const winStyles: Record<string, React.CSSProperties> = {
  done:  { fontSize: 12, fontWeight: 600, color: '#374151', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 6, padding: '5px 10px', marginBottom: 8 },
  win:   { fontSize: 12, fontWeight: 700, color: '#166534', background: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: 6, padding: '5px 10px', marginBottom: 8 },
  early: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: '#166534', background: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: 6, padding: '5px 10px', marginBottom: 8 },
  dot:   { width: 7, height: 7, borderRadius: '50%', background: '#16a34a', flexShrink: 0 },
};

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
  nbaWrap:        { display: 'flex', flexDirection: 'column' as const, gap: 2, width: '100%', marginBottom: 6 },
  nbaBadge:       { fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 4, padding: '2px 7px', alignSelf: 'flex-start' as const },
  nbaReason:      { fontSize: 11, color: '#6b7280', fontStyle: 'italic' as const },
  btnWrap:        { display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-start', gap: 4 },
  startHereLabel: { fontSize: 11, fontWeight: 700, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 4, padding: '2px 8px' },
  todayCard:         { padding: '12px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, display: 'flex', flexDirection: 'column' as const, gap: 6 },
  todayTitle:        { fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase' as const, color: '#6b7280' },
  todayBody:         { display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' as const },
  todayCount:        { fontSize: 14, fontWeight: 700, color: '#111827' },
  todayRisk:         { fontSize: 13, fontWeight: 600, color: '#dc2626' },
  todayStable:       { fontSize: 13, color: '#6b7280' },
  weeklyWrap:        { display: 'flex', alignItems: 'baseline', gap: 12, padding: '10px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, flexWrap: 'wrap' as const },
  weeklyLabel:       { fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase' as const, color: '#92400e', flexShrink: 0 },
  weeklyStats:       { display: 'flex', gap: 16, flexWrap: 'wrap' as const, alignItems: 'baseline' },
  weeklyStat:        { fontSize: 13, color: '#374151' },
  successStack:      { display: 'flex', alignItems: 'baseline', gap: 16, padding: '10px 16px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, flexWrap: 'wrap' as const },
  successMain:       { fontSize: 14, color: '#166534' },
  successSub:        { fontSize: 12, color: '#4ade80', fontWeight: 500 },
  day1Wrap:          { marginBottom: 14 },
  day1Header:        { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 },
  day1Step:          { fontSize: 13, fontWeight: 700, color: '#111827' },
  day1Hint:          { fontSize: 12, color: '#9ca3af' },
  day1Track:         { height: 5, background: '#e5e7eb', borderRadius: 99, overflow: 'hidden' },
  day1Fill:          { height: '100%', background: '#f59e0b', borderRadius: 99, transition: 'width 0.4s ease' },
  day1Complete:      { fontSize: 14, fontWeight: 700, color: '#166534', background: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 16px', marginBottom: 14, textAlign: 'center' as const, display: 'flex', flexDirection: 'column' as const, gap: 4 },
  day1Impact:        { fontSize: 12, fontWeight: 500, color: '#166534', opacity: 0.8 },
  lossFrame:         { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' as const },
  lossText:          { fontSize: 12, fontWeight: 600, color: '#b91c1c' },
  lossDailyText:     { fontSize: 15, fontWeight: 800, color: '#dc2626', letterSpacing: '-0.02em' },
  momentumRow:       { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' as const, marginBottom: 6 },
  momentumLabel:     { fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase' as const, color: '#b45309' },
  momentumChipGreen: { fontSize: 11, fontWeight: 600, color: '#166534', background: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: 4, padding: '2px 7px' },
  momentumChipBlue:  { fontSize: 11, fontWeight: 600, color: '#1d4ed8', background: '#dbeafe', border: '1px solid #bfdbfe', borderRadius: 4, padding: '2px 7px' },
  dailyBar:          { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 },
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
