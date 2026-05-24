'use client';

import { useState } from 'react';
import type { ReviewItem, TopAction, ActivityItem, ContentPreview, ApplyResponse } from '@/lib/api';
import { fetchContentPreview, applySelected, issueLabel, API_BASE, apiHeaders } from '@/lib/api';

// ── Types ──────────────────────────────────────────────────────────────────────

export type FeedStatus    = 'ready' | 'queued' | 'live' | 'measuring' | 'measured' | 'rolled_back';
type SectionFilter = 'all' | 'ready' | 'wins' | 'measuring' | 'upnext' | 'protected';

const PILL_CFG: Record<FeedStatus, { label: string; color: string; bg: string; border: string }> = {
  ready:       { label: 'Ready',       color: '#ffffff', bg: '#15803d',                    border: 'transparent' },
  queued:      { label: 'Up next',     color: '#9ca3af', bg: 'rgba(255,255,255,0.05)',      border: 'rgba(255,255,255,0.10)' },
  live:        { label: 'Live',        color: '#4ade80', bg: 'rgba(34,197,94,0.08)',        border: 'rgba(34,197,94,0.22)' },
  measuring:   { label: 'Measuring',   color: '#fbbf24', bg: 'rgba(251,191,36,0.08)',       border: 'rgba(251,191,36,0.22)' },
  measured:    { label: 'Measured',    color: '#60a5fa', bg: 'rgba(96,165,250,0.08)',       border: 'rgba(96,165,250,0.22)' },
  rolled_back: { label: 'Rolled back', color: '#6b7280', bg: 'rgba(107,114,128,0.06)',      border: 'rgba(107,114,128,0.18)' },
};

export interface FeedRow {
  key:           string;
  feedStatus:    FeedStatus;
  productTitle:  string | null;
  issueId:       string;
  readyItem?:    ReviewItem;
  topAction?:    TopAction;
  activityItem?: ActivityItem;
}

interface PreviewState  { loading: boolean; data: ContentPreview | null; error: string | null }
interface ApplyState    { applying: boolean; applied: boolean; error: string | null }
interface RollbackState { rolling: boolean; done: boolean; error: string | null }

interface Props {
  shop:             string;
  readyItems:       ReviewItem[];
  topActions:       TopAction[];
  recentActivity:   ActivityItem[];
  executing:        Set<string>;
  selected:         Set<string>;
  isApplying:       boolean;
  applyResult:      ApplyResponse | null;
  applyError:       string | null;
  onRunAction:      (actionKey: string) => void;
  onToggle:         (key: string) => void;
  onSelectAll:      () => void;
  onClearSelection: () => void;
  onApply:          () => void;
  onFocus?:         (row: FeedRow) => void;
}

// ── Data helpers ───────────────────────────────────────────────────────────────

function classifyActivity(item: ActivityItem): FeedStatus {
  if (item.status === 'rolled_back' || item.status === 'failed') return 'rolled_back';
  if (item.resultStatus === 'measured')              return 'measured';
  if (item.resultStatus === 'waiting_for_more_data') return 'measuring';
  if (item.status === 'applied')                     return 'live';
  return 'rolled_back';
}

function isPublishableWin(item: ActivityItem): boolean {
  const publishable = item.measurementConfidence === 'low'
    || item.measurementConfidence === 'medium'
    || item.measurementConfidence === 'high';
  return publishable && (item.revenueChangePercent ?? 0) > 0;
}

function buildRows(
  readyItems:     ReviewItem[],
  topActions:     TopAction[],
  recentActivity: ActivityItem[],
): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const item of readyItems)
    rows.push({ key: `ready::${item.selectionKey}`,  feedStatus: 'ready',
      productTitle: item.productTitle, issueId: item.issueId, readyItem: item });
  for (const action of topActions) {
    if (action.executionStatus !== 'pending') continue;
    const feedStatus: FeedStatus = action.openMeasurementWindow ? 'measuring' : 'queued';
    rows.push({ key: `action::${action.actionKey}`, feedStatus,
      productTitle: action.productTitle, issueId: action.issueId, topAction: action });
  }
  for (const item of recentActivity)
    rows.push({ key: `activity::${item.executionId}`, feedStatus: classifyActivity(item),
      productTitle: item.productTitle, issueId: item.issueId, activityItem: item });
  return rows;
}

function groupRows(rows: FeedRow[]) {
  const ready      = rows.filter(r => r.feedStatus === 'ready');
  const wins       = rows.filter(r => r.feedStatus === 'measured' && r.activityItem && isPublishableWin(r.activityItem));
  const measuring  = rows.filter(r => r.feedStatus === 'measuring' || r.feedStatus === 'live');
  const upnext     = rows.filter(r => r.feedStatus === 'queued');
  const protection = rows.filter(r =>
    r.feedStatus === 'rolled_back' ||
    (r.feedStatus === 'measured' && r.activityItem && !isPublishableWin(r.activityItem)),
  );
  return { ready, wins, measuring, upnext, protection };
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatReadyAt(iso: string | null): string {
  if (!iso) return 'soon';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Copy helpers ───────────────────────────────────────────────────────────────

const COPY_INTENT_NOTE: Record<string, string> = {
  weak_desire_creation:  'Written to make buyers feel what owning this product is like — not to list features.',
  no_description:        'Written as a complete description from scratch, based on what this product needs to say.',
  description_too_short: 'Extends what you already have without repeating it — adds the persuasion layer that\'s missing.',
  no_risk_reversal:      'Adds reassurance at the moment buyers hesitate — a guarantee or return signal.',
  no_trust_bullets:      'Adds specific proof points that make buyers more confident before they decide.',
};

function patchDescription(mode: string | null): string {
  if (mode === 'replace_full_body')     return 'This will replace your current product description.';
  if (mode === 'insert_after_anchor')   return 'This will add new content to your product description.';
  if (mode === 'replace_matched_block') return 'This will update a section of your product description.';
  return 'This will update your product description.';
}

function proposedLabel(mode: string | null): string {
  return mode === 'replace_full_body' ? 'What will replace it' : 'What will be added';
}

function stripHtml(html: string | null): string {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Presentational sub-components ─────────────────────────────────────────────

function SectionBlock({ accent, label, count, sub, muted = false, children }: {
  accent:   string;
  label:    string;
  count:    number;
  sub:      string;
  muted?:   boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ opacity: muted ? 0.65 : 1 }}>
      <div style={{ borderTop: `2px solid ${accent}`, paddingTop: 12, marginBottom: 12 }}>
        <div style={sb.titleRow}>
          <span style={sb.label}>{label}</span>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
            color: accent, background: `${accent}18`, border: `1px solid ${accent}30`,
          }}>
            {count}
          </span>
        </div>
        <p style={sb.sub}>{sub}</p>
      </div>
      {children}
    </div>
  );
}

function Pill({ status }: { status: FeedStatus }) {
  const cfg = PILL_CFG[status];
  return (
    <span style={{
      display: 'inline-block', flexShrink: 0,
      fontSize: 9, fontWeight: 800, letterSpacing: '0.10em',
      textTransform: 'uppercase' as const, color: cfg.color,
      background: cfg.bg, border: `1px solid ${cfg.border}`,
      borderRadius: 4, padding: '2px 7px', whiteSpace: 'nowrap' as const,
      minWidth: 62, textAlign: 'center' as const,
    }}>
      {cfg.label}
    </span>
  );
}

// Win card — elevated treatment showing lift prominently
function WinCard({ row }: { row: FeedRow }) {
  const item = row.activityItem!;
  const pct  = item.revenueChangePercent ?? 0;
  const conf = item.measurementConfidence;
  const confLabel =
    conf === 'high'   ? 'High confidence result' :
    conf === 'medium' ? 'Confirmed · medium confidence' :
                        'Positive signal · early data';
  return (
    <div style={wc.card}>
      <div style={wc.main}>
        {item.productTitle && <span style={wc.product}>{item.productTitle}</span>}
        <span style={wc.issue}>{issueLabel(item.issueId)}</span>
        {item.insight && <span style={wc.insight}>{item.insight}</span>}
        <span style={wc.confTag}>{confLabel}</span>
      </div>
      <div style={wc.right}>
        <span style={wc.pct}>+{Math.round(pct)}%</span>
        <span style={wc.pctLabel}>revenue · 7-day</span>
        <span style={wc.date}>{formatDate(item.createdAt)}</span>
      </div>
    </div>
  );
}

// Hero card for the #1 "Up next" action
function HeroNextCard({ row, executing, onRunAction }: {
  row:         FeedRow;
  executing:   Set<string>;
  onRunAction: (key: string) => void;
}) {
  const action    = row.topAction!;
  const isRunning = executing.has(action.actionKey);
  return (
    <div style={un.hero}>
      <div style={un.heroTopRow}>
        <span style={un.heroRank}>#1 priority</span>
        {action.estimatedImpactLabel && <span style={un.heroImpact}>{action.estimatedImpactLabel}</span>}
      </div>
      <span style={un.heroProduct}>{action.productTitle}</span>
      <span style={un.heroCategory}>{issueLabel(action.issueId)}</span>
      <span style={un.heroAction}>{action.recommendedAction}</span>
      {action.whyNow && <span style={un.heroWhy}>{action.whyNow}</span>}
      <button
        style={{ ...un.heroBtn, opacity: isRunning ? 0.6 : 1 }}
        disabled={isRunning}
        onClick={() => onRunAction(action.actionKey)}
      >
        {isRunning ? 'Running…' : 'Run this improvement'}
      </button>
    </div>
  );
}

function PreviewPanel({ item, preview, applyState, onApply, onClose }: {
  item:       ReviewItem;
  preview:    ContentPreview;
  applyState: ApplyState | null;
  onApply:    () => void;
  onClose:    () => void;
}) {
  return (
    <div style={pp.wrap}>
      <div style={pp.contextRow}>
        <span style={pp.contextText}>{patchDescription(preview.patchMode)}</span>
        {preview.diffSummary && <span style={pp.diffNote}>{preview.diffSummary.note}</span>}
      </div>
      {preview.eligibleToApply ? (
        <>
          {COPY_INTENT_NOTE[item.issueId] && (
            <p style={pp.intentNote}>{COPY_INTENT_NOTE[item.issueId]}</p>
          )}
          {preview.currentContent && (
            <div style={{ marginBottom: 8 }}>
              <div style={pp.label}>What&apos;s on your page now</div>
              <div style={{ ...pp.text, color: '#4b5563', maxHeight: 60, overflow: 'hidden' }}>
                {stripHtml(preview.currentContent)}
              </div>
            </div>
          )}
          <div>
            <div style={{ ...pp.label, color: '#4ade80' }}>{proposedLabel(preview.patchMode)}</div>
            <div style={{ ...pp.text, borderColor: 'rgba(34,197,94,0.22)', background: 'rgba(34,197,94,0.05)' }}>
              {preview.proposedContent}
            </div>
          </div>
          <div style={pp.reversibility}>This change affects only this product. You can undo it instantly if needed.</div>
          <div style={pp.actions}>
            <button
              style={{ ...pp.btnApply, opacity: applyState?.applying ? 0.6 : 1 }}
              disabled={applyState?.applying}
              onClick={onApply}
            >
              {applyState?.applying ? 'Applying…' : 'Apply this change'}
            </button>
            <button style={pp.btnCancel} onClick={onClose} disabled={applyState?.applying}>
              Cancel
            </button>
            {applyState?.error && <span style={{ color: '#f87171', fontSize: 12 }}>{applyState.error}</span>}
          </div>
        </>
      ) : (
        <div style={{ color: '#f87171', fontSize: 12 }}>Not available: {preview.blockReason}</div>
      )}
    </div>
  );
}

function ApplyResultBox({ result }: { result: ApplyResponse }) {
  const STATUS_COLOR: Record<string, string> = { applied: '#16a34a', skipped: '#d97706', failed: '#dc2626' };
  return (
    <div style={{ padding: '12px 14px', background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.14)', borderRadius: 7, marginBottom: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#f9fafb', marginBottom: 8 }}>
        Apply complete —{' '}
        <span style={{ color: '#16a34a' }}>{result.appliedCount} applied</span>
        {result.skippedCount > 0 && <span style={{ color: '#d97706' }}> · {result.skippedCount} skipped</span>}
        {result.failedCount  > 0 && <span style={{ color: '#dc2626' }}> · {result.failedCount} failed</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {result.results.map(item => (
          <div key={item.selectionKey} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 12 }}>
            <span style={{ color: STATUS_COLOR[item.status] ?? '#9ca3af', fontWeight: 600, minWidth: 54 }}>
              {item.status === 'applied' ? 'Live' : item.status === 'skipped' ? 'Skipped' : 'Failed'}
            </span>
            <span style={{ color: '#9ca3af' }}>{issueLabel(item.issueId)}</span>
            {item.reason && <span style={{ color: '#4b5563' }}>{item.reason}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Feed filter toolbar ────────────────────────────────────────────────────────

const FILTER_TABS: { key: SectionFilter; label: string; color: string }[] = [
  { key: 'all',       label: 'All',       color: '#9ca3af' },
  { key: 'ready',     label: 'Ready',     color: '#22c55e' },
  { key: 'measuring', label: 'Measuring', color: '#fbbf24' },
  { key: 'wins',      label: 'Wins',      color: '#4ade80' },
  { key: 'upnext',    label: 'Up next',   color: '#60a5fa' },
  { key: 'protected', label: 'Protected', color: '#4b5563' },
];

function FeedFilterBar({
  active, onChange, counts,
}: {
  active:   SectionFilter;
  onChange: (f: SectionFilter) => void;
  counts:   Record<SectionFilter, number>;
}) {
  return (
    <div style={ff.bar}>
      {FILTER_TABS.map(tab => {
        const isActive = active === tab.key;
        const count    = counts[tab.key];
        const isEmpty  = count === 0 && tab.key !== 'all';
        return (
          <button
            key={tab.key}
            style={{
              ...ff.tab,
              color:        isActive ? tab.color : isEmpty ? '#374151' : '#6b7280',
              borderBottom: isActive ? `2px solid ${tab.color}` : '2px solid transparent',
              opacity:      isEmpty ? 0.45 : 1,
            }}
            onClick={() => onChange(tab.key)}
          >
            {tab.label}
            {count > 0 && (
              <span style={{
                ...ff.badge,
                color:      isActive ? tab.color     : '#4b5563',
                background: isActive ? `${tab.color}18` : 'rgba(255,255,255,0.04)',
                border:     `1px solid ${isActive ? tab.color + '28' : 'rgba(255,255,255,0.07)'}`,
              }}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function OptimizationFeed({
  shop, readyItems, topActions, recentActivity,
  executing, selected, isApplying, applyResult, applyError,
  onRunAction, onToggle, onSelectAll, onClearSelection, onApply, onFocus,
}: Props) {
  const [previews,    setPreviews]    = useState<Record<string, PreviewState>>({});
  const [applyStates, setApplyStates] = useState<Record<string, ApplyState>>({});
  const [rollbacks,    setRollbacks]    = useState<Record<string, RollbackState>>({});
  const [activeSection, setActiveSection] = useState<SectionFilter>('all');
  const [hoveredKey,   setHoveredKey]   = useState<string | null>(null);

  const rows = buildRows(readyItems, topActions, recentActivity);
  const { ready, wins, measuring, upnext, protection } = groupRows(rows);
  const selectableCount = readyItems.filter(i => i.selectable).length;
  const totalRows       = ready.length + wins.length + measuring.length + upnext.length + protection.length;

  const filterCounts: Record<SectionFilter, number> = {
    all:       totalRows,
    ready:     ready.length,
    wins:      wins.length,
    measuring: measuring.length,
    upnext:    upnext.length,
    protected: protection.length,
  };

  // ── Interaction handlers ────────────────────────────────────────────────────

  async function togglePreview(item: ReviewItem) {
    const key = item.selectionKey;
    if (previews[key]?.data) {
      setPreviews(p => { const n = { ...p }; delete n[key]; return n; });
      return;
    }
    setPreviews(p => ({ ...p, [key]: { loading: true, data: null, error: null } }));
    try {
      const data = await fetchContentPreview(shop, item.productId, item.issueId);
      setPreviews(p => ({ ...p, [key]: { loading: false, data, error: null } }));
    } catch (err) {
      setPreviews(p => ({ ...p, [key]: { loading: false, data: null, error: (err as Error).message } }));
    }
  }

  async function singleApply(item: ReviewItem) {
    const key = item.selectionKey;
    setApplyStates(s => ({ ...s, [key]: { applying: true, applied: false, error: null } }));
    try {
      const result = await applySelected(shop, [key]);
      const row    = result.results[0];
      if (row?.status === 'applied') {
        setApplyStates(s => ({ ...s, [key]: { applying: false, applied: true,  error: null } }));
        setPreviews(p => { const n = { ...p }; delete n[key]; return n; });
      } else {
        setApplyStates(s => ({ ...s, [key]: { applying: false, applied: false, error: row?.reason ?? 'Apply did not succeed.' } }));
      }
    } catch (err) {
      setApplyStates(s => ({ ...s, [key]: { applying: false, applied: false, error: (err as Error).message } }));
    }
  }

  async function doRollback(productId: string, issId: string, execId: string) {
    setRollbacks(r => ({ ...r, [execId]: { rolling: true, done: false, error: null } }));
    try {
      const res = await fetch(
        `${API_BASE}/action-center/products/${encodeURIComponent(productId)}/rollback`,
        { method: 'POST', credentials: 'include', headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ shop, issueId: issId }) },
      );
      if (!res.ok) throw new Error(await res.text());
      setRollbacks(r => ({ ...r, [execId]: { rolling: false, done: true,  error: null } }));
    } catch (err) {
      setRollbacks(r => ({ ...r, [execId]: { rolling: false, done: false, error: (err as Error).message } }));
    }
  }

  // ── Shared row renderers ────────────────────────────────────────────────────

  function renderReadyRow(row: FeedRow) {
    const item      = row.readyItem!;
    const isChecked = selected.has(item.selectionKey);
    const pvState   = previews[item.selectionKey];
    const apState   = applyStates[item.selectionKey];
    const applied   = apState?.applied;
    const isHovered = hoveredKey === row.key;
    const rowBg = isChecked ? 'rgba(34,197,94,0.07)' : isHovered ? 'rgba(255,255,255,0.025)' : '#0f140f';
    return (
      <div key={row.key} style={{ ...s.rowWrap, opacity: applied ? 0.5 : 1 }}>
        <div
          style={{ ...s.row, background: rowBg, cursor: item.selectable ? 'pointer' : 'default' }}
          onClick={() => item.selectable && !applied && onToggle(item.selectionKey)}
          onMouseEnter={() => { setHoveredKey(row.key); onFocus?.(row); }}
          onMouseLeave={() => setHoveredKey(null)}
        >
          <input
            type="checkbox"
            checked={isChecked}
            disabled={!item.selectable || !!applied}
            onChange={() => item.selectable && !applied && onToggle(item.selectionKey)}
            onClick={e => e.stopPropagation()}
            style={{ cursor: item.selectable && !applied ? 'pointer' : 'not-allowed', flexShrink: 0, marginTop: 1 }}
          />
          <Pill status="ready" />
          <div style={s.rowMain}>
            {item.productTitle && <span style={s.product}>{item.productTitle}</span>}
            <span style={s.issue}>{issueLabel(item.issueId)}</span>
          </div>
          <div style={s.rowActions}>
            {applied ? (
              <span style={s.appliedBadge}>Live ✓</span>
            ) : (
              <button
                style={{ ...s.previewBtn, ...(pvState?.data ? s.previewBtnActive : {}) }}
                disabled={pvState?.loading}
                onClick={e => { e.stopPropagation(); togglePreview(item); }}
              >
                {pvState?.loading ? '…' : pvState?.data ? 'Hide' : 'Preview'}
              </button>
            )}
          </div>
        </div>
        {pvState?.error && <div style={s.panelError}>{pvState.error}</div>}
        {apState?.error && !pvState?.data && <div style={s.panelError}>{apState.error}</div>}
        {pvState?.data && !applied && (
          <PreviewPanel
            item={item}
            preview={pvState.data}
            applyState={apState ?? null}
            onApply={() => singleApply(item)}
            onClose={() => setPreviews(p => { const n = { ...p }; delete n[item.selectionKey]; return n; })}
          />
        )}
      </div>
    );
  }

  function renderMeasuringRow(row: FeedRow) {
    // Activity item (live or measuring)
    if (row.activityItem) {
      const item = row.activityItem;
      const rb   = rollbacks[item.executionId];
      const isLive = row.feedStatus === 'live';
      return (
        <div key={row.key} style={s.rowWrap}>
          <div style={{ ...s.row, background: hoveredKey === row.key ? 'rgba(255,255,255,0.025)' : '#0f140f', cursor: 'default' }}
               onMouseEnter={() => { setHoveredKey(row.key); onFocus?.(row); }} onMouseLeave={() => setHoveredKey(null)}>
            <Pill status={row.feedStatus} />
            <div style={s.rowMain}>
              {item.productTitle && <span style={s.product}>{item.productTitle}</span>}
              <span style={s.issue}>{issueLabel(item.issueId)}</span>
              <span style={s.sub}>
                {isLive ? 'Applied — tracking begins automatically' : 'Measuring — 7-day window'}
              </span>
            </div>
            <div style={s.rowActions}>
              <span style={s.meta}>{formatDate(item.createdAt)}</span>
              {isLive && !rb?.done && (
                <button
                  style={{ ...s.undoBtn, opacity: rb?.rolling ? 0.6 : 1 }}
                  disabled={rb?.rolling}
                  onClick={() => doRollback(item.productId, item.issueId, item.executionId)}
                >
                  {rb?.rolling ? 'Undoing…' : 'Undo'}
                </button>
              )}
              {rb?.done  && <span style={s.undoDone}>Undone</span>}
              {rb?.error && <span style={s.undoError}>{rb.error}</span>}
            </div>
          </div>
        </div>
      );
    }
    // TopAction with open measurement window
    if (row.topAction) {
      const action = row.topAction;
      return (
        <div key={row.key} style={s.rowWrap}>
          <div style={{ ...s.row, background: hoveredKey === row.key ? 'rgba(255,255,255,0.025)' : '#0f140f' }}
               onMouseEnter={() => { setHoveredKey(row.key); onFocus?.(row); }} onMouseLeave={() => setHoveredKey(null)}>
            <Pill status="measuring" />
            <div style={s.rowMain}>
              <span style={s.product}>{action.productTitle}</span>
              <span style={s.issue}>{action.recommendedAction}</span>
              <span style={s.sub}>Measuring — 7-day window</span>
            </div>
            {action.openMeasurementWindowReadyAt && (
              <div style={s.rowActions}>
                <span style={s.meta}>Results {formatReadyAt(action.openMeasurementWindowReadyAt)}</span>
              </div>
            )}
          </div>
        </div>
      );
    }
    return null;
  }

  function renderUpnextRow(row: FeedRow, isHero: boolean) {
    if (isHero) {
      return (
        <div key={row.key} onMouseEnter={() => onFocus?.(row)}>
          <HeroNextCard row={row} executing={executing} onRunAction={onRunAction} />
        </div>
      );
    }
    const action    = row.topAction!;
    const isRunning = executing.has(action.actionKey);
    return (
      <div key={row.key} style={s.rowWrap}>
        <div style={{ ...s.row, background: hoveredKey === row.key ? 'rgba(255,255,255,0.025)' : '#0f140f' }}
             onMouseEnter={() => { setHoveredKey(row.key); onFocus?.(row); }} onMouseLeave={() => setHoveredKey(null)}>
          <Pill status="queued" />
          <div style={s.rowMain}>
            <span style={s.product}>{action.productTitle}</span>
            <span style={s.issue}>{action.recommendedAction}</span>
            {action.whyNow && <span style={s.sub}>{action.whyNow}</span>}
          </div>
          <div style={s.rowActions}>
            {action.estimatedImpactLabel && <span style={s.meta}>{action.estimatedImpactLabel}</span>}
            <button
              style={{ ...s.runBtn, opacity: isRunning ? 0.6 : 1 }}
              disabled={isRunning}
              onClick={() => onRunAction(action.actionKey)}
            >
              {isRunning ? 'Running…' : 'Run'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderProtectionRow(row: FeedRow) {
    if (!row.activityItem) return null;
    const item = row.activityItem;
    const isRolledBack = row.feedStatus === 'rolled_back';
    // For measured-but-not-win rows, show the outcome
    const showLift = row.feedStatus === 'measured' && item.revenueChangePercent !== null;
    const pct  = item.revenueChangePercent ?? 0;
    const liftColor = pct > 0 ? '#4ade80' : pct < 0 ? '#f87171' : '#6b7280';
    return (
      <div key={row.key} style={s.rowWrap} onMouseEnter={() => onFocus?.(row)}>
        <div style={{ ...s.row, opacity: 0.65 }}>
          <Pill status={isRolledBack ? 'rolled_back' : 'measured'} />
          <div style={s.rowMain}>
            {item.productTitle && <span style={s.product}>{item.productTitle}</span>}
            <span style={{ ...s.issue, color: '#6b7280' }}>{issueLabel(item.issueId)}</span>
            {isRolledBack && <span style={s.sub}>Reverted automatically</span>}
            {showLift && (
              <span style={{ ...s.sub, color: liftColor }}>
                {pct > 0 ? '+' : ''}{Math.round(pct)}% revenue · 7-day
              </span>
            )}
            {row.feedStatus === 'measured' && item.measurementConfidence === 'insufficient' && (
              <span style={s.sub}>Window complete — not enough orders for a result</span>
            )}
          </div>
          <div style={s.rowActions}>
            <span style={s.meta}>{formatDate(item.createdAt)}</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Empty state ─────────────────────────────────────────────────────────────

  if (totalRows === 0) {
    return (
      <div style={s.emptyState}>
        <span style={s.emptyDot} />
        <p style={s.emptyText}>
          No changes queued right now. CRODoctor is continuously monitoring your store and will surface the next improvement automatically.
        </p>
      </div>
    );
  }

  // ── Grouped render ──────────────────────────────────────────────────────────

  const showSection = (key: SectionFilter) => activeSection === 'all' || activeSection === key;

  return (
    <div>
      <FeedFilterBar active={activeSection} onChange={setActiveSection} counts={filterCounts} />
      <div style={s.sections}>

      {/* ── WINS: proof the system delivers ──────────────────────────────── */}
      {showSection('wins') && wins.length > 0 && (
        <SectionBlock
          accent="#4ade80"
          label="Proven wins"
          count={wins.length}
          sub="Confirmed revenue lift. Already live and working on your store."
        >
          <div style={{ ...s.list, borderColor: 'rgba(34,197,94,0.14)' }}>
            {wins.map(row => (
              <div key={row.key} onMouseEnter={() => onFocus?.(row)}>
                <WinCard row={row} />
              </div>
            ))}
          </div>
        </SectionBlock>
      )}

      {/* ── MEASURING: live validation ────────────────────────────────────── */}
      {showSection('measuring') && measuring.length > 0 && (
        <SectionBlock
          accent="#fbbf24"
          label="Measuring now"
          count={measuring.length}
          sub="Live on your store. Revenue data collecting — results within 7 days."
        >
          <div style={s.list}>{measuring.map(row => renderMeasuringRow(row))}</div>
        </SectionBlock>
      )}

      {/* ── READY: action zone ────────────────────────────────────────────── */}
      {showSection('ready') && ready.length > 0 && (
        <SectionBlock
          accent="#22c55e"
          label="Ready to apply"
          count={ready.length}
          sub="Reviewed and ready. Goes live instantly — reversible any time."
        >
          {selectableCount > 0 && (
            <div style={s.batchBar}>
              <button style={s.batchBtn} onClick={onSelectAll}      disabled={isApplying}>Select all</button>
              <button style={s.batchBtn} onClick={onClearSelection} disabled={isApplying}>Clear</button>
              <span style={s.batchCount}>
                {selected.size > 0
                  ? `${selected.size} of ${selectableCount} selected`
                  : `${selectableCount} improvement${selectableCount !== 1 ? 's' : ''} ready`}
              </span>
              <button
                style={{ ...s.batchApply, opacity: (selected.size === 0 || isApplying) ? 0.4 : 1 }}
                disabled={selected.size === 0 || isApplying}
                onClick={onApply}
              >
                {isApplying ? 'Applying…' : `Apply selected (${selected.size})`}
              </button>
            </div>
          )}
          {applyError  && <div style={s.errorBox}>{applyError}</div>}
          {applyResult && <ApplyResultBox result={applyResult} />}
          <div style={s.list}>{ready.map(row => renderReadyRow(row))}</div>
        </SectionBlock>
      )}

      {/* ── UP NEXT: commercial pipeline ──────────────────────────────────── */}
      {showSection('upnext') && upnext.length > 0 && (
        <SectionBlock
          accent="#60a5fa"
          label="Highest upside next"
          count={upnext.length}
          sub="Highest commercial upside surfaced. Ranked by expected revenue impact."
        >
          <div>
            {renderUpnextRow(upnext[0], true)}
            {upnext.length > 1 && (
              <div style={{ ...s.list, marginTop: 8 }}>
                {upnext.slice(1).map(row => renderUpnextRow(row, false))}
              </div>
            )}
          </div>
        </SectionBlock>
      )}

      {/* ── PROTECTION: trust layer ───────────────────────────────────────── */}
      {showSection('protected') && protection.length > 0 && (
        <SectionBlock
          accent="#4b5563"
          label="Protected"
          count={protection.length}
          sub="Underperformed — reverted automatically. Your store is protected."
          muted={true}
        >
          <div style={s.list}>{protection.map(row => renderProtectionRow(row))}</div>
        </SectionBlock>
      )}

      </div>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const s: Record<string, React.CSSProperties> = {
  sections:       { display: 'flex', flexDirection: 'column', gap: 28 },

  emptyState:     { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 0 4px' },
  emptyDot:       { width: 7, height: 7, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 5px rgba(34,197,94,0.45)', flexShrink: 0, marginTop: 5 },
  emptyText:      { fontSize: 13, color: '#6b7280', lineHeight: 1.65, margin: 0 },

  batchBar:       { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  batchBtn:       { fontSize: 12, padding: '4px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 5, background: 'rgba(255,255,255,0.04)', cursor: 'pointer', color: '#9ca3af' },
  batchCount:     { fontSize: 12, color: '#4b5563', flex: 1 },
  batchApply:     { fontSize: 12, fontWeight: 700, padding: '6px 18px', border: 'none', borderRadius: 6, background: '#16a34a', color: '#fff', cursor: 'pointer', transition: 'opacity 0.15s', letterSpacing: '0.01em' },

  errorBox:       { padding: '10px 14px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.18)', borderRadius: 7, color: '#f87171', fontSize: 13, marginBottom: 8 },

  list:           { display: 'flex', flexDirection: 'column', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, overflow: 'hidden' },
  rowWrap:        {},
  row:            { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 14px', background: '#0f140f', borderBottom: '1px solid rgba(255,255,255,0.04)' },
  rowMain:        { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  rowActions:     { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, paddingTop: 1, minWidth: 96, justifyContent: 'flex-end' },

  product:        { fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.06em' },
  issue:          { fontSize: 13, fontWeight: 600, color: '#e5e7eb' },
  sub:            { fontSize: 11, color: '#6b7280', lineHeight: 1.4 },
  meta:           { fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' as const },

  previewBtn:       { fontSize: 11, padding: '4px 12px', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5, background: 'rgba(255,255,255,0.04)', cursor: 'pointer', color: '#9ca3af', whiteSpace: 'nowrap' as const, fontWeight: 500 },
  previewBtnActive: { background: 'rgba(59,130,246,0.08)', borderColor: 'rgba(96,165,250,0.3)', color: '#60a5fa' },
  appliedBadge:     { fontSize: 11, fontWeight: 700, color: '#4ade80' },
  panelError:       { padding: '8px 16px 8px 52px', fontSize: 12, color: '#f87171', background: '#0d120d', borderTop: '1px solid rgba(255,255,255,0.04)' },

  runBtn:   { fontSize: 11, fontWeight: 700, padding: '5px 14px', border: 'none', borderRadius: 5, background: '#16a34a', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  undoBtn:  { fontSize: 11, padding: '3px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 4, background: 'rgba(255,255,255,0.04)', color: '#9ca3af', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  undoDone: { fontSize: 11, color: '#4ade80',  whiteSpace: 'nowrap' as const },
  undoError:{ fontSize: 11, color: '#f87171' },
};

// Section block header styles
const sb: Record<string, React.CSSProperties> = {
  titleRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 },
  label:    { fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, color: '#e5e7eb' },
  sub:      { fontSize: 12, color: '#6b7280', margin: 0, lineHeight: 1.4 },
};

// Win card styles
const wc: Record<string, React.CSSProperties> = {
  card:     { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
              padding: '14px 18px', background: 'rgba(34,197,94,0.07)',
              borderBottom: '1px solid rgba(34,197,94,0.08)',
              borderLeft: '3px solid rgba(34,197,94,0.55)', gap: 16 },
  main:     { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 },
  product:  { fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase' as const, letterSpacing: '0.06em' },
  issue:    { fontSize: 13, fontWeight: 600, color: '#e5e7eb' },
  insight:  { fontSize: 11, color: '#4b5563', lineHeight: 1.4 },
  right:    { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, flexShrink: 0 },
  pct:      { fontSize: 26, fontWeight: 800, color: '#4ade80', lineHeight: 1, letterSpacing: '-0.03em' },
  pctLabel: { fontSize: 10, color: '#22c55e', fontWeight: 600, opacity: 0.7 },
  date:     { fontSize: 10, color: '#6b7280', marginTop: 4 },
  confTag:  { fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase' as const, color: '#22c55e', opacity: 0.7, marginTop: 5, display: 'block' },
};

// Hero "up next" card styles
const un: Record<string, React.CSSProperties> = {
  hero:       { padding: '18px 20px', background: 'rgba(34,197,94,0.03)',
                border: '1px solid rgba(34,197,94,0.12)', borderLeft: '3px solid rgba(34,197,94,0.5)',
                borderBottom: '1px solid rgba(34,197,94,0.06)' },
  heroTopRow: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  heroRank:   { fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const,
                color: '#9ca3af', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)',
                borderRadius: 4, padding: '1px 7px' },
  heroImpact: { fontSize: 11, color: '#6b7280' },
  heroProduct:{ fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase' as const, letterSpacing: '0.06em', display: 'block', marginBottom: 2 },
  heroAction: { fontSize: 14, fontWeight: 700, color: '#f9fafb', display: 'block', marginBottom: 6 },
  heroWhy:    { fontSize: 12, color: '#6b7280', lineHeight: 1.55, display: 'block', marginBottom: 14 },
  heroBtn:      { fontSize: 12, fontWeight: 700, padding: '7px 18px', border: 'none', borderRadius: 6,
                  background: '#15803d', color: '#fff', cursor: 'pointer' },
  heroCategory: { fontSize: 10, fontWeight: 700, color: '#6b7280', letterSpacing: '0.06em',
                  textTransform: 'uppercase' as const, display: 'inline-block', marginBottom: 8,
                  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
                  borderRadius: 3, padding: '2px 7px' },
};

// Feed filter bar styles
const ff: Record<string, React.CSSProperties> = {
  bar:   { display: 'flex', gap: 0,
           background: 'rgba(255,255,255,0.025)',
           border: '1px solid rgba(255,255,255,0.08)',
           borderRadius: 10, marginBottom: 24,
           overflowX: 'auto' as const, padding: '3px 6px 0' },
  tab:   { fontSize: 13, fontWeight: 600, padding: '8px 14px 9px', background: 'none', border: 'none',
           cursor: 'pointer', whiteSpace: 'nowrap' as const, letterSpacing: '0.02em',
           display: 'flex', alignItems: 'center', gap: 6, transition: 'color 0.15s' },
  badge: { fontSize: 9, fontWeight: 800, padding: '1px 6px', borderRadius: 8, lineHeight: 1.6 },
};

// Preview panel styles
const pp: Record<string, React.CSSProperties> = {
  wrap:        { padding: '14px 18px 16px 40px', background: '#0d120d', borderTop: '1px solid rgba(255,255,255,0.05)', fontSize: 12 },
  contextRow:  { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10, flexWrap: 'wrap' as const },
  contextText: { fontSize: 13, color: '#9ca3af', fontWeight: 500 },
  diffNote:    { fontSize: 11, color: '#6b7280' },
  intentNote:  { fontSize: 12, color: '#9ca3af', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(96,165,250,0.15)', borderRadius: 5, padding: '6px 10px', margin: '0 0 10px', lineHeight: 1.5 },
  label:       { fontSize: 10, fontWeight: 700, color: '#4b5563', textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 4 },
  text:        { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: '8px 12px', color: '#d1d5db', lineHeight: 1.5, whiteSpace: 'pre-wrap' as const, fontSize: 13 },
  reversibility: { fontSize: 11, color: '#374151', margin: '10px 0 6px', fontStyle: 'italic' as const },
  actions:     { display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' },
  btnApply:    { fontSize: 12, padding: '6px 18px', border: 'none', borderRadius: 6, background: '#15803d', color: '#fff', cursor: 'pointer', fontWeight: 700 },
  btnCancel:   { fontSize: 12, padding: '5px 12px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 6, background: 'rgba(255,255,255,0.03)', cursor: 'pointer', color: '#9ca3af' },
};
