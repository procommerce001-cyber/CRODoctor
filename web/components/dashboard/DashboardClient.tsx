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

  return (
    <div style={styles.sections}>
      {demoMode && (
        <div style={styles.demoBanner}>
          Tomorrow preview — displaying today&apos;s real sales as post-measurement state. No data was changed.
        </div>
      )}

      {/* ── A: KPI strip ────────────────────────────────────────────────── */}
      <DashboardKpiStrip shop={SHOP} overview={data.overview} review={data.review} />

      {/* ── B: Narrow navigator (left) + wide inspector canvas (right) ──── */}
      <section style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
        <div style={{ width: 320, flexShrink: 0, minWidth: 0 }}>
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
            onSelect={(row) => setFocusedRow(row)}
            selectedKey={(focusedRow ?? defaultFocusRow)?.key ?? null}
            narrow
          />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <ProductInspectorPanel
              row={focusedRow ?? defaultFocusRow}
              onRunAction={handleExecute}
              executing={executing}
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

const styles: Record<string, React.CSSProperties> = {
  sections:       { display: 'flex', flexDirection: 'column', gap: 24 },
  demoBanner:     { fontSize: 11, color: '#d97706', background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.2)', borderRadius: 6, padding: '7px 14px', lineHeight: 1.5 },
  sectionHeading: { fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' as const, color: '#6b7280', marginBottom: 14, paddingBottom: 10, borderBottom: '1px solid rgba(255,255,255,0.06)', margin: '0 0 14px' },
};
