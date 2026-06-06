'use client';

import { useState, useEffect } from 'react';
import type { FeedRow } from './OptimizationFeed';
import { fetchContentPreview, submitReviewApproval, fetchExecutionDetails } from '@/lib/api';
import type { ContentPreview, DecisionV2 } from '@/lib/api';
import DecisionV2Card from './DecisionV2Card';
import { blockReasonLabel, PREVIEW_UNAVAILABLE_MSG, proposedContentLabel } from './previewCopy';

const ISSUE_CATEGORY: Record<string, string> = {
  weak_desire_creation:         'Desire & copy',
  features_before_desire:       'Desire & copy',
  no_future_pacing:             'Desire & copy',
  no_sensory_language:          'Desire & copy',
  no_outcome_sentence:          'Desire & copy',
  spec_pivot_early:             'Desire & copy',
  no_description:               'Description',
  description_too_short:        'Description',
  description_center_aligned:   'Description',
  no_risk_reversal:             'Trust & risk',
  no_social_proof:              'Trust & risk',
  no_trust_bullets:             'Trust & risk',
  no_urgency:                   'Urgency & price',
  no_compare_price:             'Urgency & price',
  weak_discount:                'Urgency & price',
  strong_discount_not_featured: 'Urgency & price',
  no_size_guide:                'UX & media',
  no_images:                    'UX & media',
  few_images:                   'UX & media',
  missing_alt_text:             'UX & media',
  no_bundle_pricing:            'Pricing',
  low_inventory_unused:         'Availability',
  all_variants_oos:             'Availability',
  some_variants_oos:            'Availability',
  product_is_draft:             'Availability',
};

const STATUS_CFG: Record<string, { label: string; color: string; bg: string }> = {
  ready:       { label: 'Ready to apply',   color: '#22c55e', bg: 'rgba(34,197,94,0.08)'   },
  live:        { label: 'Live · measuring', color: '#4ade80', bg: 'rgba(34,197,94,0.06)'   },
  measuring:   { label: 'Measuring now',    color: '#fbbf24', bg: 'rgba(251,191,36,0.08)'  },
  measured:    { label: 'Measured',         color: '#60a5fa', bg: 'rgba(96,165,250,0.08)'  },
  queued:      { label: 'Up next',          color: '#9ca3af', bg: 'rgba(255,255,255,0.04)' },
  rolled_back: { label: 'Protected',        color: '#6b7280', bg: 'rgba(107,114,128,0.06)' },
};

const DECISION_SIGNAL_LABEL: Record<string, string> = {
  keep:               'Performing well',
  revise:             'Consider revision',
  rollback_candidate: 'Rollback candidate',
  still_measuring:    'Still measuring',
};

function pctStr(v: number | null): string {
  if (v === null) return '—';
  return `${v > 0 ? '+' : ''}${Math.round(v)}%`;
}

function pctColor(v: number | null): string {
  if (v === null) return '#6b7280';
  return v > 0 ? '#4ade80' : v < 0 ? '#f87171' : '#9ca3af';
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtReadyAt(iso: string | null): string {
  if (!iso) return 'soon';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Small metric block used in measurement sections ──────────────────────────
function MetricBlock({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <div style={mb.block}>
      <div style={{ ...mb.value, color }}>{value}</div>
      <div style={mb.label}>{label}</div>
    </div>
  );
}

const mb: Record<string, React.CSSProperties> = {
  block: { display: 'flex', flexDirection: 'column' as const, gap: 3, minWidth: 52 },
  value: { fontSize: 24, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1 },
  label: { fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const,
           letterSpacing: '0.08em', color: '#4b5563' },
};

// ── Trust Badges visual preview helpers ──────────────────────────────────────
// Trust Badges are a controlled, validator-approved HTML UI block, so they get a
// rendered visual preview. Every OTHER recommendation keeps the plain escaped-text
// preview — this is NOT a generic HTML renderer.
function isTrustBadgeContent(issueId: string | undefined, html: string): boolean {
  return issueId === 'no_trust_bullets' || /data-cro-trust-badges/.test(html);
}
// Defensive gate before dangerouslySetInnerHTML. Renders only the safe controlled
// badge markup; refuses scripts, event handlers, remote assets/links, iframes, or
// <style>. On any failure the caller falls back to escaped raw HTML.
function isBadgeHtmlSafe(html: string): boolean {
  if (!/data-cro-trust-badges/.test(html)) return false;
  if (/<script|<iframe|<style/i.test(html)) return false;
  if (/\son\w+\s*=/i.test(html))            return false; // event handlers
  if (/https?:\/\//i.test(html))            return false; // remote URLs
  if (/\s(src|href)\s*=/i.test(html))       return false; // external assets/links
  return true;
}

// ── Main panel ───────────────────────────────────────────────────────────────

export default function ProductInspectorPanel({
  row,
  shop,
  onRunAction,
  executing,
  executeErrors,
  executeSuccesses,
  onRollback,
  rollingBack,
  rollbackErrors,
  rollbackSuccesses,
}: {
  row:              FeedRow | null;
  shop:             string;
  onRunAction?:     (key: string) => void;
  executing?:       Set<string>;
  executeErrors?:   Record<string, string | null>;
  executeSuccesses?: Record<string, string>;
  onRollback?:        (productId: string, issueId: string) => void;
  rollingBack?:       Set<string>;
  rollbackErrors?:    Record<string, string | null>;
  rollbackSuccesses?: Record<string, string>;
}) {
  type PvState = { data: ContentPreview | null; phase: 'idle' | 'loading' | 'ready'; error: string | null };
  const [pv, setPv]                           = useState<PvState>({ data: null, phase: 'idle', error: null });
  const [pvReviewError, setPvReviewError]     = useState<string | null>(null);
  const [isPersistingReview, setIsPersisting] = useState(false);
  const [confirmingRollback, setConfirmingRollback] = useState(false);

  // Conversion-first decision object for the selected Measuring/activity item.
  // Fetched read-only from /metrics/executions/:id/details (which returns decisionV2).
  // The panel is remounted (keyed by row) on selection change, so state starts
  // fresh per item — no manual reset needed. Failures are non-fatal.
  const activityExecId = row?.activityItem?.executionId ?? null;
  const [decisionV2, setDecisionV2] = useState<DecisionV2 | null>(null);
  useEffect(() => {
    if (!activityExecId) return;
    let cancelled = false;
    fetchExecutionDetails(shop, activityExecId)
      .then(d => { if (!cancelled) setDecisionV2(d?.decisionV2 ?? null); })
      .catch(() => { /* non-fatal: leave decisionV2 null */ });
    return () => { cancelled = true; };
  }, [shop, activityExecId]);

  if (!row) {
    return (
      <div style={p.wrap}>
        <div style={p.emptyBody}>
          <div style={p.emptyDot} />
          <span style={p.emptyText}>Select a product to inspect</span>
        </div>
      </div>
    );
  }

  const action   = row.topAction;
  const activity = row.activityItem;
  const ready    = row.readyItem;
  const status   = STATUS_CFG[row.feedStatus] ?? { label: row.feedStatus, color: '#9ca3af', bg: 'transparent' };
  const category = ISSUE_CATEGORY[row.issueId] ?? 'Optimization';
  const isRunning      = action ? (executing?.has(action.actionKey) ?? false) : false;
  const executeSuccess = action ? (executeSuccesses?.[action.actionKey] ?? null) : null;

  const rbKey     = activity ? `${activity.productId}::${activity.issueId}` : null;
  const isRolling = rbKey ? (rollingBack?.has(rbKey) ?? false) : false;
  const rbError   = rbKey ? (rollbackErrors?.[rbKey] ?? null) : null;
  const rbSuccess = rbKey ? (rollbackSuccesses?.[rbKey] ?? null) : null;

  async function loadPreview() {
    if (!action) return;
    setPvReviewError(null);
    setPv(s => ({ ...s, phase: 'loading', error: null }));
    try {
      const data = await fetchContentPreview(shop, action.productId, action.issueId);
      setPv({ data, phase: 'ready', error: null });
    } catch (err) {
      setPv({ data: null, phase: 'idle', error: (err as Error).message });
    }
  }

  async function handleApplyWithReview() {
    if (!action || !onRunAction) return;
    const pc = pv.data?.proposedContent;
    if (!pc || pc.trim().length === 0) {
      setPvReviewError('Please preview this change again before applying.');
      return;
    }
    setPvReviewError(null);
    setIsPersisting(true);
    try {
      await submitReviewApproval(shop, action.productId, action.issueId, pc);
    } catch {
      setPvReviewError('Please preview this change again before applying.');
      setIsPersisting(false);
      return;
    }
    setIsPersisting(false);
    onRunAction(action.actionKey);
  }

  return (
    <div style={p.wrap}>

      {/* ── Identity band ──────────────────────────────────────────────────── */}
      <div style={p.identityBand}>
        <div style={p.bandMeta}>
          <span style={{ ...p.statusPill, color: status.color, background: status.bg }}>
            {status.label}
          </span>
          <span style={p.categoryChip}>{category}</span>
        </div>
        <div style={p.productName}>{row.productTitle ?? 'Unknown product'}</div>
      </div>

      <div style={p.divider} />

      {/* ══ ACTION PATH — topAction ════════════════════════════════════════ */}
      {action && (
        <div style={p.decisionBlock}>

          {/* Recommendation — the decision headline */}
          {action.recommendedAction && (
            <div style={p.headline}>{action.recommendedAction}</div>
          )}

          {/* Why now — one concise line */}
          {action.whyNow && (
            <div style={p.whyLine}>{action.whyNow}</div>
          )}

          {/* Impact chips */}
          {(action.estimatedImpactLabel || action.revenue > 0 || action.quickWin) && (
            <div style={p.impactRow}>
              {action.estimatedImpactLabel && (
                <span style={p.impactChip}>{action.estimatedImpactLabel}</span>
              )}
              {action.revenue > 0 && (
                <span style={p.revenueChip}>
                  ${Math.round(action.revenue).toLocaleString()} at stake
                </span>
              )}
              {action.quickWin && (
                <span style={p.quickWinChip}>Quick win</span>
              )}
            </div>
          )}

          {/* Success confirmation — shown immediately after apply, persists across feedStatus transitions */}
          {executeSuccess && (
            <div style={p.successBlock}>
              <div style={p.successText}>✓ Change applied successfully.</div>
              <div style={p.successSub}>We&apos;re measuring its impact now.</div>
            </div>
          )}

          {/* CTA — queued items: preview-first flow (hidden once success is confirmed) */}
          {!executeSuccess && row.feedStatus === 'queued' && onRunAction && (
            action.openMeasurementWindow ? (
              <div style={p.guardNote}>
                A change is already measuring on this product
                {action.openMeasurementWindowReadyAt
                  ? ` — results due ${fmtReadyAt(action.openMeasurementWindowReadyAt)}.`
                  : '.'}
                {' '}Apply this after the measurement completes.
              </div>
            ) : pv.phase === 'idle' ? (
              action.applyType && action.applyType !== 'content_change' ? (
                <div style={p.guardNote}>This recommendation requires manual setup — it can&apos;t be applied automatically.</div>
              ) : (
                <button style={p.ctaBtn} onClick={loadPreview}>
                  Preview fix
                </button>
              )
            ) : pv.phase === 'loading' ? (
              <div style={p.pvLoading}>Generating preview…</div>
            ) : pv.data !== null ? (
              <div style={p.pvBlock}>
                {!pv.data.eligibleToApply ? (
                  <div style={p.guardNote}>{blockReasonLabel(pv.data.blockReason)}</div>
                ) : (
                  <>
                    {pv.data.currentContent && (
                      <div>
                        <div style={p.pvLabel}>Current version on your product page</div>
                        <div style={p.pvContent}>{stripHtml(pv.data.currentContent)}</div>
                      </div>
                    )}
                    {typeof pv.data.proposedContent === 'string' && pv.data.proposedContent.trim().length > 0 ? (
                      <>
                        <div>
                          <div style={{ ...p.pvLabel, color: '#4ade80' }}>
                            {proposedContentLabel(pv.data.patchMode)}
                          </div>
                          {isTrustBadgeContent(row.issueId, pv.data.proposedContent) && isBadgeHtmlSafe(pv.data.proposedContent) ? (
                            <>
                              {/* Rendered visual preview — controlled, validator-approved badge block only */}
                              <div
                                style={{ ...p.pvContent, borderColor: 'rgba(34,197,94,0.22)', background: 'rgba(34,197,94,0.05)', color: '#e5e7eb', maxHeight: 'none', overflow: 'visible' }}
                                dangerouslySetInnerHTML={{ __html: pv.data.proposedContent }}
                              />
                              <div style={p.pvPlacementNote}>Placement: Top of product description</div>
                              <details style={p.pvDetails}>
                                <summary style={p.pvDetailsSummary}>Technical HTML</summary>
                                <div style={p.pvRawHtml}>{pv.data.proposedContent}</div>
                              </details>
                            </>
                          ) : (
                            <div style={{ ...p.pvContent, borderColor: 'rgba(34,197,94,0.22)', background: 'rgba(34,197,94,0.05)' }}>
                              {pv.data.proposedContent}
                            </div>
                          )}
                        </div>
                        <div style={p.pvReversibility}>You can undo this change anytime.</div>
                        <button
                          style={{ ...p.ctaBtn, opacity: (isRunning || isPersistingReview) ? 0.6 : 1 }}
                          disabled={isRunning || isPersistingReview}
                          onClick={handleApplyWithReview}
                        >
                          {(isRunning || isPersistingReview) ? 'Applying…' : 'Apply this change'}
                        </button>
                        {pvReviewError && (
                          <div style={p.pvError}>{pvReviewError}</div>
                        )}
                        {executeErrors?.[action.actionKey] && (
                          <div style={p.pvError}>{executeErrors[action.actionKey]}</div>
                        )}
                      </>
                    ) : (
                      <div style={p.guardNote}>{PREVIEW_UNAVAILABLE_MSG}</div>
                    )}
                  </>
                )}
                {!isRunning && (
                  <button style={p.pvBackBtn} onClick={() => setPv({ data: null, phase: 'idle', error: null })}>
                    ← Back
                  </button>
                )}
              </div>
            ) : null
          )}
          {pv.error && !executeSuccess && row.feedStatus === 'queued' && (
            <div style={p.pvError}>{pv.error}</div>
          )}

          {/* Measuring state — results ETA */}
          {!executeSuccess && row.feedStatus === 'measuring' && action.openMeasurementWindowReadyAt && (
            <div style={p.measuringNote}>
              Results by {fmtReadyAt(action.openMeasurementWindowReadyAt)}
            </div>
          )}

        </div>
      )}

      {/* ══ ACTIVITY PATH — measuring / measured / live / rolled_back ═════ */}
      {activity && (
        <div style={p.decisionBlock}>
          <div style={p.metricsRow}>
              <MetricBlock
                value={pctStr(activity.revenueChangePercent)}
                label="Revenue"
                color={pctColor(activity.revenueChangePercent)}
              />
              <MetricBlock
                value={pctStr(activity.ordersChangePercent)}
                label="Orders"
                color={pctColor(activity.ordersChangePercent)}
              />
              {activity.measurementConfidence && activity.measurementConfidence !== 'insufficient' && (
                <MetricBlock
                  value={activity.measurementConfidence}
                  label="Confidence"
                  color="#9ca3af"
                />
              )}
            </div>
            {activity.insight && (
              <div style={p.whyLine}>{activity.insight}</div>
            )}
            {activity.decisionSignal && activity.decisionSignal !== 'still_measuring' && (
              <span style={p.signalChip}>
                {DECISION_SIGNAL_LABEL[activity.decisionSignal] ?? activity.decisionSignal}
              </span>
            )}
            {activity.createdAt && (
              <div style={p.metaRow}>
                <span style={p.metaItem}>Applied {fmtDate(activity.createdAt)}</span>
              </div>
            )}

            {/* Conversion-first recommendation (advisory, read-only) */}
            {decisionV2 && <DecisionV2Card d={decisionV2} variant="dark" />}

            {/* Rollback — available while change is still live/measuring */}
            {activity.status === 'applied' && onRollback && rbSuccess && (
              <div style={p.rbSuccess}>{rbSuccess}</div>
            )}
            {activity.status === 'applied' && onRollback && !rbSuccess && !confirmingRollback && (
              <>
                <button style={p.rbBtn} onClick={() => setConfirmingRollback(true)}>
                  Undo this change
                </button>
                {rbError && <div style={p.pvError}>{rbError}</div>}
              </>
            )}
            {activity.status === 'applied' && onRollback && !rbSuccess && confirmingRollback && (
              <div style={p.rbConfirm}>
                <div style={p.rbConfirmText}>
                  This reverts the change on your store and restores your original content immediately.
                </div>
                <div style={p.rbConfirmActions}>
                  <button
                    style={{ ...p.rbConfirmBtn, opacity: isRolling ? 0.6 : 1 }}
                    disabled={isRolling}
                    onClick={() => onRollback(activity.productId, activity.issueId)}
                  >
                    {isRolling ? 'Reverting…' : 'Confirm revert'}
                  </button>
                  <button style={p.rbCancelBtn} disabled={isRolling} onClick={() => setConfirmingRollback(false)}>
                    Cancel
                  </button>
                </div>
                {rbError && <div style={p.pvError}>{rbError}</div>}
              </div>
            )}
        </div>
      )}

      {/* ══ READY PATH — ready item with no topAction or activity ══════════ */}
      {ready && !action && !activity && (
        <div style={p.decisionBlock}>
          {(ready.severity || ready.score !== null || ready.riskLevel) && (
            <div style={p.metricsRow}>
              {ready.severity && (
                <MetricBlock value={ready.severity} label="Severity" color="#f9fafb" />
              )}
              {ready.score !== null && (
                <MetricBlock value={String(ready.score)} label="Score" color="#f9fafb" />
              )}
              {ready.riskLevel && (
                <MetricBlock value={ready.riskLevel} label="Risk" color="#f9fafb" />
              )}
            </div>
          )}
          <div style={p.readyHint}>Select in the list to preview and apply</div>
        </div>
      )}

      {/* ── Behavior data — collapsed ──────────────────────────────────────── */}
      <div style={p.divider} />
      <details>
        <summary style={p.detailsSummary}>Behavior data</summary>
        <div style={p.detailsBody}>
          <div style={p.unavailable}>ATC rate — not yet at product level</div>
          <div style={p.unavailable}>Scroll depth — not yet captured</div>
        </div>
      </details>

    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const p: Record<string, React.CSSProperties> = {
  wrap: {
    background:   '#0f140f',
    border:       '1px solid rgba(255,255,255,0.07)',
    borderTop:    '2px solid rgba(34,197,94,0.35)',
    borderRadius: 10,
    overflow:     'hidden',
    position:     'sticky' as const,
    top:          76,
    alignSelf:    'flex-start' as const,
  },

  emptyBody:  { padding: '52px 32px', display: 'flex', flexDirection: 'column' as const,
                gap: 10, alignItems: 'center', textAlign: 'center' as const },
  emptyDot:   { width: 8, height: 8, borderRadius: '50%', background: 'rgba(255,255,255,0.06)' },
  emptyText:  { fontSize: 13, color: '#4b5563' },

  // Identity band
  identityBand: { padding: '18px 24px 16px' },
  bandMeta:     { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
  statusPill:   { fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
                  borderRadius: 20, padding: '3px 10px' },
  categoryChip: { fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
                  textTransform: 'uppercase' as const, color: '#6b7280',
                  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)',
                  borderRadius: 3, padding: '2px 7px' },
  productName:  { fontSize: 17, fontWeight: 800, color: '#f9fafb', lineHeight: 1.25 },

  divider:      { height: 1, background: 'rgba(255,255,255,0.05)' },

  // Decision block — shared by all paths
  decisionBlock: { padding: '18px 24px', display: 'flex', flexDirection: 'column' as const, gap: 12 },

  // Issue type label — small ALLCAPS above headline
  issueLine:  { fontSize: 9, fontWeight: 700, letterSpacing: '0.10em',
                textTransform: 'uppercase' as const, color: '#6b7280' },

  // The decision headline — largest text in the decision block
  headline:   { fontSize: 19, fontWeight: 800, color: '#f9fafb', lineHeight: 1.3,
                letterSpacing: '-0.01em' },

  // Why now — single line, readable but not dominant
  whyLine:    { fontSize: 12, color: '#6b7280', lineHeight: 1.55 },

  // Impact chips row
  impactRow:     { display: 'flex', flexWrap: 'wrap' as const, gap: 7, alignItems: 'center' },
  impactChip:    { fontSize: 13, fontWeight: 800, color: '#4ade80', background: 'rgba(34,197,94,0.07)',
                   border: '1px solid rgba(34,197,94,0.20)', borderRadius: 6, padding: '4px 10px',
                   letterSpacing: '-0.01em' },
  revenueChip:   { fontSize: 12, fontWeight: 600, color: '#d1d5db', background: 'rgba(255,255,255,0.04)',
                   border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, padding: '4px 10px' },
  quickWinChip:  { fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
                   textTransform: 'uppercase' as const, color: '#4ade80',
                   background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.18)',
                   borderRadius: 3, padding: '3px 7px' },

  // Meta row — opportunity score, time to impact
  metaRow:    { display: 'flex', gap: 14, alignItems: 'center' },
  metaItem:   { fontSize: 11, color: '#6b7280' },

  // CTA button — full width, prominent green
  ctaBtn: {
    width:         '100%',
    padding:       '12px 20px',
    fontSize:      14,
    fontWeight:    700,
    letterSpacing: '-0.01em',
    border:        'none',
    borderRadius:  8,
    background:    '#15803d',
    color:         '#fff',
    cursor:        'pointer',
    textAlign:     'center' as const,
    transition:    'opacity 0.15s',
  },

  // Measuring state note
  measuringNote: { fontSize: 12, color: '#6b7280', fontStyle: 'italic' as const },

  // Guard note — shown when apply is blocked
  guardNote:   { fontSize: 12, color: '#d97706', background: 'rgba(217,119,6,0.06)',
                 border: '1px solid rgba(217,119,6,0.18)', borderRadius: 6,
                 padding: '10px 12px', lineHeight: 1.5 },

  // Preview block — inline preview content
  pvLoading:       { fontSize: 12, color: '#6b7280', fontStyle: 'italic' as const },
  pvBlock:         { display: 'flex', flexDirection: 'column' as const, gap: 12 },
  pvLabel:         { fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const,
                     letterSpacing: '0.08em', color: '#6b7280', marginBottom: 4 },
  pvContent:       { fontSize: 12, color: '#d1d5db', lineHeight: 1.6, maxHeight: 96,
                     overflow: 'hidden' as const, border: '1px solid rgba(255,255,255,0.08)',
                     borderRadius: 6, padding: '8px 10px', background: 'rgba(255,255,255,0.02)' },
  pvReversibility: { fontSize: 11, color: '#4b5563', fontStyle: 'italic' as const },
  pvPlacementNote: { fontSize: 11, color: '#9ca3af', marginTop: 6 },
  pvDetails:       { marginTop: 8 },
  pvDetailsSummary:{ fontSize: 11, color: '#6b7280', cursor: 'pointer', userSelect: 'none' as const },
  pvRawHtml:       { fontSize: 11, color: '#9ca3af', lineHeight: 1.5, marginTop: 6,
                     maxHeight: 140, overflow: 'auto' as const, whiteSpace: 'pre-wrap' as const,
                     wordBreak: 'break-all' as const, border: '1px solid rgba(255,255,255,0.08)',
                     borderRadius: 6, padding: '8px 10px', background: 'rgba(255,255,255,0.02)',
                     fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  pvBackBtn:       { background: 'none', border: 'none', color: '#4b5563', cursor: 'pointer',
                     fontSize: 12, padding: '0', textAlign: 'left' as const, textDecoration: 'underline' },
  pvError:         { fontSize: 12, color: '#f87171' },
  successBlock:    { padding: '10px 14px', background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.22)', borderRadius: 8 },
  successText:     { fontSize: 13, fontWeight: 700, color: '#4ade80' },
  successSub:      { fontSize: 12, color: '#6b7280', marginTop: 4 },

  // Measurement metrics row
  metricsRow: { display: 'flex', gap: 20, alignItems: 'flex-end' },

  // Signal chip — decision outcome
  signalChip: { display: 'inline-block', fontSize: 11, fontWeight: 600, color: '#9ca3af',
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 4, padding: '3px 10px' },

  // Ready path hint
  readyHint:  { fontSize: 11, color: '#6b7280', fontStyle: 'italic' as const },

  // Rollback section
  rbBtn:          { background: 'none', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 6,
                    color: '#9ca3af', cursor: 'pointer', fontSize: 12, padding: '7px 14px',
                    textAlign: 'left' as const, letterSpacing: '0.01em' },
  rbSuccess:      { fontSize: 12, color: '#4ade80', padding: '6px 0' },
  rbConfirm:      { display: 'flex', flexDirection: 'column' as const, gap: 8, padding: '10px 14px',
                    background: 'rgba(248,113,113,0.05)', border: '1px solid rgba(248,113,113,0.18)',
                    borderRadius: 7 },
  rbConfirmText:  { fontSize: 12, color: '#d1d5db', lineHeight: 1.5 },
  rbConfirmActions: { display: 'flex', gap: 8, alignItems: 'center' },
  rbConfirmBtn:   { fontSize: 12, fontWeight: 700, padding: '6px 14px', border: 'none', borderRadius: 6,
                    background: 'rgba(239,68,68,0.75)', color: '#fff', cursor: 'pointer' },
  rbCancelBtn:    { fontSize: 12, padding: '5px 10px', border: '1px solid rgba(255,255,255,0.10)',
                    borderRadius: 6, background: 'rgba(255,255,255,0.03)', cursor: 'pointer', color: '#9ca3af' },

  // Behavior tracking disclosure
  detailsSummary: { fontSize: 10, color: '#4b5563', padding: '9px 24px',
                    cursor: 'pointer', letterSpacing: '0.02em' },
  detailsBody:    { padding: '0 24px 10px' },
  unavailable:    { fontSize: 10, color: '#4b5563', lineHeight: 1.5, marginBottom: 3,
                    fontStyle: 'italic' as const },
};
