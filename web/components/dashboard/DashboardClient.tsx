'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { DashboardPayload, ApplyResponse, TopAction } from '@/lib/api';
import { applySelected, fetchTopActions, executeAction } from '@/lib/api';
import TopWinsList               from './TopWinsList';
import ExecutionDetailsPanel     from './ExecutionDetailsPanel';
import StoreSuggestionsList      from './StoreSuggestionsList';
import DashboardKpiStrip         from './DashboardKpiStrip';
import OptimizationFeed          from './OptimizationFeed';
import type { FeedRow }          from './OptimizationFeed';
import ProductInspectorPanel     from './ProductInspectorPanel';
import type { FilterValue }      from './StoreSuggestionsList';

interface Props {
  data: DashboardPayload;
}

export default function DashboardClient({ data }: Props) {
  const SHOP = data.shop;

  const router         = useRouter();
  const searchParams   = useSearchParams();
  const selectedExecId = searchParams.get('executionId');
  const demoMode       = searchParams.get('demoTomorrow') === '1';

  const [selected,        setSelected]        = useState<Set<string>>(new Set());
  const [suggestionCounts, setSuggestionCounts] = useState({ open: 0, completed: 0, blocked: 0 });
  const [activeFilter,    setActiveFilter]    = useState<FilterValue>('ALL');
  const [isApplying,      setIsApplying]      = useState(false);
  const [applyResult,     setApplyResult]     = useState<ApplyResponse | null>(null);
  const [applyError,      setApplyError]      = useState<string | null>(null);

  const [topActions,  setTopActions]  = useState<TopAction[]>([]);
  const [executing,   setExecuting]   = useState<Set<string>>(new Set());
  const [focusedRow,  setFocusedRow]  = useState<FeedRow | null>(null);

  useEffect(() => {
    fetchTopActions(SHOP).then(setTopActions).catch(() => {});
  }, []);

  const handleExecute = async (actionKey: string) => {
    setExecuting(prev => new Set(prev).add(actionKey));
    try {
      await executeAction(SHOP, actionKey);
      const refreshed = await fetchTopActions(SHOP);
      setTopActions(refreshed);
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
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setIsApplying(false);
    }
  };

  // Default inspector focus: highest-priority action, then first ready item.
  const defaultFocusRow = useMemo((): FeedRow | null => {
    if (topActions.length > 0) {
      const a = topActions[0];
      return {
        key:          `action::${a.actionKey}`,
        feedStatus:   a.openMeasurementWindow ? 'measuring' : 'queued',
        productTitle: a.productTitle,
        issueId:      a.issueId,
        topAction:    a,
      };
    }
    const readyItems = data.review.groups.readyToApply;
    if (readyItems.length > 0) {
      const item = readyItems[0];
      return {
        key:          `ready::${item.selectionKey}`,
        feedStatus:   'ready',
        productTitle: item.productTitle,
        issueId:      item.issueId,
        readyItem:    item,
      };
    }
    return null;
  }, [topActions, data.review.groups.readyToApply]);

  const statusMessages = useMemo(() => {
    const msgs: string[] = ['Optimizing your store · 24/7 · always on'];
    const scanned = data.review.summary.requestedProductCount ?? 0;
    if (scanned > 0) msgs.push(`${scanned} product${scanned === 1 ? '' : 's'} in active optimization scope`);
    if (topActions.length > 0) msgs.push(`${topActions.length} high-upside improvement${topActions.length === 1 ? '' : 's'} ranked and ready`);
    if (data.overview.waitingExecutions > 0) msgs.push(`${data.overview.waitingExecutions} change${data.overview.waitingExecutions === 1 ? '' : 's'} measuring revenue impact now`);
    if (data.recentActivity.length > 0) msgs.push('Every applied change is reversible · rollback always available');
    return msgs;
  }, [data.review.summary.requestedProductCount, topActions.length, data.overview.waitingExecutions, data.recentActivity.length]);

  return (
    <div style={styles.sections}>
      {demoMode && (
        <div style={styles.demoBanner}>
          Tomorrow preview — displaying today&apos;s real sales as post-measurement state. No data was changed.
        </div>
      )}

      {/* ── A: KPI strip ────────────────────────────────────────────────── */}
      <DashboardKpiStrip shop={SHOP} overview={data.overview} review={data.review} />

      {/* ── System status bar ───────────────────────────────────────────── */}
      <SystemStatusBar messages={statusMessages} />

      {/* ── B: Grouped optimization feed + left inspector ───────────────── */}
      <section style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        <ProductInspectorPanel row={focusedRow ?? defaultFocusRow} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <OptimizationFeed
            shop={SHOP}
            readyItems={data.review.groups.readyToApply}
            topActions={topActions}
            recentActivity={data.recentActivity}
            executing={executing}
            selected={selected}
            isApplying={isApplying}
            applyResult={applyResult}
            applyError={applyError}
            onRunAction={handleExecute}
            onToggle={toggle}
            onSelectAll={selectAll}
            onClearSelection={clearSelect}
            onApply={handleApply}
            onFocus={setFocusedRow}
          />
        </div>
      </section>

      {/* ── C: Scale what's working ─────────────────────────────────────── */}
      <section>
        <TopWinsList items={data.topWins} />
        <h2 style={styles.sectionHeading}>Scale what&apos;s working</h2>
        <StoreSuggestionsList
          shop={SHOP}
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
      </section>

      {selectedExecId && (
        <ExecutionDetailsPanel
          shop={SHOP}
          executionId={selectedExecId}
          onClose={() => router.push('/dashboard')}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SystemStatusBar — autonomous monitoring status strip
// ---------------------------------------------------------------------------
function SystemStatusBar({ messages }: { messages: string[] }) {
  const [idx,     setIdx]     = useState(0);
  const [visible, setVisible] = useState(true);
  const [pulse,   setPulse]   = useState(true);

  useEffect(() => {
    if (messages.length <= 1) return;
    const id = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIdx(i => (i + 1) % messages.length);
        setVisible(true);
      }, 350);
    }, 4200);
    return () => clearInterval(id);
  }, [messages.length]);

  useEffect(() => {
    const id = setInterval(() => setPulse(p => !p), 1600);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={sysStyles.bar}>
      <span style={{ ...sysStyles.dot, opacity: pulse ? 1 : 0.3, transition: 'opacity 1.4s ease' }} />
      <span style={{ ...sysStyles.text, opacity: visible ? 1 : 0, transition: 'opacity 0.35s ease' }}>
        {messages[idx]}
      </span>
      <span style={sysStyles.liveChip}>Live</span>
    </div>
  );
}

const sysStyles: Record<string, React.CSSProperties> = {
  bar:      { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', background: 'rgba(34,197,94,0.04)', border: '1px solid rgba(34,197,94,0.14)', borderRadius: 8 },
  dot:      { width: 7, height: 7, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px rgba(34,197,94,0.55)', flexShrink: 0 },
  text:     { fontSize: 12, color: '#9ca3af', letterSpacing: '0.02em', flex: 1 },
  liveChip: { fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase' as const, color: '#22c55e', opacity: 0.65 },
};

const styles: Record<string, React.CSSProperties> = {
  sections:       { display: 'flex', flexDirection: 'column', gap: 20 },
  demoBanner:     { fontSize: 11, color: '#d97706', background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.2)', borderRadius: 6, padding: '7px 14px', lineHeight: 1.5 },
  sectionHeading: { fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' as const, color: '#6b7280', marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid rgba(255,255,255,0.06)', margin: '0 0 14px' },
};
