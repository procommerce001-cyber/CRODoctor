const _apiBase = process.env.NEXT_PUBLIC_API_BASE_URL;
if (!_apiBase) {
  throw new Error(
    '[api.ts] NEXT_PUBLIC_API_BASE_URL is not set. ' +
    'Copy web/.env.example → web/.env.local and fill in the values.'
  );
}
export const API_BASE = _apiBase;

const _devToken = process.env.NEXT_PUBLIC_DEV_BEARER_TOKEN;

export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  const auth: Record<string, string> = _devToken ? { Authorization: `Bearer ${_devToken}` } : {};
  return { ...auth, ...extra };
}

// All fetch calls must include credentials so the session cookie is sent.
export const apiFetchOptions: RequestInit = { credentials: 'include' };

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
  productTitle: string | null;
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
  productTitle: string | null;
  issueId: string;
  status: string;
  createdAt: string;
  resultStatus: string | null;
  insight: string | null;
  revenueChangePercent: number | null;
  unitsSoldChangePercent: number | null;
  ordersChangePercent: number | null;
  // 'high'|'medium'|'low'|'insufficient'|null — controls measured-lift display
  measurementConfidence: string | null;
  decisionSignal?: 'still_measuring' | 'keep' | 'revise' | 'rollback_candidate' | null;
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
    method:      'POST',
    credentials: 'include',
    headers:     apiHeaders({ 'Content-Type': 'application/json' }),
    body:        JSON.stringify({ shop, selection }),
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
    { cache: 'no-store', credentials: 'include', headers: apiHeaders() },
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
    { cache: 'no-store', credentials: 'include', headers: apiHeaders() },
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
    { cache: 'no-store', credentials: 'include', headers: apiHeaders() },
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

export interface ExposureFunnelGroup {
  atcSessions:      number;
  checkoutSessions: number;
  atcRate:          number | null;
  checkoutRate:     number | null;
}

export interface ExposureSummary {
  windowStart:              string;
  windowEnd:                string;
  pdpSessionCount:          number;
  exposedSessionCount:      number;
  unexposedPdpSessionCount: number;
  blockViewedCount:         number;
  exposureRate:             number | null;
  funnel: {
    exposed:   ExposureFunnelGroup;
    unexposed: ExposureFunnelGroup;
  } | null;
}

// Additive conversion-first decision object (backend commit 4d28082).
// Advisory only — never triggers actions. All fields may be null on thin data.
export interface DecisionV2 {
  measurementStatus:
    | 'not_started' | 'cooling_down' | 'measuring'
    | 'ready_for_decision' | 'inconclusive' | 'decided';
  recommendedAction:
    | 'continue_measuring' | 'keep' | 'undo_suggested'
    | 'try_alternative' | 'stack_next_change' | 'manual_review'
    | 'neutral_no_clear_lift' | 'measurement_expired';
  primaryMetric:         string | null;
  primaryMetricBefore:   number | null;
  primaryMetricAfter:    number | null;
  primaryMetricLift:     number | null;
  exposureLift:          number | null;
  revenuePerViewLift:    number | null;
  addToCartLift:         number | null;
  checkoutStartLift:     number | null;
  // Store-trend (DiD) adjusted partial-credit fields.
  rawLiftPercent?:              number | null;
  expectedBaselineLiftPercent?: number | null;
  adjustedLiftPercent?:         number | null;
  creditedLiftPercent?:         number | null;
  creditedRevenueImpact?:       number | null;
  creditedOrdersImpact?:        number | null;
  creditBand?:                  'not_creditable' | 'low' | 'medium' | 'strong';
  confidenceScore:       number | null;
  dataQualityScore:      number | null;
  downsideRiskScore:     number | null;
  attributionConfidence: number | null;
  expectedImpactScore:   number | null;
  confoundFlags:         string[];
  explanationForMerchant: string;
  internalReasonCodes:   string[];
  nextAllowedAction:     string[];
  canAutoUndoLater:      boolean;
  shouldNotTouchReason:  string | null;
  // Honest measurement interpretation (DATA #2B) — derived, additive, no schema.
  // Relabels the existing scores above as data sufficiency / quality / directional
  // signal so the UI never implies statistical proof. Optional for back-compat.
  measurementDataSufficiency?: 'insufficient' | 'directional' | 'moderate' | 'high_sufficiency';
  measurementDataQuality?:     'insufficient' | 'weak' | 'usable' | 'good';
  measurementSignalLabel?:     string;
  measurementDisclaimer?:      string;
  measurementEvidenceSource?:
    | 'decision_v2' | 'product_metrics_snapshot' | 'shopify_analytics'
    | 'first_party_events' | 'orders_only' | 'mixed' | 'unknown';
  measurementCaveats?:         string[];
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
  afterReadyAt:    string | null;
  resultStatus:    'measured' | 'waiting_for_more_data' | null;
  insight:         string | null;
  summary: {
    orders:    MetricStat;
    unitsSold: MetricStat;
    revenue:   MetricStat;
  } | null;
  confounds?: {
    detected: boolean;
    overlappingExecutions: Array<{
      executionId: string;
      issueId:     string;
      appliedAt:   string;
      status:      string;
    }>;
    warning?: string;
  };
  exposure?:       ExposureSummary | null;
  decisionSignal?: 'still_measuring' | 'keep' | 'revise' | 'rollback_candidate';
  decisionV2?:     DecisionV2 | null;
}

export async function fetchExecutionDetails(shop: string, executionId: string): Promise<ExecutionDetails> {
  const res = await fetch(
    `${API_BASE}/metrics/executions/${encodeURIComponent(executionId)}/details?shop=${encodeURIComponent(shop)}`,
    { cache: 'no-store', credentials: 'include', headers: apiHeaders() },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// fetchMe — server-component bootstrap helper.
// Calls GET /auth/me with a forwarded Cookie header (production session flow).
// Returns null on any failure so callers can fall back gracefully.
// ---------------------------------------------------------------------------
export async function fetchMe(cookieHeader?: string): Promise<{ shopDomain: string; storeId: string; userId: string | null } | null> {
  try {
    const headers: Record<string, string> = apiHeaders();
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    // credentials:'include' lets the browser attach the cross-site session
    // cookie when fetchMe runs client-side. Harmless no-op server-side, where
    // the forwarded Cookie header above carries the session instead.
    const res = await fetch(`${API_BASE}/auth/me`, { cache: 'no-store', credentials: 'include', headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// fetchOnboardingStatus — session-protected poll for the onboarding screen.
// Returns the coarse setupStatus enum (or null on any failure) so the client
// can poll for COMPLETED without an anon Supabase Realtime subscription.
export async function fetchOnboardingStatus(storeId?: string): Promise<{ setupStatus: string } | null> {
  try {
    const qs  = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
    const res = await fetch(`${API_BASE}/auth/onboarding-status${qs}`, {
      cache:       'no-store',
      credentials: 'include',
      headers:     apiHeaders(),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchDashboard(shop: string): Promise<DashboardPayload> {
  const res = await fetch(
    `${API_BASE}/dashboard/selection?shop=${encodeURIComponent(shop)}`,
    { cache: 'no-store', credentials: 'include', headers: apiHeaders() }
  );
  if (!res.ok) throw new Error(`Dashboard fetch failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Dashboard recommendation discovery — lightweight, LLM-free list of ALL
// recommendations across the catalog, grouped by status. Loaded lazily for the
// "View more recommendations" UI so the main dashboard stays fast.
// ---------------------------------------------------------------------------
export type RecommendationStatus =
  | 'ready_to_apply'
  | 'needs_review'
  | 'manual_setup'
  | 'measuring'
  | 'blocked';

export interface Recommendation {
  productId:    string;
  productTitle: string | null;
  issueId:      string;
  title:        string;
  category:     string | null;
  severity:     string | null;
  score:        number | null;
  applyType:    'content_change' | 'manual' | 'theme_change' | null;
  canAutoApply: boolean;
  riskLevel:    string | null;
  reviewStatus: string;
  manualSetup:  boolean;
  previewable:  boolean;
  selectable:   boolean;
  status:       RecommendationStatus;
  reason:       string | null;
  // Rollback metadata — populated for measuring (applied) content_change rows.
  executionId?:       string | null;
  afterReadyAt?:      string | null;
  rollbackAvailable?: boolean;
}

export interface RecommendationsPayload {
  success: boolean;
  shop:    string;
  summary: {
    total:        number;
    readyToApply: number;
    needsReview:  number;
    manualSetup:  number;
    measuring:    number;
    blocked:      number;
  };
  items: Recommendation[];
}

export async function fetchRecommendations(shop: string): Promise<RecommendationsPayload> {
  const res = await fetch(
    `${API_BASE}/dashboard/recommendations?shop=${encodeURIComponent(shop)}`,
    { cache: 'no-store', credentials: 'include', headers: apiHeaders() }
  );
  if (!res.ok) throw new Error(`Recommendations fetch failed: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Decision Engine — top actions
// ---------------------------------------------------------------------------

export interface TopAction {
  rank:                 number;
  actionKey:            string;
  productId:            string;
  productTitle:         string;
  issueId:              string;
  severity:             string;
  opportunityScore:     number;
  revenue:               number;
  estimatedImpactLabel:  string | null;
  quickWin:              boolean;
  expectedTimeToImpact:  string;
  earlySignalEligible:   boolean;
  whyNow:                string;
  recommendedAction:     string;
  executionStatus:       'pending' | 'completed';
  executedAt:            string | null;
  confidenceTier:        string | null;
  confidenceSampleSize:  number | null;
  openMeasurementWindow:        boolean;
  openMeasurementWindowReadyAt: string | null;
  applyType?:                   'content_change' | 'manual' | 'theme_change';
  readyToApply:                 boolean;
}

export async function fetchTopActions(shop: string): Promise<TopAction[]> {
  const res = await fetch(
    `${API_BASE}/decision-engine/top-actions?shop=${encodeURIComponent(shop)}`,
    { cache: 'no-store', credentials: 'include', headers: apiHeaders() }
  );
  if (!res.ok) return [];
  const data = await res.json();
  if (!data.success) return [];
  return (data.topActions as TopAction[]).map(a => ({
    ...a,
    actionKey: `${a.productId}::${a.issueId}`,
  }));
}

export interface EarlySignal {
  signal:            'positive' | 'collecting';
  orderCountChange:  number | null;
  revenueChange:     number | null;
  unitsSoldChange:   number | null;
}

export async function fetchEarlySignal(shop: string, productId: string): Promise<EarlySignal> {
  const res = await fetch(
    `${API_BASE}/decision-engine/early-signal?shop=${encodeURIComponent(shop)}&productId=${encodeURIComponent(productId)}`,
    { cache: 'no-store', credentials: 'include', headers: apiHeaders() }
  );
  if (!res.ok) return { signal: 'collecting', orderCountChange: null, revenueChange: null, unitsSoldChange: null };
  return res.json();
}

export async function executeAction(shop: string, actionKey: string): Promise<string> {
  const controller = new AbortController();
  // 150s covers the full LLM pipeline (30-120s) + Shopify write + response body read.
  // The timer stays armed through both fetch() and res.json() — cleared only in the outer finally.
  const timer = setTimeout(() => controller.abort(), 150_000);

  try {
    const res = await fetch(
      `${API_BASE}/decision-engine/actions/execute?shop=${encodeURIComponent(shop)}`,
      {
        method:      'POST',
        credentials: 'include',
        headers:     apiHeaders({ 'Content-Type': 'application/json' }),
        body:        JSON.stringify({ actionKey }),
        signal:      controller.signal,
      }
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Execute failed: ${res.status}`);
    }
    const data = await res.json();
    return data.executionId as string;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        'This is taking longer than expected. The change may still be applying — check back in a moment.'
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function rollbackAction(shop: string, productId: string, issueId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/action-center/products/${encodeURIComponent(productId)}/rollback`,
    {
      method:      'POST',
      credentials: 'include',
      headers:     apiHeaders({ 'Content-Type': 'application/json' }),
      body:        JSON.stringify({ shop, issueId }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Rollback failed: ${res.status}`);
  }
}

export interface ExecutionResult {
  status:  'measured' | 'waiting_for_more_data';
  insight: string | null;
  summary: {
    revenue:   { before: number; after: number; diff: number; changePercent: number | null };
    orders:    { before: number; after: number; diff: number; changePercent: number | null };
    unitsSold: { before: number; after: number; diff: number; changePercent: number | null };
  } | null;
}

export async function fetchExecutionResults(shop: string, executionId: string): Promise<ExecutionResult | null> {
  const res = await fetch(
    `${API_BASE}/metrics/executions/${encodeURIComponent(executionId)}/results?shop=${encodeURIComponent(shop)}`,
    { cache: 'no-store', credentials: 'include', headers: apiHeaders() }
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.success) return null;
  return { status: data.status, insight: data.insight, summary: data.summary ?? null };
}

// ---------------------------------------------------------------------------
// Issue labels — human-readable names for every known issueId
// ---------------------------------------------------------------------------

export const ISSUE_LABELS: Record<string, string> = {
  weak_desire_creation:        'Weak desire creation',
  features_before_desire:      'Features listed before desire',
  no_future_pacing:            'No future pacing',
  no_sensory_language:         'No sensory language',
  no_outcome_sentence:         'No outcome sentence',
  spec_pivot_early:            'Spec pivot too early',
  no_description:              'No product description',
  description_too_short:       'Description too short',
  description_center_aligned:  'Description center-aligned',
  no_risk_reversal:            'No risk reversal',
  no_social_proof:             'No social proof',
  no_urgency:                  'No urgency signals',
  no_compare_price:            'No compare price',
  weak_discount:               'Weak discount signal',
  strong_discount_not_featured:'Discount not featured',
  no_size_guide:               'Missing size guide',
  no_images:                   'No product images',
  few_images:                  'Too few images',
  missing_alt_text:            'Missing image alt text',
  no_bundle_pricing:           'No bundle pricing',
  low_inventory_unused:        'Low inventory signal unused',
  all_variants_oos:            'All variants out of stock',
  some_variants_oos:           'Some variants out of stock',
  product_is_draft:            'Product is in draft',
};

/** Returns a human-readable label for an issueId, falling back to a
 *  title-cased version of the raw id (e.g. "new_rule" → "New rule"). */
export function issueLabel(issueId: string): string {
  return ISSUE_LABELS[issueId] ?? issueId.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Review approval — persist the exact proposedContent the merchant reviewed.
// Non-fatal wrapper: callers should not block apply on a persistence failure.
// ---------------------------------------------------------------------------

export async function submitReviewApproval(
  shop: string,
  productId: string,
  issueId: string,
  proposedContent: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/action-center/review`, {
    method:      'POST',
    credentials: 'include',
    headers:     apiHeaders({ 'Content-Type': 'application/json' }),
    body:        JSON.stringify({ shop, productId, issueId, reviewStatus: 'approved', proposedContent }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Review approval failed: ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Content preview
// ---------------------------------------------------------------------------

export interface ContentPreview {
  productId:           string;
  issueId:             string;
  currentContent:      string | null;
  proposedContent:     string | null;
  selectedVariantIndex: number;
  patchMode:           string | null;
  anchorUsed:          string | null;
  patchSafety:         string | null;
  failureRisk:         string | null;
  diffSummary:         { operation: string; currentWords: number; proposedWords: number; note: string } | null;
  eligibleToApply:     boolean;
  blockReason:         string | null;
}

export async function fetchContentPreview(
  shop: string,
  productId: string,
  issueId: string,
  selectedVariantIndex = 0,
): Promise<ContentPreview> {
  const res = await fetch(
    `${API_BASE}/action-center/products/${encodeURIComponent(productId)}/content-preview`,
    {
      method:      'POST',
      credentials: 'include',
      headers:     apiHeaders({ 'Content-Type': 'application/json' }),
      body:        JSON.stringify({ shop, issueId, selectedVariantIndex }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Preview failed: ${res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Revenue Dashboard
// ---------------------------------------------------------------------------

export interface RecentImpact {
  productTitle:   string;
  revenueDelta:   number;
  ordersDelta:    number;
  unitsSoldDelta: number;
  executedAt:     string;
  roi:            number;
}

export interface RevenueDashboardData {
  empty:                  boolean;
  totalRevenueImpact:     number;
  revenueGrowthPercent:   number | null;
  ordersGrowthPercent:    number | null;
  unitsSoldGrowthPercent: number | null;
  aovChangePercent:       number | null;
  productsImproved:       number;
  executionsCount:        number;
  measuredCount:          number;
  insufficientDataCount:  number;
  avgRevenuePerExecution: number | null;
  recentImpacts:          RecentImpact[];
  topWins:                RecentImpact[];
}

// ---------------------------------------------------------------------------
// Attributed Revenue Summary
// ---------------------------------------------------------------------------

export interface AttributedRevenueData {
  windowDays:             number;
  windowStart:            string;
  windowEnd:              string;
  currency:               string | null;
  storeRevenue:           number;
  storeOrderCount:        number;
  improvedProductRevenue: number;
  improvedProductOrders:  number;
  improvedProductUnits:   number;
  unattributedRevenue:    number;
}

// ---------------------------------------------------------------------------
// Monthly Statement
// ---------------------------------------------------------------------------

export interface MonthlyStatementWin {
  productTitle:   string;
  revenueDelta:   number;
  ordersDelta:    number;
  unitsSoldDelta: number;
  executedAt:     string;
}

export interface MonthlyStatementData {
  windowDays:           number;
  windowStart:          string;
  windowEnd:            string;
  executionsCount:      number;
  measuredCount:        number;
  waitingCount:         number;
  insufficientDataCount: number;
  totalRevenueImpact:   number;
  productsImproved:     number;
  topWins:              MonthlyStatementWin[];
}

export async function fetchMonthlyStatement(shop: string): Promise<MonthlyStatementData | null> {
  try {
    const res = await fetch(
      `${API_BASE}/metrics/monthly-statement?shop=${encodeURIComponent(shop)}`,
      { cache: 'no-store', credentials: 'include', headers: apiHeaders() }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success) return null;
    return data as MonthlyStatementData;
  } catch {
    return null;
  }
}

export interface NewProductsDigestItem {
  id:               string;
  shopifyProductId: string;
  title:            string;
  createdAt:        string;
}

export interface NewProductsDigestData {
  windowDays: number;
  count:      number;
  products:   NewProductsDigestItem[];
}

export async function fetchNewProductsDigest(shop: string): Promise<NewProductsDigestData | null> {
  try {
    const res = await fetch(
      `${API_BASE}/metrics/new-products-digest?shop=${encodeURIComponent(shop)}`,
      { cache: 'no-store', credentials: 'include', headers: apiHeaders() }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success) return null;
    return data as NewProductsDigestData;
  } catch {
    return null;
  }
}

export interface MeasurementReadyDigestItem {
  executionId:     string;
  productId:       string;
  productTitle:    string | null;
  afterReadyAt:    string;
  decisionSignal:  string | null;
  confidence:      string | null;
  revenueDelta:    number | null;
  nextActionLabel: string;
}

export interface MeasurementReadyDigestData {
  windowDays: number;
  count:      number;
  items:      MeasurementReadyDigestItem[];
}

export async function fetchMeasurementReadyDigest(shop: string): Promise<MeasurementReadyDigestData | null> {
  try {
    const res = await fetch(
      `${API_BASE}/metrics/measurement-ready-digest?shop=${encodeURIComponent(shop)}`,
      { cache: 'no-store', credentials: 'include', headers: apiHeaders() }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success) return null;
    return data as MeasurementReadyDigestData;
  } catch {
    return null;
  }
}

export async function fetchAttributedRevenue(shop: string, windowDays = 30): Promise<AttributedRevenueData | null> {
  try {
    const res = await fetch(
      `${API_BASE}/metrics/store/attributed-revenue?shop=${encodeURIComponent(shop)}&windowDays=${windowDays}`,
      { cache: 'no-store', credentials: 'include', headers: apiHeaders() }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success) return null;
    return data as AttributedRevenueData;
  } catch {
    return null;
  }
}

export async function fetchRevenueDashboard(shop: string): Promise<RevenueDashboardData | null> {
  const res = await fetch(
    `${API_BASE}/metrics/revenue-dashboard?shop=${encodeURIComponent(shop)}`,
    { cache: 'no-store', credentials: 'include', headers: apiHeaders() }
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.success) return null;
  return data as RevenueDashboardData;
}
