'use client';

import { useState } from 'react';
import type { ReviewItem, TopAction, ActivityItem, ContentPreview, ApplyResponse } from '@/lib/api';
import { fetchContentPreview, applySelected, submitReviewApproval, issueLabel, API_BASE, apiHeaders } from '@/lib/api';
import { blockReasonLabel, isManualBlockReason, PREVIEW_UNAVAILABLE_MSG, proposedContentLabel,
         PREVIEW_DISCLAIMER, APPLY_SUCCESS_TITLE, APPLY_SUCCESS_SUB, APPLY_FAILED_MSG, ROLLBACK_FAILED_MSG } from './previewCopy';

// ── Types ──────────────────────────────────────────────────────────────────────

export type FeedStatus    = 'ready' | 'queued' | 'live' | 'measuring' | 'measured' | 'rolled_back';
type SectionFilter = 'all' | 'ready' | 'wins' | 'measuring' | 'upnext' | 'protected';

const PILL_CFG: Record<FeedStatus, { label: string; color: string; bg: string; border: string }> = {
  ready:       { label: 'Ready',       color: '#ffffff', bg: '#15803d',                    border: 'transparent' },
  queued:      { label: 'Up next',     color: '#9ca3af', bg: 'rgba(255,255,255,0.05)',      border: 'rgba(255,255,255,0.10)' },
  live:        { label: 'Live on Shopify', color: '#4ade80', bg: 'rgba(34,197,94,0.08)',    border: 'rgba(34,197,94,0.22)' },
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
  onSelect?:         (row: FeedRow) => void;
  selectedKey?:      string | null;
  narrow?:           boolean;
  executeErrors?:    Record<string, string | null>;
  executeSuccesses?: Record<string, string>;
  onRollbackDone?:   () => void;
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
  const upnextRaw  = rows.filter(r => r.feedStatus === 'queued');
  // Auto-applicable content_change items always appear before manual/theme items
  // so the hero slot shows a merchant-actionable preview button when one exists.
  const upnext = [
    ...upnextRaw.filter(r => r.topAction?.applyType === 'content_change'),
    ...upnextRaw.filter(r => r.topAction?.applyType !== 'content_change'),
  ];
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

function stripHtml(html: string | null): string {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Presentational sub-components ─────────────────────────────────────────────

function SectionBlock({ accent, label, count, sub, muted = false, narrow = false, children }: {
  accent:   string;
  label:    string;
  count:    number;
  sub:      string;
  muted?:   boolean;
  narrow?:  boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ opacity: muted ? 0.65 : 1 }}>
      <div style={{ borderTop: `2px solid ${accent}`, paddingTop: narrow ? 8 : 12, marginBottom: narrow ? 7 : 12 }}>
        <div style={sb.titleRow}>
          <span style={{ ...sb.label, fontSize: narrow ? 10 : 13 }}>{label}</span>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
            color: accent, background: `${accent}18`, border: `1px solid ${accent}30`,
          }}>
            {count}
          </span>
        </div>
        {!narrow && <p style={sb.sub}>{sub}</p>}
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
function HeroNextCard({ row, executing, onRunAction, previewState, onPreview, onClosePreview, executeError, executeSuccess }: {
  row:             FeedRow;
  executing:       Set<string>;
  onRunAction:     (key: string) => void;
  previewState:    PreviewState | null;
  onPreview:       () => void;
  onClosePreview:  () => void;
  executeError?:   string | null;
  executeSuccess?: string | null;
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
      {action.applyType && action.applyType !== 'content_change' ? (
        <div style={un.heroManualNote}>
          <span>This recommendation requires manual implementation — it can&apos;t be applied automatically. The steps are in the description above.</span>
        </div>
      ) : previewState?.loading ? (
        <div style={un.heroPreviewNote}>Generating preview…</div>
      ) : previewState?.data ? (
        <PreviewPanel
          issueId={action.issueId}
          preview={previewState.data}
          applyState={
            executeSuccess ? { applying: false, applied: true,  error: null } :
            executeError   ? { applying: false, applied: false, error: executeError } :
            null
          }
          isApplying={isRunning}
          onApply={() => onRunAction(action.actionKey)}
          onClose={onClosePreview}
        />
      ) : (
        <button style={un.heroBtn} onClick={onPreview}>
          Preview fix
        </button>
      )}
      {previewState?.error && (
        <div style={un.heroPreviewNote}>{PREVIEW_UNAVAILABLE_MSG}</div>
      )}
    </div>
  );
}

function PreviewPanel({ issueId, preview, applyState, isApplying, onApply, onClose }: {
  issueId:     string;
  preview:     ContentPreview;
  applyState:  ApplyState | null;
  isApplying?: boolean;
  onApply:     () => void;
  onClose:     () => void;
}) {
  const applying = applyState?.applying || isApplying;
  const hasProposedContent = typeof preview.proposedContent === 'string' && preview.proposedContent.trim().length > 0;
  return (
    <div style={pp.wrap}>
      <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8 }}>{PREVIEW_DISCLAIMER}</div>
      <div style={pp.contextRow}>
        <span style={pp.contextText}>{patchDescription(preview.patchMode)}</span>
        {preview.diffSummary && <span style={pp.diffNote}>{preview.diffSummary.note}</span>}
      </div>
      {preview.eligibleToApply ? (
        <>
          {COPY_INTENT_NOTE[issueId] && (
            <p style={pp.intentNote}>{COPY_INTENT_NOTE[issueId]}</p>
          )}
          {preview.currentContent && (
            <div style={{ marginBottom: 8 }}>
              <div style={pp.label}>Current version on your product page</div>
              <div style={{ ...pp.text, color: '#4b5563', maxHeight: 60, overflow: 'hidden' }}>
                {stripHtml(preview.currentContent)}
              </div>
            </div>
          )}
          {hasProposedContent ? (
            <>
              <div>
                <div style={{ ...pp.label, color: '#4ade80' }}>
                  {proposedContentLabel(preview.patchMode)}
                </div>
                <div style={{ ...pp.text, borderColor: 'rgba(34,197,94,0.22)', background: 'rgba(34,197,94,0.05)' }}>
                  {preview.proposedContent}
                </div>
              </div>
              <div style={pp.reversibility}>You can undo this change anytime.</div>
              {applyState?.applied ? (
                <div style={pp.successBlock}>
                  <div style={pp.successText}>{APPLY_SUCCESS_TITLE}</div>
                  <div style={pp.successSub}>{APPLY_SUCCESS_SUB}</div>
                </div>
              ) : (
                <div style={pp.actions}>
                  <button
                    style={{ ...pp.btnApply, opacity: applying ? 0.6 : 1 }}
                    disabled={applying}
                    onClick={onApply}
                  >
                    {applying ? 'Applying…' : 'Apply this change'}
                  </button>
                  <button style={pp.btnCancel} onClick={onClose} disabled={applying}>
                    Cancel
                  </button>
                  {applyState?.error && <span style={{ color: '#f87171', fontSize: 12 }}>{applyState.error}</span>}
                </div>
              )}
            </>
          ) : (
            <div style={{ color: '#d97706', fontSize: 12, padding: '6px 0' }}>
              {PREVIEW_UNAVAILABLE_MSG}
            </div>
          )}
        </>
      ) : (
        <div style={{ color: '#f87171', fontSize: 12 }}>{blockReasonLabel(preview.blockReason)}</div>
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
  active, onChange, counts, narrow,
}: {
  active:   SectionFilter;
  onChange: (f: SectionFilter) => void;
  counts:   Record<SectionFilter, number>;
  narrow?:  boolean;
}) {
  return (
    <div style={{ ...ff.bar, marginBottom: narrow ? 14 : 24, overflowX: narrow ? 'hidden' : 'auto' }}>
      {FILTER_TABS.map(tab => {
        const isActive = active === tab.key;
        const count    = counts[tab.key];
        const isEmpty  = count === 0 && tab.key !== 'all';
        return (
          <button
            key={tab.key}
            style={{
              ...ff.tab,
              fontSize:     narrow ? 10 : 13,
              padding:      narrow ? '4px 6px 5px' : '8px 14px 9px',
              color:        isActive ? tab.color : isEmpty ? '#374151' : '#6b7280',
              borderBottom: isActive ? `2px solid ${tab.color}` : '2px solid transparent',
              opacity:      isEmpty ? 0.45 : 1,
            }}
            onClick={() => onChange(tab.key)}
          >
            {tab.label}
            {count > 0 && !narrow && (
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

// ── Non-actionable state note ──────────────────────────────────────────────────
// Shown when the ready section is empty but measuring/upnext rows exist,
// so the merchant understands why nothing is ready to apply.

function FeedStatusNote({ measuring, upnext }: { measuring: number; upnext: number }) {
  if (measuring === 0 && upnext === 0) return null;

  const msg =
    measuring > 0 && upnext > 0
      ? 'Some changes are live and being measured. More recommendations are waiting for preview.'
      : measuring > 0
      ? 'Your active changes are collecting data. No new actions are ready right now.'
      : 'Recommendations are waiting for preview. Review each change before applying it to your store.';

  return (
    <div style={fsn.wrap}>
      <span style={fsn.dot} />
      <span style={fsn.text}>{msg}</span>
    </div>
  );
}

const fsn: Record<string, React.CSSProperties> = {
  wrap: {
    display: 'flex', alignItems: 'flex-start', gap: 10,
    padding: '10px 14px',
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 8,
    marginBottom: 4,
  },
  dot:  { width: 6, height: 6, borderRadius: '50%', background: '#4b5563', flexShrink: 0, marginTop: 5 },
  text: { fontSize: 12, color: '#6b7280', lineHeight: 1.6 },
};

// ── Main component ─────────────────────────────────────────────────────────────

export default function OptimizationFeed({
  shop, readyItems, topActions, recentActivity,
  executing, selected, isApplying, applyResult, applyError,
  onRunAction, onToggle, onSelectAll, onClearSelection, onApply, onSelect, selectedKey, narrow,
  executeErrors, executeSuccesses, onRollbackDone,
}: Props) {
  const [previews,             setPreviews]             = useState<Record<string, PreviewState>>({});
  const [applyStates,          setApplyStates]          = useState<Record<string, ApplyState>>({});
  const [rollbacks,            setRollbacks]            = useState<Record<string, RollbackState>>({});
  const [confirmingRollbacks,  setConfirmingRollbacks]  = useState<Record<string, boolean>>({});
  const [actionPreviews,       setActionPreviews]       = useState<Record<string, PreviewState>>({});
  const [activeSection,        setActiveSection]        = useState<SectionFilter>('all');
  const [hoveredKey,           setHoveredKey]           = useState<string | null>(null);
  const [confirmingBatch,      setConfirmingBatch]      = useState(false);

  const rows = buildRows(readyItems, topActions, recentActivity);
  const { ready, wins, measuring, upnext, protection } = groupRows(rows);

  const rowStyle       = narrow ? { ...s.row, padding: '8px 12px' }      : s.row;
  const rowActionsStyle = narrow ? { ...s.rowActions, minWidth: 68 }       : s.rowActions;
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

  async function toggleActionPreview(action: TopAction) {
    const key = action.actionKey;
    if (actionPreviews[key]?.data) {
      setActionPreviews(p => { const n = { ...p }; delete n[key]; return n; });
      return;
    }
    setActionPreviews(p => ({ ...p, [key]: { loading: true, data: null, error: null } }));
    try {
      const data = await fetchContentPreview(shop, action.productId, action.issueId);
      setActionPreviews(p => ({ ...p, [key]: { loading: false, data, error: null } }));
    } catch (err) {
      setActionPreviews(p => ({ ...p, [key]: { loading: false, data: null, error: (err as Error).message } }));
    }
  }

  async function singleApply(item: ReviewItem, previewData?: ContentPreview | null) {
    const key = item.selectionKey;
    setApplyStates(s => ({ ...s, [key]: { applying: true, applied: false, error: null } }));
    try {
      // Persist the exact content the merchant reviewed before applying.
      // Fatal: if this fails the backend will block Apply (reviewedProposedContent required).
      // The error propagates to the outer catch, which shows it in the UI and keeps
      // the Preview panel open (it only closes on success).
      const pc = previewData?.proposedContent;
      if (pc && pc.trim().length > 0) {
        await submitReviewApproval(shop, item.productId, item.issueId, pc);
      }

      const result = await applySelected(shop, [key]);
      const row    = result.results[0];
      if (row?.status === 'applied') {
        setApplyStates(s => ({ ...s, [key]: { applying: false, applied: true,  error: null } }));
        setPreviews(p => { const n = { ...p }; delete n[key]; return n; });
      } else {
        setApplyStates(s => ({ ...s, [key]: { applying: false, applied: false, error: row?.reason ?? APPLY_FAILED_MSG } }));
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
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? ROLLBACK_FAILED_MSG);
      }
      setRollbacks(r => ({ ...r, [execId]: { rolling: false, done: true,  error: null } }));
      onRollbackDone?.();
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
    const isHovered  = hoveredKey === row.key;
    const isSelected = row.key === selectedKey;
    const rowBg = isSelected
      ? 'rgba(34,197,94,0.16)'
      : isChecked ? 'rgba(34,197,94,0.07)'
      : isHovered ? 'rgba(255,255,255,0.03)'
      : '#0f140f';
    const rowShadow = isSelected ? 'inset 4px 0 0 #22c55e' : undefined;
    return (
      <div key={row.key} style={{ ...s.rowWrap, opacity: applied ? 0.5 : 1 }}>
        <div
          style={{ ...rowStyle, background: rowBg, boxShadow: rowShadow, cursor: 'pointer' }}
          onClick={() => { onSelect?.(row); item.selectable && !applied && onToggle(item.selectionKey); }}
          onMouseEnter={() => setHoveredKey(row.key)}
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
            {item.productTitle && <span style={{ ...s.product, ...(narrow ? s.truncate : {}) }}>{item.productTitle}</span>}
            <span style={{ ...s.issue, ...(narrow ? s.truncate : {}) }}>{issueLabel(item.issueId)}</span>
          </div>
          <div style={rowActionsStyle}>
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
            issueId={item.issueId}
            preview={pvState.data}
            applyState={apState ?? null}
            onApply={() => singleApply(item, pvState.data)}
            onClose={() => setPreviews(p => { const n = { ...p }; delete n[item.selectionKey]; return n; })}
          />
        )}
      </div>
    );
  }

  function renderMeasuringRow(row: FeedRow) {
    // Activity item (live or measuring)
    if (row.activityItem) {
      const item        = row.activityItem;
      const rb          = rollbacks[item.executionId];
      const isLive      = row.feedStatus === 'live';
      const canUndo     = (isLive || row.feedStatus === 'measuring') && item.status === 'applied';
      const confirmingRb = confirmingRollbacks[item.executionId];
      return (
        <div key={row.key} style={s.rowWrap}>
          <div style={{ ...rowStyle,
            background: row.key === selectedKey ? 'rgba(34,197,94,0.16)' : hoveredKey === row.key ? 'rgba(255,255,255,0.03)' : '#0f140f',
            boxShadow:  row.key === selectedKey ? 'inset 4px 0 0 #22c55e' : undefined,
            cursor: 'pointer' }}
               onClick={() => onSelect?.(row)}
               onMouseEnter={() => setHoveredKey(row.key)} onMouseLeave={() => setHoveredKey(null)}>
            <Pill status={row.feedStatus} />
            <div style={s.rowMain}>
              {item.productTitle && <span style={{ ...s.product, ...(narrow ? s.truncate : {}) }}>{item.productTitle}</span>}
              <span style={{ ...s.issue, ...(narrow ? s.truncate : {}) }}>{issueLabel(item.issueId)}</span>
              {!narrow && <span style={s.sub}>{isLive ? 'Live on Shopify — collecting data' : 'Measuring · collecting data'}</span>}
            </div>
            <div style={rowActionsStyle}>
              <span style={s.meta}>{formatDate(item.createdAt)}</span>
              {canUndo && !rb?.done && !confirmingRb && (
                <button
                  style={s.undoBtn}
                  onClick={e => { e.stopPropagation(); setConfirmingRollbacks(r => ({ ...r, [item.executionId]: true })); }}
                >
                  Undo this change
                </button>
              )}
              {rb?.done && <span style={s.undoDone}>✓ Reverted</span>}
            </div>
          </div>
          {confirmingRb && !rb?.done && (
            <div style={s.rbConfirmPanel}>
              <span style={s.rbConfirmText}>This reverts the change on your store immediately.</span>
              <div style={s.rbConfirmActions}>
                <button
                  style={{ ...s.undoBtn, color: '#f87171', borderColor: 'rgba(248,113,113,0.25)', opacity: rb?.rolling ? 0.6 : 1 }}
                  disabled={rb?.rolling}
                  onClick={() => doRollback(item.productId, item.issueId, item.executionId)}
                >
                  {rb?.rolling ? 'Restoring previous version…' : 'Yes, revert'}
                </button>
                <button
                  style={s.undoBtn}
                  disabled={rb?.rolling}
                  onClick={() => setConfirmingRollbacks(r => ({ ...r, [item.executionId]: false }))}
                >
                  Cancel
                </button>
              </div>
              {rb?.error && <div style={s.undoError}>{rb.error}</div>}
            </div>
          )}
        </div>
      );
    }
    // TopAction with open measurement window
    if (row.topAction) {
      const action = row.topAction;
      return (
        <div key={row.key} style={s.rowWrap}>
          <div style={{ ...rowStyle,
            background: row.key === selectedKey ? 'rgba(34,197,94,0.16)' : hoveredKey === row.key ? 'rgba(255,255,255,0.03)' : '#0f140f',
            boxShadow:  row.key === selectedKey ? 'inset 4px 0 0 #22c55e' : undefined,
            cursor: 'pointer' }}
               onClick={() => onSelect?.(row)}
               onMouseEnter={() => setHoveredKey(row.key)} onMouseLeave={() => setHoveredKey(null)}>
            <Pill status="measuring" />
            <div style={s.rowMain}>
              <span style={{ ...s.product, ...(narrow ? s.truncate : {}) }}>{action.productTitle}</span>
              <span style={{ ...s.issue, ...(narrow ? s.truncate : {}) }}>{issueLabel(action.issueId)}</span>
              {!narrow && <span style={s.sub}>Measuring — 7-day window</span>}
            </div>
            {action.openMeasurementWindowReadyAt && (
              <div style={rowActionsStyle}>
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
      const heroAction = row.topAction!;
      return (
        <div key={row.key}
          onClick={() => onSelect?.(row)}
          style={row.key === selectedKey ? { boxShadow: 'inset 4px 0 0 #22c55e' } : {}}
        >
          <HeroNextCard
            row={row}
            executing={executing}
            onRunAction={onRunAction}
            previewState={actionPreviews[heroAction.actionKey] ?? null}
            onPreview={() => toggleActionPreview(heroAction)}
            onClosePreview={() => setActionPreviews(p => { const n = { ...p }; delete n[heroAction.actionKey]; return n; })}
            executeError={executeErrors?.[heroAction.actionKey] ?? null}
            executeSuccess={executeSuccesses?.[heroAction.actionKey] ?? null}
          />
        </div>
      );
    }
    const action     = row.topAction!;
    const isRunning  = executing.has(action.actionKey);
    const upPvState  = actionPreviews[action.actionKey] ?? null;
    return (
      <div key={row.key} style={s.rowWrap}>
        <div style={{ ...rowStyle,
          background: row.key === selectedKey ? 'rgba(34,197,94,0.16)' : hoveredKey === row.key ? 'rgba(255,255,255,0.03)' : '#0f140f',
          boxShadow:  row.key === selectedKey ? 'inset 4px 0 0 #22c55e' : undefined,
          cursor: 'pointer' }}
             onClick={() => onSelect?.(row)}
             onMouseEnter={() => setHoveredKey(row.key)} onMouseLeave={() => setHoveredKey(null)}>
          <Pill status="queued" />
          <div style={s.rowMain}>
            <span style={{ ...s.product, ...(narrow ? s.truncate : {}) }}>{action.productTitle}</span>
            <span style={{ ...s.issue, ...(narrow ? s.truncate : {}) }}>{issueLabel(action.issueId)}</span>
            {!narrow && action.whyNow && <span style={s.sub}>{action.whyNow}</span>}
          </div>
          <div style={rowActionsStyle}>
            {action.estimatedImpactLabel && <span style={s.meta}>{action.estimatedImpactLabel}</span>}
            {action.applyType && action.applyType !== 'content_change' ? (
              <span style={s.meta}>Manual setup</span>
            ) : upPvState?.loading ? (
              <span style={{ ...s.meta, fontStyle: 'italic' as const }}>Loading…</span>
            ) : upPvState?.data ? (
              <span style={s.meta}>Review below ↓</span>
            ) : (
              <button
                style={s.runBtn}
                onClick={e => { e.stopPropagation(); toggleActionPreview(action); }}
              >
                Review
              </button>
            )}
          </div>
        </div>
        {upPvState?.error && (
          <div style={s.panelError}>{PREVIEW_UNAVAILABLE_MSG}</div>
        )}
        {upPvState?.data && (isManualBlockReason(upPvState.data.blockReason) || (action.applyType && action.applyType !== 'content_change')) ? (
          <div style={s.manualNote}>
            <span>This recommendation requires manual setup — it can&apos;t be applied automatically.</span>
            {action.recommendedAction && <span style={s.manualNoteDetail}>{action.recommendedAction}</span>}
            <button style={s.manualNoteClose} onClick={() => setActionPreviews(p => { const n = { ...p }; delete n[action.actionKey]; return n; })}>
              Dismiss
            </button>
          </div>
        ) : upPvState?.data && (
          <PreviewPanel
            issueId={action.issueId}
            preview={upPvState.data}
            applyState={
              executeSuccesses?.[action.actionKey] ? { applying: false, applied: true,  error: null } :
              executeErrors?.[action.actionKey]    ? { applying: false, applied: false, error: executeErrors[action.actionKey]! } :
              null
            }
            isApplying={isRunning}
            onApply={() => onRunAction(action.actionKey)}
            onClose={() => setActionPreviews(p => { const n = { ...p }; delete n[action.actionKey]; return n; })}
          />
        )}
      </div>
    );
  }

  function renderCompactWinRow(row: FeedRow) {
    const item       = row.activityItem!;
    const pct        = item.revenueChangePercent ?? 0;
    const isSelected = row.key === selectedKey;
    const isHovered  = hoveredKey === row.key;
    return (
      <div key={row.key} style={s.rowWrap}>
        <div
          style={{ ...rowStyle,
            background: isSelected ? 'rgba(34,197,94,0.16)' : isHovered ? 'rgba(255,255,255,0.03)' : '#0f140f',
            boxShadow:  isSelected ? 'inset 4px 0 0 #22c55e' : undefined,
            cursor: 'pointer' }}
          onClick={() => onSelect?.(row)}
          onMouseEnter={() => setHoveredKey(row.key)}
          onMouseLeave={() => setHoveredKey(null)}
        >
          <Pill status={row.feedStatus} />
          <div style={s.rowMain}>
            {item.productTitle && <span style={{ ...s.product, ...s.truncate }}>{item.productTitle}</span>}
            <span style={{ ...s.issue, ...s.truncate }}>{issueLabel(item.issueId)}</span>
          </div>
          <span style={{ fontSize: 13, fontWeight: 800, color: '#4ade80', flexShrink: 0, letterSpacing: '-0.01em' }}>
            +{Math.round(pct)}%
          </span>
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
      <div key={row.key} style={{ ...s.rowWrap, cursor: 'pointer' }} onClick={() => onSelect?.(row)}>
        <div style={{ ...rowStyle, opacity: 0.65, boxShadow: row.key === selectedKey ? 'inset 3px 0 0 rgba(255,255,255,0.35)' : undefined }}>
          <Pill status={isRolledBack ? 'rolled_back' : 'measured'} />
          <div style={s.rowMain}>
            {item.productTitle && <span style={s.product}>{item.productTitle}</span>}
            <span style={{ ...s.issue, color: '#6b7280' }}>{issueLabel(item.issueId)}</span>
            {!narrow && isRolledBack && <span style={s.sub}>Reverted automatically</span>}
            {showLift && (
              <span style={{ ...s.sub, color: liftColor, ...(narrow ? s.truncate : {}) }}>
                {pct > 0 ? '+' : ''}{Math.round(pct)}%{!narrow && ' revenue · 7-day'}
              </span>
            )}
            {!narrow && row.feedStatus === 'measured' && item.measurementConfidence === 'insufficient' && (
              <span style={s.sub}>Window complete — not enough orders for a result</span>
            )}
          </div>
          <div style={rowActionsStyle}>
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
      <FeedFilterBar active={activeSection} onChange={setActiveSection} counts={filterCounts} narrow={narrow} />
      {ready.length === 0 && activeSection === 'all' && (
        <FeedStatusNote measuring={measuring.length} upnext={upnext.length} />
      )}
      <div style={{ ...s.sections, gap: narrow ? 20 : 28 }}>

      {/* ── WINS: proof the system delivers ──────────────────────────────── */}
      {showSection('wins') && wins.length > 0 && (
        <SectionBlock
          accent="#4ade80"
          label="Proven wins"
          count={wins.length}
          sub="Confirmed revenue lift. Already live and working on your store."
          narrow={narrow}
        >
          {narrow ? (
            <div style={s.list}>
              {wins.map(row => renderCompactWinRow(row))}
            </div>
          ) : (
            <div style={{ ...s.list, borderColor: 'rgba(34,197,94,0.14)' }}>
              {wins.map(row => (
                <div key={row.key}
                  onClick={() => onSelect?.(row)}
                  style={row.key === selectedKey ? { boxShadow: 'inset 3px 0 0 rgba(74,222,128,0.65)' } : {}}
                >
                  <WinCard row={row} />
                </div>
              ))}
            </div>
          )}
        </SectionBlock>
      )}

      {/* ── MEASURING: live validation ────────────────────────────────────── */}
      {showSection('measuring') && measuring.length > 0 && (
        <SectionBlock
          accent="#fbbf24"
          label="Measuring now"
          count={measuring.length}
          sub="Live on your store. Revenue data collecting — results within 7 days."
          narrow={narrow}
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
          narrow={narrow}
        >
          {selectableCount > 0 && (
            <div>
              <div style={s.batchBar}>
                <button style={s.batchBtn} onClick={onSelectAll}      disabled={isApplying || confirmingBatch}>Select all</button>
                <button style={s.batchBtn} onClick={onClearSelection} disabled={isApplying || confirmingBatch}>Clear</button>
                <span style={s.batchCount}>
                  {selected.size > 0
                    ? `${selected.size} of ${selectableCount} selected`
                    : `${selectableCount} improvement${selectableCount !== 1 ? 's' : ''} ready`}
                </span>
                <button
                  style={{ ...s.batchApply, opacity: (selected.size === 0 || isApplying || confirmingBatch) ? 0.4 : 1 }}
                  disabled={selected.size === 0 || isApplying || confirmingBatch}
                  onClick={() => selected.size > 0 && setConfirmingBatch(true)}
                >
                  {isApplying ? 'Applying…' : `Apply selected (${selected.size})`}
                </button>
              </div>
              {confirmingBatch && (
                <div style={s.batchConfirm}>
                  <div style={s.batchConfirmText}>
                    You&apos;re about to apply {selected.size} approved change{selected.size !== 1 ? 's' : ''} to your store.
                    These changes were reviewed by the system, but you won&apos;t preview each change individually in this batch action.
                  </div>
                  <div style={s.batchConfirmSub}>
                    To review changes one by one, cancel and open each recommendation separately.
                  </div>
                  <div style={s.batchConfirmActions}>
                    <button
                      style={{ ...s.batchApply, opacity: isApplying ? 0.6 : 1 }}
                      disabled={isApplying}
                      onClick={() => { setConfirmingBatch(false); onApply(); }}
                    >
                      {isApplying ? 'Applying…' : 'Apply approved changes'}
                    </button>
                    <button style={s.batchBtn} onClick={() => setConfirmingBatch(false)} disabled={isApplying}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
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
          narrow={narrow}
        >
          <div>
            {renderUpnextRow(upnext[0], !narrow)}
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
          narrow={narrow}
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

  batchBar:         { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  batchBtn:         { fontSize: 12, padding: '4px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 5, background: 'rgba(255,255,255,0.04)', cursor: 'pointer', color: '#9ca3af' },
  batchCount:       { fontSize: 12, color: '#4b5563', flex: 1 },
  batchApply:       { fontSize: 12, fontWeight: 700, padding: '6px 18px', border: 'none', borderRadius: 6, background: '#16a34a', color: '#fff', cursor: 'pointer', transition: 'opacity 0.15s', letterSpacing: '0.01em' },
  batchConfirm:        { display: 'flex', flexDirection: 'column' as const, gap: 6, padding: '10px 12px', marginBottom: 10, background: 'rgba(22,163,74,0.06)', border: '1px solid rgba(34,197,94,0.18)', borderRadius: 7 },
  batchConfirmText:    { fontSize: 12, color: '#d1d5db', lineHeight: 1.5 },
  batchConfirmSub:     { fontSize: 11, color: '#4b5563', lineHeight: 1.4 },
  batchConfirmActions: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 },

  errorBox:       { padding: '10px 14px', background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.18)', borderRadius: 7, color: '#f87171', fontSize: 13, marginBottom: 8 },

  list:           { display: 'flex', flexDirection: 'column', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, overflow: 'hidden' },
  rowWrap:        {},
  row:            { display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 14px', background: '#0f140f', borderBottom: '1px solid rgba(255,255,255,0.04)' },
  rowMain:        { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  rowActions:     { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, paddingTop: 1, minWidth: 96, justifyContent: 'flex-end' },

  product:        { fontSize: 10, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
  issue:          { fontSize: 13, fontWeight: 600, color: '#e5e7eb' },
  sub:            { fontSize: 11, color: '#6b7280', lineHeight: 1.4 },
  truncate:       { overflow: 'hidden', whiteSpace: 'nowrap' as const, textOverflow: 'ellipsis' },
  meta:           { fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap' as const },

  previewBtn:       { fontSize: 11, padding: '4px 12px', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 5, background: 'rgba(255,255,255,0.04)', cursor: 'pointer', color: '#9ca3af', whiteSpace: 'nowrap' as const, fontWeight: 500 },
  previewBtnActive: { background: 'rgba(59,130,246,0.08)', borderColor: 'rgba(96,165,250,0.3)', color: '#60a5fa' },
  appliedBadge:     { fontSize: 11, fontWeight: 700, color: '#4ade80' },
  panelError:       { padding: '8px 16px 8px 52px', fontSize: 12, color: '#f87171', background: '#0d120d', borderTop: '1px solid rgba(255,255,255,0.04)' },

  manualNote:       { padding: '10px 16px 10px 52px', fontSize: 12, color: '#d97706', background: '#0d120d', borderTop: '1px solid rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column' as const, gap: 5 },
  manualNoteDetail: { color: '#9ca3af', lineHeight: 1.5 },
  manualNoteClose:  { background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 11, padding: 0, textAlign: 'left' as const, textDecoration: 'underline', alignSelf: 'flex-start' as const },
  runBtn:   { fontSize: 11, fontWeight: 700, padding: '5px 14px', border: 'none', borderRadius: 5, background: '#16a34a', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  undoBtn:  { fontSize: 11, padding: '3px 10px', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 4, background: 'rgba(255,255,255,0.04)', color: '#9ca3af', cursor: 'pointer', whiteSpace: 'nowrap' as const },
  undoDone: { fontSize: 11, color: '#4ade80',  whiteSpace: 'nowrap' as const },
  undoError:{ fontSize: 11, color: '#f87171' },
  rbConfirmPanel:   { padding: '8px 14px 10px 42px', background: '#0d120d', borderTop: '1px solid rgba(255,255,255,0.04)', display: 'flex', flexDirection: 'column' as const, gap: 6 },
  rbConfirmText:    { fontSize: 11, color: '#9ca3af', lineHeight: 1.4 },
  rbConfirmActions: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 2 },
};

// Section block header styles
const sb: Record<string, React.CSSProperties> = {
  titleRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 },
  label:    { fontSize: 13, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' as const, color: '#9ca3af' },
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
  heroCategory:     { fontSize: 10, fontWeight: 700, color: '#6b7280', letterSpacing: '0.06em',
                      textTransform: 'uppercase' as const, display: 'inline-block', marginBottom: 8,
                      background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.09)',
                      borderRadius: 3, padding: '2px 7px' },
  heroPreviewNote:  { fontSize: 12, color: '#6b7280', fontStyle: 'italic' as const, marginTop: 2 },
  heroManualNote:   { fontSize: 12, color: '#d97706', lineHeight: 1.55, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, padding: '8px 12px', background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.15)', borderRadius: 6, marginTop: 8 },
  heroManualClose:  { background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 11, padding: 0, whiteSpace: 'nowrap' as const, flexShrink: 0 },
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
  successBlock:{ padding: '10px 14px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.22)', borderRadius: 8 },
  successText: { fontSize: 13, fontWeight: 700, color: '#4ade80' },
  successSub:  { fontSize: 12, color: '#6b7280', marginTop: 4 },
};
