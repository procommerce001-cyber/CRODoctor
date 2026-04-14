'use client';

import { useEffect, useState } from 'react';
import { fetchStoreSuggestions, fetchSuggestionCandidates, applySelected } from '@/lib/api';
import type { StoreSuggestion, StoreSuggestionsPayload, SuggestionCandidatesPayload, SuggestionCandidate, ApplyResponse } from '@/lib/api';

const SHOP = process.env.NEXT_PUBLIC_SHOP ?? '';

const TYPE_STYLE: Record<StoreSuggestion['type'], { label: string; color: string; bg: string; border: string }> = {
  scale_winner:        { label: 'Scale winner',        color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' },
  mixed_pattern:       { label: 'Mixed pattern',       color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  pause_pattern:       { label: 'Pause pattern',       color: '#b91c1c', bg: '#fef2f2', border: '#fecaca' },
  insufficient_signal: { label: 'Insufficient signal', color: '#374151', bg: '#f9fafb', border: '#e5e7eb' },
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#b91c1c', high: '#d97706', medium: '#2563eb', low: '#6b7280',
};

type CandidateStatus = 'OPEN' | 'PARTIALLY_APPLIED' | 'FULLY_APPLIED' | 'BLOCKED' | 'NO_CANDIDATES' | null;

function deriveCandidateStatus(cands: SuggestionCandidatesPayload | undefined): CandidateStatus {
  if (!cands) return null;
  const ready   = cands.groups?.readyToApply?.length   ?? 0;
  const applied = cands.groups?.alreadyApplied?.length ?? 0;
  const blocked = cands.groups?.blocked?.length        ?? 0;
  const total   = ready + applied + blocked;
  if (total === 0)                            return 'NO_CANDIDATES';
  if (ready > 0  && applied === 0)            return 'OPEN';
  if (ready > 0  && applied > 0)              return 'PARTIALLY_APPLIED';
  if (ready === 0 && applied > 0)             return 'FULLY_APPLIED';
  if (ready === 0 && applied === 0 && blocked > 0) return 'BLOCKED';
  return null;
}

const STATUS_LABEL: Record<NonNullable<CandidateStatus>, string> = {
  OPEN:               'Open',
  PARTIALLY_APPLIED:  'Partially applied',
  FULLY_APPLIED:      'Fully applied',
  BLOCKED:            'Blocked',
  NO_CANDIDATES:      'No candidates',
};

const STATUS_BADGE: Record<NonNullable<CandidateStatus>, { color: string }> = {
  OPEN:              { color: '#6b7280' },
  PARTIALLY_APPLIED: { color: '#92400e' },
  FULLY_APPLIED:     { color: '#15803d' },
  BLOCKED:           { color: '#d97706' },
  NO_CANDIDATES:     { color: '#9ca3af' },
};

interface Props {
  onSelectMatches:         (keys: string[]) => void;
  onAppliedSelectionKeys:  (keys: string[]) => void;
}

export default function StoreSuggestionsList({ onSelectMatches, onAppliedSelectionKeys }: Props) {
  const [data,    setData]    = useState<StoreSuggestionsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  // per-issueId: candidate data, loading, error
  const [candidates,      setCandidates]      = useState<Record<string, SuggestionCandidatesPayload>>({});
  const [candidateLoading, setCandidateLoading] = useState<Record<string, boolean>>({});
  const [candidateError,   setCandidateError]   = useState<Record<string, string>>({});
  const [expanded,         setExpanded]          = useState<Record<string, boolean>>({});

  // per-issueId direct-apply state
  const [applying,      setApplying]      = useState<Record<string, boolean>>({});
  const [applyResult,   setApplyResult]   = useState<Record<string, ApplyResponse>>({});
  const [applyError,    setApplyError]    = useState<Record<string, string>>({});

  useEffect(() => {
    fetchStoreSuggestions(SHOP)
      .then(setData)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load suggestions'))
      .finally(() => setLoading(false));
  }, []);

  const handleViewCandidates = async (issueId: string) => {
    // Toggle off if already expanded
    if (expanded[issueId]) {
      setExpanded(prev => ({ ...prev, [issueId]: false }));
      return;
    }
    setExpanded(prev => ({ ...prev, [issueId]: true }));
    if (candidates[issueId]) return; // already fetched

    setCandidateLoading(prev => ({ ...prev, [issueId]: true }));
    setCandidateError(prev => ({ ...prev, [issueId]: '' }));
    try {
      const result = await fetchSuggestionCandidates(SHOP, issueId);
      setCandidates(prev => ({ ...prev, [issueId]: result }));
    } catch (err) {
      setCandidateError(prev => ({ ...prev, [issueId]: err instanceof Error ? err.message : 'Failed to load candidates' }));
    } finally {
      setCandidateLoading(prev => ({ ...prev, [issueId]: false }));
    }
  };

  const handleApplyReady = async (issueId: string) => {
    const cands = candidates[issueId];
    if (!cands?.groups?.readyToApply?.length) return;
    const keys = cands.groups.readyToApply.map(c => c.selectionKey);
    if (!keys.length) return;

    setApplying(prev   => ({ ...prev, [issueId]: true }));
    setApplyError(prev  => ({ ...prev, [issueId]: '' }));
    setApplyResult(prev => { const n = { ...prev }; delete n[issueId]; return n; });
    try {
      const result = await applySelected(SHOP, keys);
      setApplyResult(prev => ({ ...prev, [issueId]: result }));
      setCandidates(prev => { const n = { ...prev }; delete n[issueId]; return n; });
      onAppliedSelectionKeys(keys);
      // Re-fetch candidates immediately (section stays expanded)
      fetchSuggestionCandidates(SHOP, issueId)
        .then(fresh => setCandidates(prev => ({ ...prev, [issueId]: fresh })))
        .catch(() => {});
      // Re-fetch suggestions so outcome counts reflect new executions
      fetchStoreSuggestions(SHOP).then(setData).catch(() => {});
    } catch (err) {
      setApplyError(prev => ({ ...prev, [issueId]: err instanceof Error ? err.message : 'Apply failed' }));
    } finally {
      setApplying(prev => ({ ...prev, [issueId]: false }));
    }
  };

  return (
    <section>
      <h2 style={styles.heading}>Recommended Next Moves</h2>

      {loading && <p style={styles.muted}>Loading suggestions...</p>}
      {error   && <p style={styles.errorText}>{error}</p>}
      {!loading && !error && data && data.suggestions.length === 0 && (
        <p style={styles.muted}>No suggestions yet — more measured executions are needed.</p>
      )}

      {data && data.suggestions.length > 0 && (
        <div style={styles.list}>
          {data.suggestions.map(s => {
            const t      = TYPE_STYLE[s.type];
            const isOpen = !!expanded[s.issueId];
            const cands      = candidates[s.issueId];
            const cLoading   = candidateLoading[s.issueId];
            const cError     = candidateError[s.issueId];
            const isApplying      = applying[s.issueId];
            const aResult         = applyResult[s.issueId];
            const aError          = applyError[s.issueId];
            const candidateStatus = deriveCandidateStatus(cands);

            return (
              <div key={s.issueId} style={{ ...styles.card, background: t.bg, borderColor: t.border }}>
                {/* ── Suggestion row ── */}
                <div style={styles.cardTop}>
                  <span style={{ ...styles.badge, color: t.color, borderColor: t.border }}>{t.label}</span>
                  <span style={styles.issueId}>{s.issueId}</span>
                  {candidateStatus && (
                    <span style={{ ...styles.statusBadge, color: STATUS_BADGE[candidateStatus].color }}>
                      {STATUS_LABEL[candidateStatus]}
                    </span>
                  )}
                </div>
                <p style={styles.recommendation}>{s.recommendation}</p>
                <div style={styles.cardBottom}>
                  <div style={styles.counts}>
                    <span style={{ ...styles.count, color: '#15803d' }}>✓ {s.successCount}</span>
                    <span style={{ ...styles.count, color: '#6b7280' }}>– {s.neutralCount}</span>
                    <span style={{ ...styles.count, color: '#b91c1c' }}>✗ {s.negativeCount}</span>
                  </div>
                  <button style={styles.viewBtn} onClick={() => handleViewCandidates(s.issueId)}>
                    {isOpen ? 'Hide' : 'View matching products'}
                  </button>
                </div>

                {/* ── Expanded candidates ── */}
                {isOpen && (
                  <div style={styles.candidateSection}>
                    {cLoading && <p style={styles.muted}>Loading candidates...</p>}
                    {cError   && <p style={styles.errorText}>{cError}</p>}

                    {cands && (
                      <>
                        {/* Summary */}
                        <div style={styles.summaryRow}>
                          <SummaryPill label="Total"    value={cands.summary.candidateCount} />
                          <SummaryPill label="Ready"    value={cands.summary.readyToApplyCount}   color="#15803d" />
                          <SummaryPill label="Applied"  value={cands.summary.alreadyAppliedCount} color="#6b7280" />
                          <SummaryPill label="Blocked"  value={cands.summary.blockedCount}        color="#d97706" />
                        </div>

                        {/* Ready to apply */}
                        {cands.groups.readyToApply.length > 0 && (
                          <CandidateGroup
                            label="Ready to apply"
                            items={cands.groups.readyToApply}
                            labelColor="#15803d"
                          />
                        )}

                        {/* Already applied */}
                        {cands.groups.alreadyApplied.length > 0 && (
                          <CandidateGroup
                            label="Already applied"
                            items={cands.groups.alreadyApplied}
                            labelColor="#6b7280"
                          />
                        )}

                        {/* Blocked */}
                        {cands.groups.blocked.length > 0 && (
                          <CandidateGroup
                            label="Blocked"
                            items={cands.groups.blocked}
                            labelColor="#d97706"
                          />
                        )}

                        {/* Actions row — status-aware */}
                        {candidateStatus === 'FULLY_APPLIED' ? (
                          <p style={styles.completedNote}>All applicable products updated.</p>
                        ) : (cands.groups?.readyToApply?.length ?? 0) === 0 ? (
                          <p style={styles.muted}>No products ready to apply for this suggestion yet.</p>
                        ) : (
                          <div style={styles.actionsRow}>
                            <button
                              style={styles.selectBtn}
                              onClick={() => onSelectMatches(cands.groups.readyToApply.map(c => c.selectionKey))}
                            >
                              Select ready matches ({cands.groups.readyToApply.length})
                            </button>
                            <button
                              style={{ ...styles.applyBtn, ...(isApplying ? styles.applyBtnDisabled : {}) }}
                              disabled={isApplying}
                              onClick={() => handleApplyReady(s.issueId)}
                            >
                              {isApplying ? 'Applying…' : `Apply ready matches (${cands.groups.readyToApply.length})`}
                            </button>
                          </div>
                        )}

                        {/* Apply error */}
                        {aError && <p style={styles.applyError}>{aError}</p>}

                        {/* Apply result */}
                        {aResult && (
                          <div style={styles.applyResult}>
                            <span style={styles.applySuccessLine}>
                              Applied {aResult.appliedCount} match{aResult.appliedCount !== 1 ? 'es' : ''} successfully
                              {aResult.skippedCount > 0 && <span style={{ color: '#d97706' }}> · {aResult.skippedCount} skipped</span>}
                              {aResult.failedCount  > 0 && <span style={{ color: '#b91c1c' }}> · {aResult.failedCount} failed</span>}
                            </span>
                            {aResult.results.map(r => (
                              <div key={r.selectionKey} style={styles.applyResultRow}>
                                <span style={{ color: r.status === 'applied' ? '#15803d' : r.status === 'failed' ? '#b91c1c' : '#d97706', fontWeight: 600, minWidth: 52 }}>{r.status}</span>
                                <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#6b7280' }}>{r.selectionKey}</span>
                                {r.reason && <span style={{ fontSize: 11, color: '#9ca3af' }}>{r.reason}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                      </>
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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SummaryPill({ label, value, color = '#374151' }: { label: string; value: number; color?: string }) {
  return (
    <span style={{ fontSize: 12, color, fontWeight: 600 }}>
      {label}: {value}
    </span>
  );
}

function CandidateGroup({ label, items, labelColor }: { label: string; items: SuggestionCandidate[]; labelColor: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, color: labelColor, marginBottom: 6, letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
        {items.map(c => (
          <div key={c.selectionKey} style={candStyles.row}>
            <div style={candStyles.left}>
              <span style={candStyles.title}>{c.title}</span>
              <span style={candStyles.key}>{c.selectionKey}</span>
            </div>
            <div style={candStyles.right}>
              <span style={{ ...candStyles.severity, color: SEVERITY_COLOR[c.severity] ?? '#6b7280' }}>{c.severity}</span>
              <span style={candStyles.review}>{c.reviewStatus}</span>
              {c.reason && <span style={candStyles.reason}>{c.reason}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const candStyles: Record<string, React.CSSProperties> = {
  row:      { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '7px 10px', background: '#fff', borderRadius: 6, border: '1px solid #e5e7eb', gap: 8 },
  left:     { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 },
  right:    { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 },
  title:    { fontSize: 13, fontWeight: 600, color: '#111827', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  key:      { fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' },
  severity: { fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const },
  review:   { fontSize: 11, color: '#6b7280' },
  reason:   { fontSize: 11, color: '#d97706' },
};

const styles: Record<string, React.CSSProperties> = {
  heading:          { fontSize: 16, fontWeight: 600, marginBottom: 12 },
  muted:            { fontSize: 13, color: '#9ca3af' },
  errorText:        { fontSize: 13, color: '#dc2626' },
  list:             { display: 'flex', flexDirection: 'column', gap: 10 },
  card:             { padding: '14px 16px', borderRadius: 8, border: '1px solid', display: 'flex', flexDirection: 'column', gap: 8 },
  cardTop:          { display: 'flex', alignItems: 'center', gap: 10 },
  cardBottom:       { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  badge:            { fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em', padding: '2px 7px', border: '1px solid', borderRadius: 4 },
  issueId:          { fontSize: 12, color: '#6b7280', fontFamily: 'monospace' },
  statusBadge:      { fontSize: 11, fontWeight: 700, marginLeft: 'auto' },
  completedNote:    { fontSize: 13, color: '#15803d', fontStyle: 'italic', margin: 0 },
  recommendation:   { fontSize: 13, color: '#111827', margin: 0, lineHeight: 1.5 },
  counts:           { display: 'flex', gap: 12 },
  count:            { fontSize: 12, fontWeight: 600 },
  viewBtn:          { fontSize: 12, padding: '4px 10px', border: '1px solid #d1d5db', borderRadius: 5, background: '#fff', color: '#374151', cursor: 'pointer', flexShrink: 0 },
  candidateSection: { borderTop: '1px solid rgba(0,0,0,0.07)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 },
  summaryRow:       { display: 'flex', gap: 16, marginBottom: 4 },
  actionsRow:       { display: 'flex', gap: 8, flexWrap: 'wrap' as const },
  selectBtn:        { fontSize: 13, padding: '7px 14px', border: '1px solid #2563eb', borderRadius: 6, background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 600 },
  applyBtn:         { fontSize: 13, padding: '7px 14px', border: '1px solid #15803d', borderRadius: 6, background: '#f0fdf4', color: '#15803d', cursor: 'pointer', fontWeight: 600 },
  applyBtnDisabled: { opacity: 0.6, cursor: 'not-allowed' },
  applySuccessLine: { fontSize: 13, fontWeight: 600, color: '#15803d' },
  applyError:       { fontSize: 12, color: '#dc2626', margin: 0 },
  applyResult:      { fontSize: 13, display: 'flex', flexDirection: 'column' as const, gap: 4, padding: '10px 12px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6 },
  applyResultRow:   { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 },
};
