'use client';

import { useEffect, useState } from 'react';
import { fetchStoreSuggestionsWithStatus, fetchSuggestionCandidates, applySelected } from '@/lib/api';
import type { StoreSuggestion, SuggestionStatus, SuggestionCandidatesPayload, SuggestionCandidate, ApplyResponse } from '@/lib/api';

type SuggestionsWithStatusPayload = { suggestions: StoreSuggestion[] };

const SHOP = process.env.NEXT_PUBLIC_SHOP ?? '';

// ---------------------------------------------------------------------------
// Dev-only seed data — injected when the store has no real suggestions yet.
// Matches the StoreSuggestionsPayload shape exactly. Never used in production.
// ---------------------------------------------------------------------------
const SEED_SUGGESTIONS_DATA: SuggestionsWithStatusPayload = {
  suggestions: [
    {
      type: 'scale_winner',
      issueId: 'weak_desire_creation',
      recommendation:
        'Products with stronger desire-creation copy showed consistent revenue lift across 3 executions. Scale this pattern to the 2 remaining eligible products.',
      successCount: 3,
      neutralCount: 0,
      negativeCount: 0,
      status: 'PARTIALLY_APPLIED',
      candidateSummary: { candidateCount: 3, readyToApplyCount: 2, alreadyAppliedCount: 1, blockedCount: 0 },
    },
    {
      type: 'mixed_pattern',
      issueId: 'low_urgency_cta',
      recommendation:
        'Urgency-focused CTAs improved conversion on one product but showed no impact on another. Review individually before scaling further.',
      successCount: 1,
      neutralCount: 1,
      negativeCount: 0,
      status: 'OPEN',
      candidateSummary: { candidateCount: 2, readyToApplyCount: 1, alreadyAppliedCount: 0, blockedCount: 1 },
    },
    {
      type: 'pause_pattern',
      issueId: 'generic_feature_list',
      recommendation:
        'Generic feature-list descriptions correlated with a revenue decline on 2 products. Hold further rollout until copy is revised.',
      successCount: 0,
      neutralCount: 0,
      negativeCount: 2,
      status: 'BLOCKED',
      candidateSummary: { candidateCount: 2, readyToApplyCount: 0, alreadyAppliedCount: 0, blockedCount: 2 },
    },
    {
      type: 'insufficient_signal',
      issueId: 'social_proof_emphasis',
      recommendation:
        'Social proof variants have not yet accumulated enough measured executions to draw conclusions. Check back after 7 more orders.',
      successCount: 0,
      neutralCount: 0,
      negativeCount: 0,
      status: 'NO_CANDIDATES',
      candidateSummary: { candidateCount: 0, readyToApplyCount: 0, alreadyAppliedCount: 0, blockedCount: 0 },
    },
  ],
};

const TYPE_STYLE: Record<StoreSuggestion['type'], { label: string; color: string; bg: string; border: string }> = {
  scale_winner:        { label: 'Scale winner',        color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' },
  mixed_pattern:       { label: 'Mixed pattern',       color: '#92400e', bg: '#fffbeb', border: '#fde68a' },
  pause_pattern:       { label: 'Pause pattern',       color: '#b91c1c', bg: '#fef2f2', border: '#fecaca' },
  insufficient_signal: { label: 'Insufficient signal', color: '#374151', bg: '#f9fafb', border: '#e5e7eb' },
};

const SUGGESTION_STATUS_BADGE: Record<SuggestionStatus, { label: string; color: string }> = {
  OPEN:               { label: 'Open',               color: '#2563eb' },
  PARTIALLY_APPLIED:  { label: 'Partially applied',  color: '#d97706' },
  FULLY_APPLIED:      { label: 'Fully applied',       color: '#15803d' },
  BLOCKED:            { label: 'Blocked',             color: '#b91c1c' },
  NO_CANDIDATES:      { label: 'No candidates',       color: '#9ca3af' },
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#b91c1c', high: '#d97706', medium: '#2563eb', low: '#6b7280',
};

type CandidateStatus = 'OPEN' | 'PARTIALLY_APPLIED' | 'FULLY_APPLIED' | 'BLOCKED' | 'NO_CANDIDATES' | null;

export type FilterValue = 'ALL' | 'OPEN' | 'COMPLETED' | 'BLOCKED' | 'NO_CANDIDATES';

const STATUS_LABEL_MAP: Record<Exclude<FilterValue, 'ALL'>, string> = {
  OPEN:          'Open',
  COMPLETED:     'Completed',
  BLOCKED:       'Blocked',
  NO_CANDIDATES: 'No candidates',
};

const UI_GROUPS: { label: string; statuses: (SuggestionStatus)[] }[] = [
  { label: 'Open',          statuses: ['OPEN', 'PARTIALLY_APPLIED'] },
  { label: 'Completed',     statuses: ['FULLY_APPLIED'] },
  { label: 'Blocked',       statuses: ['BLOCKED'] },
  { label: 'No candidates', statuses: ['NO_CANDIDATES'] },
];

type GroupedSuggestion = { label: string; items: StoreSuggestion[] };

function groupSuggestions(suggestions: StoreSuggestion[]) {
  return UI_GROUPS.map(g => ({
    label: g.label,
    items: suggestions.filter(s => {
      const status = s.status ?? 'NO_CANDIDATES';
      return g.statuses.includes(status);
    }),
  })).filter(g => g.items.length > 0);
}

const GROUP_STATUSES: Record<'open' | 'completed' | 'blocked', SuggestionStatus[]> = {
  open:      ['OPEN', 'PARTIALLY_APPLIED'],
  completed: ['FULLY_APPLIED'],
  blocked:   ['BLOCKED'],
};

function getSuggestionCounts(grouped: GroupedSuggestion[]): { open: number; completed: number; blocked: number } {
  const count = (keys: SuggestionStatus[]) =>
    grouped.filter(g => g.items.some(s => keys.includes(s.status ?? 'NO_CANDIDATES')))
           .reduce((sum, g) => sum + g.items.filter(s => keys.includes(s.status ?? 'NO_CANDIDATES')).length, 0);
  return {
    open:      count(GROUP_STATUSES.open),
    completed: count(GROUP_STATUSES.completed),
    blocked:   count(GROUP_STATUSES.blocked),
  };
}

function getVisibleGroups(grouped: GroupedSuggestion[], activeFilter: FilterValue): GroupedSuggestion[] {
  if (activeFilter === 'ALL') return grouped;
  const label = STATUS_LABEL_MAP[activeFilter];
  return grouped.filter(g => g.label === label);
}

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

interface SuggestionCounts { open: number; completed: number; blocked: number }

interface Props {
  onSelectMatches:         (keys: string[]) => void;
  onAppliedSelectionKeys:  (keys: string[]) => void;
  onSuggestionCounts?:     (counts: SuggestionCounts) => void;
  activeFilter:            FilterValue;
  onFilterChange:          (f: FilterValue) => void;
}

export default function StoreSuggestionsList({ onSelectMatches, onAppliedSelectionKeys, onSuggestionCounts, activeFilter, onFilterChange }: Props) {
  const [data,     setData]     = useState<SuggestionsWithStatusPayload | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [isSeeded, setIsSeeded] = useState(false);

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
    fetchStoreSuggestionsWithStatus(SHOP)
      .then(r => {
        const payload = r as SuggestionsWithStatusPayload;
        if (process.env.NODE_ENV === 'development' && payload.suggestions.length === 0) {
          setData(SEED_SUGGESTIONS_DATA);
          setIsSeeded(true);
        } else {
          setData(payload);
        }
      })
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load suggestions'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!data || !onSuggestionCounts) return;
    onSuggestionCounts(getSuggestionCounts(groupSuggestions(data.suggestions)));
  }, [data]);

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
      fetchStoreSuggestionsWithStatus(SHOP).then(r => setData(r as SuggestionsWithStatusPayload)).catch(() => {});
    } catch (err) {
      setApplyError(prev => ({ ...prev, [issueId]: err instanceof Error ? err.message : 'Apply failed' }));
    } finally {
      setApplying(prev => ({ ...prev, [issueId]: false }));
    }
  };

  return (
    <section>
      <div style={styles.headingRow}>
        <h2 style={styles.heading}>Recommended Next Moves</h2>
        {isSeeded && <span style={styles.demoLabel}>Demo data</span>}
      </div>

      {loading && <p style={styles.muted}>Loading suggestions...</p>}
      {error   && <p style={styles.errorText}>{error}</p>}
      {!loading && !error && data && data.suggestions.length === 0 && (
        <p style={styles.muted}>No suggestions yet — more measured executions are needed.</p>
      )}

      {data && data.suggestions.length > 0 && (() => {
        const grouped = groupSuggestions(data.suggestions);
        const countFor = (label: string) => grouped.find(g => g.label === label)?.items.length ?? 0;
        const totalCount = grouped.reduce((sum, g) => sum + g.items.length, 0);
        const visibleGroups = getVisibleGroups(grouped, activeFilter);

        const CHIPS: { value: FilterValue; label: string; count: number }[] = [
          { value: 'ALL',           label: 'All',           count: totalCount },
          { value: 'OPEN',          label: STATUS_LABEL_MAP.OPEN,          count: countFor(STATUS_LABEL_MAP.OPEN) },
          { value: 'COMPLETED',     label: STATUS_LABEL_MAP.COMPLETED,     count: countFor(STATUS_LABEL_MAP.COMPLETED) },
          { value: 'BLOCKED',       label: STATUS_LABEL_MAP.BLOCKED,       count: countFor(STATUS_LABEL_MAP.BLOCKED) },
          { value: 'NO_CANDIDATES', label: STATUS_LABEL_MAP.NO_CANDIDATES, count: countFor(STATUS_LABEL_MAP.NO_CANDIDATES) },
        ];

        return (
        <div style={styles.groupsWrapper}>
          <div style={styles.chips}>
            {CHIPS.filter(c => c.value === 'ALL' || c.count > 0).map(c => (
              <button
                key={c.value}
                style={{ ...styles.chip, ...(activeFilter === c.value ? styles.chipActive : {}) }}
                onClick={() => onFilterChange(c.value)}
              >
                {c.label} ({c.count})
              </button>
            ))}
          </div>
          {visibleGroups.length === 0 && (
            <p style={styles.muted}>No suggestions in this category.</p>
          )}
          {visibleGroups.map(group => (
            <div key={group.label + '-' + group.items.length} style={styles.group}>
              <h3 style={styles.groupHeading}>{group.label} ({group.items.length})</h3>
              <div style={styles.list}>
                {group.items.map(s => {
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
                  {s.status && (
                    <span style={{ ...styles.statusBadge, color: SUGGESTION_STATUS_BADGE[s.status].color }}>
                      {SUGGESTION_STATUS_BADGE[s.status].label}
                    </span>
                  )}
                  {candidateStatus && (
                    <span style={{ ...styles.statusBadge, color: STATUS_BADGE[candidateStatus].color }}>
                      {STATUS_LABEL[candidateStatus]}
                    </span>
                  )}
                </div>
                <p style={styles.recommendation}>{s.recommendation}</p>
                {s.candidateSummary && (
                  <div style={styles.candidateCounts}>
                    <span>Total: {s.candidateSummary.candidateCount}</span>
                    <span style={{ color: '#15803d' }}>Ready: {s.candidateSummary.readyToApplyCount}</span>
                    <span style={{ color: '#6b7280' }}>Applied: {s.candidateSummary.alreadyAppliedCount}</span>
                    <span style={{ color: '#d97706' }}>Blocked: {s.candidateSummary.blockedCount}</span>
                  </div>
                )}
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
            </div>
          ))}
        </div>
        );
      })()}
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
  headingRow:       { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 },
  heading:          { fontSize: 16, fontWeight: 600, margin: 0 },
  demoLabel:        { fontSize: 11, fontWeight: 500, color: '#9ca3af', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 4, padding: '2px 7px', letterSpacing: '0.03em' },
  groupsWrapper:    { display: 'flex', flexDirection: 'column' as const, gap: 24 },
  chips:            { display: 'flex', flexWrap: 'wrap' as const, gap: 6 },
  chip:             { fontSize: 12, fontWeight: 500, padding: '4px 10px', borderRadius: 20, border: '1px solid #d1d5db', background: '#f9fafb', color: '#6b7280', cursor: 'pointer' },
  chipActive:       { background: '#111827', color: '#fff', borderColor: '#111827', fontWeight: 600 },
  group:            { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  groupHeading:     { fontSize: 13, fontWeight: 700, color: '#374151', margin: 0, textTransform: 'uppercase' as const, letterSpacing: '0.05em' },
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
  candidateCounts:  { display: 'flex', gap: 14, fontSize: 12, fontWeight: 600, color: '#374151' },
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
