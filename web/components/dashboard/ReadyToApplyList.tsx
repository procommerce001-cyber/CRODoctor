import { useState } from 'react';
import type { ReviewItem, ContentPreview } from '@/lib/api';
import { fetchContentPreview, applySelected, issueLabel, API_BASE, apiHeaders } from '@/lib/api';

const SHOP = process.env.NEXT_PUBLIC_SHOP ?? '';

function stripHtml(html: string | null): string {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function patchDescription(patchMode: string | null): string {
  if (patchMode === 'replace_full_body')     return 'This will replace your current product description.';
  if (patchMode === 'insert_after_anchor')   return 'This will add new content to your product description.';
  if (patchMode === 'replace_matched_block') return 'This will update a section of your product description.';
  return 'This will update your product description.';
}

function proposedLabel(patchMode: string | null): string {
  if (patchMode === 'replace_full_body') return 'What will replace it';
  return 'What will be added';
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#65a30d',
};

const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical', high: 'High priority', medium: 'Medium', low: 'Low',
};

const REVIEW_STATUS_LABEL: Record<string, string> = {
  approved: 'Ready to apply',
  pending:  'Needs review',
  rejected: 'Rejected',
};

const ISSUE_WHY: Record<string, string> = {
  no_risk_reversal:            'Shoppers hesitate without a guarantee — adding one reduces drop-off.',
  no_trust_bullets:            'Missing proof points make buyers uncertain before purchasing.',
  weak_desire_creation:        'The description doesn\'t create enough desire to buy.',
  no_description:              'No description — most shoppers will leave without one.',
  description_too_short:       'Short descriptions don\'t answer buyer questions.',
  description_center_aligned:  'Centre-aligned text is harder to read and reduces trust on mobile.',
  no_social_proof:             'No social proof — reviews are a top conversion driver.',
  no_size_guide:               'Without a size guide shoppers guess wrong and abandon the purchase.',
  no_urgency:                  'Nothing encourages action now — urgency signals move undecided shoppers.',
  no_compare_price:            'Without a reference price the value isn\'t obvious.',
  missing_alt_text:            'Missing image descriptions hurt SEO and accessibility.',
  no_future_pacing:            'Shoppers don\'t picture owning it — future-pacing language helps.',
  no_sensory_language:         'Flat copy doesn\'t create desire. Sensory words make products feel real.',
  no_outcome_sentence:         'No clear outcome — shoppers want to know what changes for them.',
};

interface PreviewState { loading: boolean; data: ContentPreview | null; error: string | null }
interface ApplyState   { applying: boolean; applied: boolean; rollingBack: boolean; error: string | null }

interface Props {
  shop: string;
  items: ReviewItem[];
  selected: Set<string>;
  isApplying: boolean;
  onToggle: (key: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onApply: () => void;
}

export default function ReadyToApplyList({
  shop, items, selected, isApplying, onToggle, onSelectAll, onClearSelection, onApply,
}: Props) {
  const selectableCount = items.filter(i => i.selectable).length;
  const [previews,    setPreviews]    = useState<Record<string, PreviewState>>({});
  const [applyStates, setApplyStates] = useState<Record<string, ApplyState>>({});

  async function handleSingleApply(item: ReviewItem, e: React.MouseEvent) {
    e.stopPropagation();
    const key = item.selectionKey;
    setApplyStates(s => ({ ...s, [key]: { applying: true, applied: false, rollingBack: false, error: null } }));
    try {
      const result = await applySelected(shop, [key]);
      const row    = result.results[0];
      if (row?.status === 'applied') {
        setApplyStates(s => ({ ...s, [key]: { applying: false, applied: true, rollingBack: false, error: null } }));
        setPreviews(p => { const n = { ...p }; delete n[key]; return n; });
      } else {
        setApplyStates(s => ({ ...s, [key]: { applying: false, applied: false, rollingBack: false, error: row?.reason ?? 'Apply did not succeed.' } }));
      }
    } catch (err) {
      setApplyStates(s => ({ ...s, [key]: { applying: false, applied: false, rollingBack: false, error: (err as Error).message } }));
    }
  }

  async function handleSingleRollback(item: ReviewItem, e: React.MouseEvent) {
    e.stopPropagation();
    const key = item.selectionKey;
    setApplyStates(s => ({ ...s, [key]: { ...s[key], rollingBack: true, error: null } }));
    try {
      const res = await fetch(
        `${API_BASE}/action-center/products/${encodeURIComponent(item.productId)}/rollback`,
        {
          method:      'POST',
          credentials: 'include',
          headers:     apiHeaders({ 'Content-Type': 'application/json' }),
          body:        JSON.stringify({ shop: SHOP, issueId: item.issueId }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      setApplyStates(s => { const n = { ...s }; delete n[key]; return n; });
    } catch (err) {
      setApplyStates(s => ({ ...s, [key]: { ...s[key], rollingBack: false, error: (err as Error).message } }));
    }
  }

  async function handlePreview(item: ReviewItem, e: React.MouseEvent) {
    e.stopPropagation();
    const key = item.selectionKey;
    if (previews[key]?.data) {
      // toggle off
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

  return (
    <section>
      {/* Heading + summary bar */}
      <div style={styles.headingRow}>
        <h2 style={styles.heading}>
          Ready to Apply <span style={styles.badge}>{items.length}</span>
        </h2>
        <span style={styles.summary}>
          {selectableCount} action{selectableCount !== 1 ? 's' : ''} ready
          {' · '}
          <strong>{selected.size}</strong> selected
        </span>
      </div>

      {/* Controls */}
      <div style={styles.controls}>
        <button style={styles.btnSecondary} onClick={onSelectAll}  disabled={isApplying}>Select All</button>
        <button style={styles.btnSecondary} onClick={onClearSelection} disabled={isApplying}>Clear</button>
        <button
          style={{ ...styles.btnPrimary, opacity: (selected.size === 0 || isApplying) ? 0.4 : 1 }}
          onClick={onApply}
          disabled={selected.size === 0 || isApplying}
        >
          {isApplying ? 'Applying…' : `Apply Selected (${selected.size})`}
        </button>
      </div>

      {/* Table */}
      {items.length === 0 ? (
        <p style={styles.empty}>No approved fixes queued. Open a product, review its suggested actions, and approve one to see it here.</p>
      ) : (
        <div style={styles.table}>
          <div style={styles.headerRow}>
            <span />
            <span>Issue</span>
            <span>Priority</span>
            <span>Safety</span>
            <span>Status</span>
            <span>Preview</span>
          </div>
          {items.map((item) => {
            const isChecked  = selected.has(item.selectionKey);
            const isDisabled = !item.selectable;
            const ps         = previews[item.selectionKey];
            const as         = applyStates[item.selectionKey];
            return (
              <div key={item.selectionKey}>
                <div
                  style={{ ...styles.row, background: isChecked ? '#f0fdf4' : '#fff', opacity: isDisabled ? 0.5 : 1 }}
                  onClick={() => !isDisabled && onToggle(item.selectionKey)}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    disabled={isDisabled}
                    onChange={() => onToggle(item.selectionKey)}
                    onClick={e => e.stopPropagation()}
                    style={{ cursor: isDisabled ? 'not-allowed' : 'pointer' }}
                  />
                  <span style={styles.titleCell}>
                    {item.productTitle && <span style={styles.productName}>{item.productTitle}</span>}
                    <span style={styles.title}>{issueLabel(item.issueId)}</span>
                    {ISSUE_WHY[item.issueId] && (
                      <span style={styles.issueWhy}>{ISSUE_WHY[item.issueId]}</span>
                    )}
                  </span>
                  <span style={{ ...styles.pill, color: SEVERITY_COLOR[item.severity] ?? '#374151' }}>
                    {SEVERITY_LABEL[item.severity] ?? item.severity}
                  </span>
                  <span style={styles.safetyBadge}>{item.riskLevel === 'low' ? '✓ Safe' : item.riskLevel}</span>
                  <span style={{ ...styles.statusBadge, ...(item.reviewStatus === 'approved' ? styles.statusReady : {}) }}>
                    {REVIEW_STATUS_LABEL[item.reviewStatus] ?? item.reviewStatus}
                  </span>
                  <button
                    style={{ ...styles.btnPreview, ...(ps?.data ? styles.btnPreviewActive : {}) }}
                    onClick={e => handlePreview(item, e)}
                    disabled={ps?.loading}
                  >
                    {ps?.loading ? '…' : ps?.data ? 'Hide' : 'Preview'}
                  </button>
                </div>
                {ps?.error && (
                  <div style={styles.previewPanel}>
                    <span style={{ color: '#dc2626' }}>{ps.error}</span>
                  </div>
                )}
                {as?.applied && (
                  <div style={styles.successPanel}>
                    <div style={styles.successMain}>✓ This change is now live on your product page.</div>
                    <div style={styles.successSub}>We&apos;ll track the impact over the next 7 days — check back here for results.</div>
                    <div style={styles.successFooter}>
                      <button
                        style={{ ...styles.btnCancel, fontSize: 11, padding: '3px 10px', opacity: as.rollingBack ? 0.5 : 1 }}
                        onClick={e => handleSingleRollback(item, e)}
                        disabled={as.rollingBack}
                      >
                        {as.rollingBack ? 'Undoing…' : 'Undo this change'}
                      </button>
                      {as.error && <span style={{ color: '#dc2626', fontSize: 11 }}>{as.error}</span>}
                    </div>
                  </div>
                )}
                {ps?.data && !as?.applied && (
                  <div style={styles.previewPanel}>
                    <div style={styles.previewContext}>
                      <span style={styles.previewContextText}>{patchDescription(ps.data.patchMode)}</span>
                      {ps.data.diffSummary && (
                        <span style={styles.previewDiffNote}>{ps.data.diffSummary.note}</span>
                      )}
                    </div>
                    {ps.data.eligibleToApply ? (
                      <>
                        {ps.data.currentContent && (
                          <div style={{ ...styles.previewContent, marginBottom: 8 }}>
                            <div style={styles.previewLabel}>What&apos;s on your page now</div>
                            <div style={{ ...styles.previewText, color: '#6b7280', maxHeight: 72, overflow: 'hidden' }}>
                              {stripHtml(ps.data.currentContent)}
                            </div>
                          </div>
                        )}
                        <div style={styles.previewContent}>
                          <div style={{ ...styles.previewLabel, color: '#16a34a' }}>{proposedLabel(ps.data.patchMode)}</div>
                          <div style={{ ...styles.previewText, borderColor: '#bbf7d0', background: '#f0fdf4' }}>{ps.data.proposedContent}</div>
                        </div>
                        <div style={styles.reversibilityNote}>
                          This change affects only this product. You can undo it instantly if needed.
                        </div>
                        <div style={styles.previewActions}>
                          <button
                            style={{ ...styles.btnApprove, opacity: as?.applying ? 0.6 : 1 }}
                            onClick={e => handleSingleApply(item, e)}
                            disabled={as?.applying}
                          >
                            {as?.applying ? 'Applying…' : 'Apply this change'}
                          </button>
                          <button
                            style={styles.btnCancel}
                            onClick={e => { e.stopPropagation(); setPreviews(p => { const n = { ...p }; delete n[item.selectionKey]; return n; }); }}
                            disabled={as?.applying}
                          >
                            Cancel
                          </button>
                          {as?.error && <span style={{ color: '#dc2626', fontSize: 12 }}>{as.error}</span>}
                        </div>
                      </>
                    ) : (
                      <div style={{ color: '#dc2626', fontSize: 12 }}>Not available: {ps.data.blockReason}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  headingRow:       { display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 10 },
  heading:          { fontSize: 16, fontWeight: 600, margin: 0 },
  badge:            { background: '#dcfce7', color: '#166534', borderRadius: 12, padding: '1px 8px', fontSize: 12, fontWeight: 600, marginLeft: 8 },
  summary:          { fontSize: 13, color: '#6b7280' },
  controls:         { display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' },
  btnSecondary:     { fontSize: 12, padding: '4px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#374151' },
  btnPrimary:       { fontSize: 12, padding: '4px 14px', border: 'none', borderRadius: 6, background: '#16a34a', color: '#fff', cursor: 'pointer', fontWeight: 600, transition: 'opacity 0.15s' },
  btnPreview:       { fontSize: 11, padding: '3px 10px', border: '1px solid #d1d5db', borderRadius: 5, background: '#fff', cursor: 'pointer', color: '#374151', whiteSpace: 'nowrap' },
  btnPreviewActive: { background: '#eff6ff', borderColor: '#3b82f6', color: '#1d4ed8' },
  empty:            { color: '#9ca3af', fontSize: 14 },
  table:            { border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' },
  headerRow:        { display: 'grid', gridTemplateColumns: '32px 2fr 1fr 1fr 1fr 72px', gap: 8, padding: '8px 16px', background: '#f9fafb', fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' },
  row:              { display: 'grid', gridTemplateColumns: '32px 2fr 1fr 1fr 1fr 72px', gap: 8, padding: '10px 16px', borderTop: '1px solid #f3f4f6', fontSize: 13, alignItems: 'center', cursor: 'pointer' },
  titleCell:        { display: 'flex', flexDirection: 'column' as const, gap: 2 },
  productName:      { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  title:            { color: '#111827', fontWeight: 500 },
  issueWhy:         { fontSize: 11, color: '#9ca3af', lineHeight: 1.4 },
  pill:             { fontWeight: 600, fontSize: 12 },
  safetyBadge:      { fontSize: 12, color: '#16a34a' },
  statusBadge:      { fontSize: 12, color: '#6b7280' },
  statusReady:      { color: '#16a34a', fontWeight: 600 },
  previewPanel:       { padding: '12px 16px 14px 48px', background: '#f8fafc', borderTop: '1px solid #e5e7eb', fontSize: 12 },
  previewContext:     { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10, flexWrap: 'wrap' as const },
  previewContextText: { fontSize: 13, color: '#374151', fontWeight: 500 },
  previewDiffNote:    { fontSize: 11, color: '#9ca3af' },
  previewContent:     {},
  previewLabel:       { fontSize: 11, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase' as const, marginBottom: 4 },
  previewText:        { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, padding: '8px 12px', color: '#111827', lineHeight: 1.5, whiteSpace: 'pre-wrap' as const },
  reversibilityNote:  { fontSize: 11, color: '#6b7280', margin: '10px 0 6px', fontStyle: 'italic' as const },
  previewActions:     { display: 'flex', gap: 8, marginTop: 4, alignItems: 'center' },
  btnApprove:         { fontSize: 12, padding: '6px 16px', border: 'none', borderRadius: 6, background: '#16a34a', color: '#fff', cursor: 'pointer', fontWeight: 600 },
  btnCancel:          { fontSize: 12, padding: '5px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', cursor: 'pointer', color: '#374151' },
  successPanel:       { padding: '14px 16px 14px 48px', background: '#f0fdf4', borderTop: '1px solid #bbf7d0', display: 'flex', flexDirection: 'column' as const, gap: 4 },
  successMain:        { fontSize: 13, fontWeight: 600, color: '#15803d' },
  successSub:         { fontSize: 11, color: '#166534' },
  successFooter:      { display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 },
};
