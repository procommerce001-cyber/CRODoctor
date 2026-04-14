const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';

// ---------------------------------------------------------------------------
// Types — mirror the GET /dashboard/selection response shape exactly
// ---------------------------------------------------------------------------

export interface DashboardOverview {
  totalAppliedExecutions: number;
  measuredExecutions: number;
  waitingExecutions: number;
  revenueUpCount: number;
  revenueDownCount: number;
  unitsSoldUpCount: number;
  ordersUpCount: number;
}

export interface ReviewItem {
  productId: string;
  issueId: string;
  title: string;
  selectionKey: string;
  selectable: boolean;
  severity: string;
  score: number | null;
  riskLevel: string;
  reviewStatus: string;
  eligible: boolean;
  canAutoApply: boolean;
  wouldApply: boolean;
  reason: string | null;
  executionType: string | null;
  applyType: string | null;
}

export interface ReviewGroups {
  readyToApply: ReviewItem[];
  alreadyApplied: ReviewItem[];
  blocked: ReviewItem[];
}

export interface ReviewPayload {
  summary: {
    requestedProductCount: number;
    actionCount: number;
    readyToApplyCount: number;
    alreadyAppliedCount: number;
    blockedCount: number;
  };
  filters: {
    severity: string[];
    riskLevel: string[];
    reviewStatus: string[];
  };
  groups: ReviewGroups;
}

export interface TopWin {
  executionId: string;
  productId: string;
  issueId: string;
  revenueChangePercent: number | null;
  unitsSoldChangePercent: number | null;
  ordersChangePercent: number | null;
}

export interface ActivityItem {
  executionId: string;
  productId: string;
  issueId: string;
  status: string;
  createdAt: string;
  resultStatus: string | null;
  insight: string | null;
  revenueChangePercent: number | null;
  unitsSoldChangePercent: number | null;
  ordersChangePercent: number | null;
}

export interface DashboardPayload {
  success: boolean;
  shop: string;
  overview: DashboardOverview;
  review: ReviewPayload;
  topWins: TopWin[];
  recentActivity: ActivityItem[];
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// batch-apply-selected types + helper
// ---------------------------------------------------------------------------

export interface ApplyResultItem {
  selectionKey: string;
  productId: string;
  issueId: string;
  status: 'applied' | 'skipped' | 'failed';
  reason: string | null;
  executionId: string | null;
}

export interface ApplyResponse {
  mode: string;
  requestedSelectionCount: number;
  resultCount: number;
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  results: ApplyResultItem[];
}

export async function applySelected(shop: string, selection: string[]): Promise<ApplyResponse> {
  const res = await fetch(`${API_BASE}/action-center/batch-apply-selected`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ shop, selection }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Store CRO suggestions
// ---------------------------------------------------------------------------

export type SuggestionStatus = 'OPEN' | 'PARTIALLY_APPLIED' | 'FULLY_APPLIED' | 'BLOCKED' | 'NO_CANDIDATES';

export interface StoreSuggestion {
  type:           'scale_winner' | 'mixed_pattern' | 'pause_pattern' | 'insufficient_signal';
  issueId:        string;
  successCount:   number;
  neutralCount:   number;
  negativeCount:  number;
  recommendation: string;
  status?:        SuggestionStatus;
  candidateSummary?: {
    candidateCount:      number;
    readyToApplyCount:   number;
    alreadyAppliedCount: number;
    blockedCount:        number;
  };
}

export interface StoreSuggestionsPayload {
  success:  boolean;
  shop:     string;
  summary: {
    measuredExecutions:   number;
    successfulExecutions: number;
    neutralExecutions:    number;
    negativeExecutions:   number;
  };
  suggestions: StoreSuggestion[];
}

export interface SuggestionCandidate {
  productId:    string;
  issueId:      string;
  title:        string;
  selectionKey: string;
  selectable:   boolean;
  severity:     string;
  score:        number | null;
  riskLevel:    string;
  reviewStatus: string;
  eligible:     boolean;
  reason:       string | null;
}

export interface SuggestionCandidatesPayload {
  success:  boolean;
  shop:     string;
  issueId:  string;
  summary: {
    candidateCount:      number;
    readyToApplyCount:   number;
    alreadyAppliedCount: number;
    blockedCount:        number;
  };
  groups: {
    readyToApply:   SuggestionCandidate[];
    alreadyApplied: SuggestionCandidate[];
    blocked:        SuggestionCandidate[];
  };
}

export async function fetchSuggestionCandidates(shop: string, issueId: string): Promise<SuggestionCandidatesPayload> {
  const res = await fetch(
    `${API_BASE}/metrics/store/suggestions/${encodeURIComponent(issueId)}/candidates?shop=${encodeURIComponent(shop)}`,
    { cache: 'no-store' },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchStoreSuggestions(shop: string): Promise<StoreSuggestionsPayload> {
  const res = await fetch(
    `${API_BASE}/metrics/store/suggestions-status?shop=${encodeURIComponent(shop)}`,
    { cache: 'no-store' },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchStoreSuggestionsWithStatus(shop: string): Promise<unknown> {
  const res = await fetch(
    `${API_BASE}/metrics/store/suggestions-status?shop=${encodeURIComponent(shop)}`,
    { cache: 'no-store' },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Execution details
// ---------------------------------------------------------------------------

export interface MetricStat {
  before:        number;
  after:         number;
  diff:          number;
  changePercent: number | null;
}

export interface ExecutionDetails {
  success:         boolean;
  executionId:     string;
  productId:       string;
  issueId:         string;
  status:          string;
  createdAt:       string;
  previousContent: string | null;
  appliedContent:  string;
  resultStatus:    'measured' | 'waiting_for_more_data' | null;
  insight:         string | null;
  summary: {
    orders:    MetricStat;
    unitsSold: MetricStat;
    revenue:   MetricStat;
  } | null;
}

export async function fetchExecutionDetails(shop: string, executionId: string): Promise<ExecutionDetails> {
  const res = await fetch(
    `${API_BASE}/metrics/executions/${encodeURIComponent(executionId)}/details?shop=${encodeURIComponent(shop)}`,
    { cache: 'no-store' },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchDashboard(shop: string): Promise<DashboardPayload> {
  const res = await fetch(
    `${API_BASE}/dashboard/selection?shop=${encodeURIComponent(shop)}`,
    { cache: 'no-store' }
  );
  if (!res.ok) throw new Error(`Dashboard fetch failed: ${res.status}`);
  return res.json();
}
