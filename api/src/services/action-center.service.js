'use strict';

// ---------------------------------------------------------------------------
// action-center.service.js
//
// Projection + persistence layer over the CRO engine.
// Responsibilities:
//   - Classify issues into actionable fix records
//   - Persist reviewer decisions (approve / reject / defer) via ActionItem model
//   - Merge stored review state into live engine output
//   - Group issues into store-level queue buckets
//   - Never write to Shopify. Never patch theme code.
// ---------------------------------------------------------------------------

const { analyzeProduct }      = require('./cro/analyzeProduct');
const { toCroProduct }        = require('./cro/formatters');
const { APPLY_TYPE_MAP }      = require('./cro/constants');
const { fetchOrderMetrics, updateProductDescription } = require('./shopify-admin.service');
const { classifyExecution }   = require('./cro/classifyExecution');
const { buildResultContent }  = require('./content-execution.service');

// ---------------------------------------------------------------------------
// V1_RULE_ALLOWLIST
//
// Only these issueIds surface in the v1 merchant-facing action center.
// All other rules run in the background for scoring but are not shown.
// To promote a rule to v1, add its id here — no other change required.
// ---------------------------------------------------------------------------
const V1_RULE_ALLOWLIST = new Set([
  'weak_desire_creation',   // primary content rule — full preview/apply path
  'no_description',         // highest confidence; trivially verifiable
  'description_too_short',  // objective threshold; clear merchant value
  'no_risk_reversal',       // high-confidence content gap; reversible
  'no_trust_bullets',       // additive reassurance block; merchant-safe; content_change only
  'no_social_proof',        // common, detectable; content-only fix
  'no_urgency',             // detectable gap; clear insertion opportunity
  'low_inventory_unused',   // high-confidence signal; content addition only
  'missing_alt_text',       // technical content; objective detection
  'no_size_guide',          // content addition; clear value
]);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_REVIEW_STATUSES = new Set(['pending', 'approved', 'rejected', 'deferred']);

// ---------------------------------------------------------------------------
// classifyFix — derive applyType, canAutoApply, humanReviewRequired
// ---------------------------------------------------------------------------
function classifyFix(issue) {
  const applyType = APPLY_TYPE_MAP[issue.implementationType] || 'manual';

  const hasGeneratedFix = !!(
    issue.generatedFix?.bestGuess?.content
  );

  // canAutoApply: content_change with a ready generated fix
  const canAutoApply = applyType === 'content_change' && hasGeneratedFix;

  // humanReviewRequired: always true until execution layer adds validation
  const humanReviewRequired = true;

  return { applyType, canAutoApply, humanReviewRequired };
}

// ---------------------------------------------------------------------------
// toActionItem — convert a CRO issue to an Action Center item
// reviewStatus defaults to 'pending'; caller merges persisted state over this.
// ---------------------------------------------------------------------------
function toActionItem(issue) {
  const { applyType, humanReviewRequired } = classifyFix(issue);
  const {
    canAutoApply,
    executionType,
    riskLevel,
    reason: classificationReason,
  } = classifyExecution({
    implementationType: issue.implementationType,
    confidence:         issue.confidence,
  });

  // ── Expert insight fields ─────────────────────────────────────────────────
  // Sourced from rule.build(). All rules produce these — map them into the
  // client-ready shape here so callers never need to know internal field names.

  const diagnosis = issue.userHesitation || issue.whyItMatters
    ? {
        headline:                issue.title,
        buyerThought:            issue.userHesitation        ?? null,
        gap:                     issue.whyItMatters          ?? null,
        psychologicalMechanism:  issue.psychologicalTrigger  ?? null,
      }
    : null;

  const fixDetail = issue.exactFix
    ? {
        action:     issue.exactFix.what        ?? null,
        format:     issue.exactFix.uiElement   ?? null,
        microcopy:  issue.exactFix.microcopy   ?? [],
        type:       issue.exactFix.type        ?? null,
        difficulty: issue.exactFix.difficulty  ?? null,
      }
    : null;

  const placement = issue.exactFix?.placement ?? null;

  const expectedImpact = issue.businessImpact
    ? {
        metric:         issue.businessImpact.metric         ?? null,
        magnitude:      issue.businessImpact.magnitude      ?? null,
        fixType:        issue.businessImpact.fixType        ?? null,
        reasoning:      issue.businessImpact.reasoning      ?? null,
        priorityBucket: issue.priorityBucket                ?? null,
      }
    : null;

  // Critical issues warrant business-level decision framing, not just UI fixes
  const businessDecision = issue.severity === 'critical'
    ? buildBusinessDecision(issue)
    : null;

  return {
    // ── Identity + workflow (used by execution layer) ────────────────────
    issueId:              issue.issueId,
    severity:             issue.severity,
    surface:              issue.surface    || 'pdp',
    category:             issue.category,
    effort:               issue.effort,
    confidence:           issue.confidence ?? null,
    scoreImpact:          issue.scoreImpact ?? null,
    // default — overridden by mergeReviewState() if a DB record exists
    reviewStatus:         'pending',
    selectedVariantIndex: null,
    canAutoApply,
    executionType,
    riskLevel,
    classificationReason,
    applyType,
    humanReviewRequired,

    // ── Expert insight (client-ready report fields) ───────────────────────
    diagnosis,
    fix:               fixDetail,
    placement,
    reasoning:         issue.businessImpact?.reasoning ?? null,
    expectedImpact,
    productTypeNotes:  issue.productTypeNotes ?? null,
    businessDecision,

    // ── Execution data (kept for content-execution layer) ────────────────
    evidence:        issue.evidence      || [],
    recommendedFix:  issue.recommendedFix ?? null,
    generatedFix:    issue.generatedFix   ?? null,
    // Normalised field — always present regardless of fix source.
    // Execution layer and UI should read this instead of generatedFix.bestGuess.content directly.
    proposedContent: issue.generatedFix?.bestGuess?.content ?? null,

    // ── Kept for display / backward compat ───────────────────────────────
    title:           issue.title,
  };
}

// ---------------------------------------------------------------------------
// buildBusinessDecision — for critical issues, surface the decision the
// merchant actually needs to make, not just a UI fix.
// ---------------------------------------------------------------------------
function buildBusinessDecision(issue) {
  const decisions = {
    all_variants_oos: {
      situation: 'Product is live and taking traffic but cannot be purchased.',
      options: [
        {
          option: 'Enable back-in-stock lead capture',
          when:   'You plan to restock within 4–8 weeks',
          how:    'Install Back in Stock – Restock Alerts. Replace the ATC button with an email capture form.',
          risk:   'Low',
        },
        {
          option: 'Set product to draft',
          when:   'Restock timeline is unknown or > 8 weeks',
          how:    'Shopify Admin → Products → Status → Draft. Stops wasting ad spend on unconvertible traffic.',
          risk:   'Low — stops revenue leak but removes organic visibility',
        },
        {
          option: 'Add a pre-order option',
          when:   'You have confirmed restock date and can commit to fulfilment',
          how:    'Use Pre-Order Now app or manual variant labelling. Set clear delivery expectations.',
          risk:   'Medium — requires fulfilment commitment; unmet dates damage brand',
        },
      ],
    },
    product_is_draft: {
      situation: 'Product exists in the database but is invisible to customers and search engines.',
      options: [
        {
          option: 'Publish immediately if product is complete',
          when:   'Images, description, pricing, and variants are all ready',
          how:    'Shopify Admin → Products → Status → Active. Run the CRO checklist first.',
          risk:   'Low',
        },
        {
          option: 'Complete and then publish within 48 hours',
          when:   'Product is mostly ready but missing key content (description, images)',
          how:    'Use the CRO issue list for this product as the completion checklist before going live.',
          risk:   'Low — a small delay to launch right is worth it',
        },
        {
          option: 'Delete if product is abandoned',
          when:   'Product will never be launched',
          how:    'Shopify Admin → Products → Delete. Removes catalog bloat and keeps inventory data clean.',
          risk:   'Irreversible — confirm before deleting',
        },
      ],
    },
    no_images: {
      situation: 'Product page has no images. Will not convert regardless of copy or pricing.',
      options: [
        {
          option: 'Source supplier images immediately',
          when:   'No photography budget — need to go live fast',
          how:    'Request high-res images from supplier. Use as temporary placeholder while arranging custom photography.',
          risk:   'Medium — supplier images often have watermarks or poor composition',
        },
        {
          option: 'Hire product photographer',
          when:   'Product is intended as a hero SKU',
          how:    'Budget £150–300 for a half-day product shoot. Returns via CVR improvement within weeks.',
          risk:   'Low — highest-ROI spend for a hero product',
        },
      ],
    },
  };

  return decisions[issue.issueId] ?? null;
}

// ---------------------------------------------------------------------------
// ISSUE_INTERACTIONS — known compounding combinations.
// When a product has multiple issues that interact, surface the connection
// explicitly so the merchant understands the compounded effect.
// ---------------------------------------------------------------------------
const ISSUE_INTERACTIONS = [
  {
    ids:        ['no_urgency', 'no_social_proof'],
    connection: 'No urgency + no social proof creates a hesitation loop. Without proof that others chose this product, the visitor has no reason to act now — and without urgency, delay feels costless. Together they explain why interested visitors still leave.',
    compoundedImpact: 'high',
  },
  {
    ids:        ['no_risk_reversal', 'no_social_proof'],
    connection: 'No guarantee + no reviews means the buyer carries 100% of financial and informational risk simultaneously. Neither trust signal is present. This combination is the primary conversion killer for cold traffic on unknown brands.',
    compoundedImpact: 'high',
  },
  {
    ids:        ['all_variants_oos', 'no_urgency'],
    connection: 'Out of stock with no lead capture means all purchase intent is permanently wasted. A visitor who cannot buy and is not captured leaves with no mechanism to return. These two issues together represent a complete revenue black hole.',
    compoundedImpact: 'critical',
  },
  {
    ids:        ['description_center_aligned', 'no_risk_reversal'],
    connection: 'Center-aligned supplier copy + no guarantee compounds trust damage. The visitor first suspects the content is generic, then confirms no accountability is offered. Trust collapses faster when both signals fail together.',
    compoundedImpact: 'high',
  },
  {
    ids:        ['no_social_proof', 'weak_desire_creation'],
    connection: 'No reviews + description that fails to create desire means nothing external validates interest and nothing internal generates desire. An unknown brand needs both to convert cold traffic.',
    compoundedImpact: 'high',
  },
  {
    ids:        ['strong_discount_not_featured', 'no_urgency'],
    connection: 'An invisible strong discount + no urgency is a double-waste: you have a compelling offer that isn\'t communicated, and no time pressure to act on it even if it were noticed. Fixing the discount display alone lifts CVR — pairing it with urgency multiplies the effect.',
    compoundedImpact: 'medium',
  },
  {
    ids:        ['no_risk_reversal', 'weak_desire_creation'],
    connection: 'Description that doesn\'t create desire + no guarantee means the visitor isn\'t pulled toward buying and isn\'t reassured if they hesitate. Two independent conversion barriers active at the same time.',
    compoundedImpact: 'high',
  },
];

// ---------------------------------------------------------------------------
// isActionable — any issue with expert intelligence is surfaced.
// All rules provide at least one of: exactFix, generatedFix, recommendedFix.
// ---------------------------------------------------------------------------
function isActionable(issue) {
  return !!(issue.exactFix || issue.generatedFix || issue.recommendedFix || issue.whyItMatters);
}

// ---------------------------------------------------------------------------
// detectInteractions — given the set of active issue IDs, return every known
// interaction pattern where ALL member issues are present.
// ---------------------------------------------------------------------------
function detectInteractions(activeIssueIds) {
  const idSet = new Set(activeIssueIds);
  return ISSUE_INTERACTIONS.filter(pattern =>
    pattern.ids.every(id => idSet.has(id))
  ).map(pattern => ({
    issueIds:         pattern.ids,
    connection:       pattern.connection,
    compoundedImpact: pattern.compoundedImpact,
  }));
}

// ---------------------------------------------------------------------------
// mergeReviewState
// Overlays persisted DB records onto a list of action items.
// Items with no DB record keep reviewStatus: 'pending'.
//
// stateMap: Map<issueId, { reviewStatus, selectedVariantIndex }>
// ---------------------------------------------------------------------------
function mergeReviewState(actionItems, stateMap) {
  return actionItems.map(item => {
    const stored = stateMap.get(item.issueId);
    if (!stored) return item;
    return {
      ...item,
      reviewStatus:         stored.reviewStatus,
      selectedVariantIndex: stored.selectedVariantIndex ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// loadReviewStateMap
// Fetches all ActionItem rows for a given (storeId, productId) from DB.
// Returns a Map<issueId, ActionItem> for O(1) lookup during merge.
// ---------------------------------------------------------------------------
async function loadReviewStateMap(prisma, storeId, productId) {
  const rows = await prisma.actionItem.findMany({
    where: { storeId, productId },
    select: { issueId: true, reviewStatus: true, selectedVariantIndex: true },
  });

  return new Map(rows.map(r => [r.issueId, r]));
}

// ---------------------------------------------------------------------------
// saveReviewState
// Upserts one ActionItem row. Validates status before writing.
// Returns the persisted record (public-safe shape).
// ---------------------------------------------------------------------------
async function saveReviewState(prisma, { storeId, productId, issueId, reviewStatus, selectedVariantIndex }) {
  if (!VALID_REVIEW_STATUSES.has(reviewStatus)) {
    throw new Error(`Invalid reviewStatus "${reviewStatus}". Must be one of: ${[...VALID_REVIEW_STATUSES].join(', ')}`);
  }

  const record = await prisma.actionItem.upsert({
    where: {
      storeId_productId_issueId: { storeId, productId, issueId },
    },
    update: {
      reviewStatus,
      selectedVariantIndex: selectedVariantIndex ?? null,
    },
    create: {
      storeId,
      productId,
      issueId,
      reviewStatus,
      selectedVariantIndex: selectedVariantIndex ?? null,
    },
  });

  return {
    id:                  record.id,
    productId:           record.productId,
    issueId:             record.issueId,
    reviewStatus:        record.reviewStatus,
    selectedVariantIndex: record.selectedVariantIndex,
    updatedAt:           record.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// getProductActions
// Runs the CRO engine on one product + merges persisted review state.
// Requires prisma + storeId to load state; both are optional for backwards
// compat (callers that don't pass them get reviewStatus: 'pending' on all).
// ---------------------------------------------------------------------------
async function getProductActions(rawProduct, { prisma, storeId } = {}) {
  const croProduct = toCroProduct(rawProduct);
  const analysis   = analyzeProduct(croProduct);

  const allIssues = [
    ...analysis.criticalBlockers,
    ...analysis.revenueOpportunities,
    ...analysis.quickWins,
  ];

  // De-duplicate across buckets
  const seen = new Set();
  const deduped = allIssues.filter(i => {
    if (seen.has(i.issueId)) return false;
    seen.add(i.issueId);
    return true;
  });

  const v1Issues = deduped.filter(i => V1_RULE_ALLOWLIST.has(i.issueId));
  let actionableItems = v1Issues.filter(isActionable).map(toActionItem);

  // Sort: critical → high → medium → low, effort asc within severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const effortOrder   = { low: 0, medium: 1, high: 2 };
  actionableItems.sort((a, b) => {
    const sA = severityOrder[a.severity] ?? 9;
    const sB = severityOrder[b.severity] ?? 9;
    if (sA !== sB) return sA - sB;
    return (effortOrder[a.effort] ?? 9) - (effortOrder[b.effort] ?? 9);
  });

  // Merge persisted state if DB is available
  if (prisma && storeId) {
    const stateMap   = await loadReviewStateMap(prisma, storeId, rawProduct.id);
    actionableItems  = mergeReviewState(actionableItems, stateMap);
  }

  // Surface compounding issue interactions so the client can explain
  // why multiple issues together are worse than each issue in isolation.
  const interactions = detectInteractions(actionableItems.map(i => i.issueId));

  return {
    productId:         analysis.productId,
    shopifyProductId:  analysis.shopifyProductId,
    title:             analysis.title,
    status:            analysis.status,
    optimizationScore: analysis.optimizationScore,
    scoreLabel:        analysis.scoreLabel,
    summary:           analysis.summary,
    totalIssues:       analysis.totalIssues,
    actionableCount:   actionableItems.length,
    actions:           actionableItems,
    issueInteractions: interactions,
    missingData:       analysis.missingData,
  };
}

// ---------------------------------------------------------------------------
// getReviewStateForProduct
// Returns the raw persisted state for a product — used by GET /review-state.
// Does NOT re-run the engine. Pure DB read.
// ---------------------------------------------------------------------------
async function getReviewStateForProduct(prisma, storeId, productId) {
  const rows = await prisma.actionItem.findMany({
    where:   { storeId, productId },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true, issueId: true, reviewStatus: true,
      selectedVariantIndex: true, updatedAt: true,
    },
  });

  return {
    productId,
    storeId,
    items: rows,
    total: rows.length,
  };
}

// ---------------------------------------------------------------------------
// QUEUE BUCKET CLASSIFIERS
// ---------------------------------------------------------------------------

const QUEUE_BUCKETS = {
  highest_revenue_opportunities: item =>
    item.severity === 'critical' || item.severity === 'high',

  fastest_wins: item =>
    item.effort === 'low',

  content_changes_ready: item =>
    item.applyType === 'content_change' && item.canAutoApply,

  manual_only: item =>
    item.applyType === 'manual',

  theme_changes: item =>
    item.applyType === 'theme_change',
};

// ---------------------------------------------------------------------------
// getStoreQueue
// Runs engine across all products, merges review state, returns queue.
// ---------------------------------------------------------------------------

// Processes items in serial batches of `concurrency` to limit simultaneous
// DB queries. Avoids bursting the connection pool when the product list is large.
async function runBatched(items, fn, concurrency = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = await Promise.all(items.slice(i, i + concurrency).map(fn));
    results.push(...batch);
  }
  return results;
}

async function getStoreQueue(shop, rawProducts, { prisma, storeId } = {}) {
  const productResults = (
    await runBatched(rawProducts, async p => {
      try {
        return await getProductActions(p, { prisma, storeId });
      } catch (_) {
        return null;
      }
    }, 5)
  ).filter(Boolean);

  const allItems = productResults.flatMap(pr =>
    pr.actions.map(item => ({
      ...item,
      _productId:    pr.productId,
      _productTitle: pr.title,
      _productScore: pr.optimizationScore,
    }))
  );

  const buckets = {};
  for (const [key, filterFn] of Object.entries(QUEUE_BUCKETS)) {
    buckets[key] = allItems
      .filter(filterFn)
      .map(item => ({
        issueId:      item.issueId,
        title:        item.title,
        severity:     item.severity,
        effort:       item.effort,
        applyType:    item.applyType,
        canAutoApply: item.canAutoApply,
        scoreImpact:  item.scoreImpact,
        reviewStatus: item.reviewStatus,
        productId:    item._productId,
        productTitle: item._productTitle,
        productScore: item._productScore,
      }));
  }

  const totalPending   = allItems.filter(i => i.reviewStatus === 'pending').length;
  const autoApplicable = allItems.filter(i => i.canAutoApply).length;
  const requiresHuman  = allItems.filter(i => i.humanReviewRequired && !i.canAutoApply).length;

  return {
    shop,
    generatedAt: new Date().toISOString(),
    summary: {
      totalProducts:       rawProducts.length,
      totalPendingActions: totalPending,
      autoApplicable,
      requiresHumanReview: requiresHuman,
      byBucket: Object.fromEntries(
        Object.entries(buckets).map(([k, v]) => [k, v.length])
      ),
    },
    queue: buckets,
    productScores: productResults
      .map(pr => ({
        productId:         pr.productId,
        title:             pr.title,
        status:            pr.status,
        optimizationScore: pr.optimizationScore,
        scoreLabel:        pr.scoreLabel,
        actionableCount:   pr.actionableCount,
      }))
      .sort((a, b) => a.optimizationScore - b.optimizationScore),
  };
}

// ===========================================================================
// CRO REPORT — business-grade, client-facing output
// Returns 3–5 strongest issues formatted for a non-technical business owner.
// Separate from the execution layer. Does not affect review state or applies.
// ===========================================================================

// ---------------------------------------------------------------------------
// REPORT_HEADLINES — sharp, emotional, client-facing headline per issue.
// Written for a business owner, not a developer.
// ---------------------------------------------------------------------------
const REPORT_HEADLINES = {
  all_variants_oos:            "Every visitor to this page today is leaving empty-handed — and most won't come back",
  product_is_draft:            "This product is invisible to your customers and generating £0 in revenue",
  no_risk_reversal:            "You're asking strangers to trust you with their money and offering nothing if they're disappointed",
  no_social_proof:             "93% of first-time buyers look for proof others purchased this first — your page offers none",
  no_urgency:                  "There's no cost to waiting, so visitors wait — and then forget",
  strong_discount_not_featured:"You have a compelling offer that goes completely unnoticed — it's free money being left on the table",
  weak_desire_creation:        "Your description tells shoppers what the product does. It never makes them feel what their life looks like after buying it.",
  description_center_aligned:  "This page looks copy-pasted from a supplier catalogue — experienced shoppers recognise it within seconds",
  missing_alt_text:            "Your product images are invisible to Google — organic traffic you'll never see",
  some_variants_oos:           "Sold-out variants look like failure when they should be proving that real people chose this",
  no_compare_price:            "Without a reference price, shoppers can't tell if they're getting a deal — so they go check Amazon",
  few_images:                  "Buyers can't commit to a product they can't fully visualise from every angle",
  low_inventory_unused:        "You have genuine scarcity data that could be driving urgency — and it's sitting unused",
  no_bundle_pricing:           "Every customer is buying the minimum. There's nothing in place to let them spend more.",
  no_description:              "There's nothing on this page that gives someone a reason to buy",
  description_too_short:       "Your description raises questions it doesn't answer — so visitors leave to find a page that does",
  weak_discount:               "A minimal discount doesn't drive purchase decisions — it just signals a sale that doesn't deliver",
  no_size_guide:               "Shoppers who can't confirm their size don't ask for help. They leave and buy somewhere that tells them.",
  no_images:                   "No images means no desire, no trust, and no purchase — this page cannot convert in its current state",
};


// ---------------------------------------------------------------------------
// ISSUE_DECISION_DATA — the 3 business questions per issue.
// betMoneyOnIt  : honest YES / MAYBE — would a CRO expert stake their fee on it?
// whyTop3       : why this is revenue-critical, not a nice-to-have
// ifWeSkip      : concrete consequence of inaction
// estimatedImpact: realistic range with benchmark source
// confidence    : how replicable this result is across stores
// whyItWorks    : the human psychology behind why this change converts
// ---------------------------------------------------------------------------
const ISSUE_DECISION_DATA = {
  all_variants_oos: {
    whatIsHappening: 'This page has live traffic and a dead purchase zone. The Add to Cart button does not exist. A visitor who found this product — through an ad, through search, through a recommendation — arrives ready to buy and hits a wall. No capture form, no pre-order, no "notify me when back." The page ends their purchase journey and sends them back to Google.',
    betMoneyOnIt:    'YES',
    whyTop3:         'If you fix only one thing today, fix this — because right now every visitor to this page is a warm lead you are paying to acquire and actively throwing away.',
    ifWeSkip:        'Assume 50 visitors per day — conservative for a live product with any ad spend. Without a capture form, that is 1,500 people per month who arrived ready to buy and left with nothing. At a 12% restock email conversion rate (Klaviyo 2023 benchmark), that is 180 missed sales per month sitting uncaptured. In 30 days without this fix, you will have permanently lost the contact details of your warmest audience. That list does not rebuild when you restock. You restock into cold traffic and wonder why the numbers are poor.',
    estimatedImpact: { metric: 'Revenue recovery', range: '10–15% of captured emails convert on restock (Klaviyo 2023 benchmark). Assumptions: 50 visitors/day, 20% email capture rate, 12% restock conversion.', basis: 'Klaviyo back-in-stock aggregate data across Shopify stores, 2023' },
    confidence:      { level: 'Very High', basis: 'Deterministic. This product converts at 0% today. Any capture mechanism creates revenue that currently cannot exist. There is no scenario where adding a restock form makes things worse.' },
    whyItWorks:      'These visitors have already cleared the hardest stage of the funnel — they found the product, they want it, they are stopped only by availability. Capturing that intent costs nothing per lead. Competitors with this in place are building a pre-sold list every week. You are sending those same buyers to them.',
  },
  no_risk_reversal: {
    whatIsHappening: 'There is no guarantee anywhere on this page — not in the description, not near the price, not below the Add to Cart button. A first-time visitor from a brand they have never purchased from faces the full financial risk of the transaction with no safety net visible. The rational response — the one that protects their money — is to not buy.',
    betMoneyOnIt:    'YES',
    whyTop3:         'If you fix only one thing today, fix this — every sale you are winning right now, you are winning despite the absence of a guarantee. Every sale you are not winning, this is frequently the reason.',
    ifWeSkip:        'A/B tests consistently show a 10–30% CVR lift from a visible guarantee. At the conservative end: if this page converts 10 in every 1,000 visitors, a 10% lift means 1 additional sale per 1,000 visitors. At £43 per order and 1,500 visitors per month, that is £64 per month recovered from five minutes of writing. In 30 days without it, you have given that revenue away to every visitor who needed a reason to trust you and found none. The drop-off is invisible — it just looks like normal bounce rate.',
    estimatedImpact: { metric: 'CVR', range: '+10–30%. Assumptions: 1,000–1,500 monthly visitors, current CVR ~1%, guarantee adds 10% relative lift minimum.', basis: 'Baymard Institute; ConversionXL; 200+ e-commerce A/B tests across product categories and price points' },
    confidence:      { level: 'Very High', basis: 'One of the most replicated findings in CRO research. The mechanism is consistent across product types, traffic sources, and price points. This is not a test — it is established practice.' },
    whyItWorks:      'Prospect theory (Kahneman & Tversky): the fear of losing £43 is 2.5× more powerful than the pleasure of gaining the product. A guarantee does not change your actual return rate — it shifts the buyer\'s perception of who carries the risk. Competitors who display a guarantee are not taking on more returns. They are using the same return policy you already have as a conversion tool. You are absorbing identical returns and showing nothing for it.',
  },
  no_social_proof: {
    betMoneyOnIt:    'YES',
    whyTop3:         'For a brand the visitor has never heard of, the absence of reviews is functionally equivalent to a red flag. Trust cannot be built from a seller\'s own words alone. You need a neutral third party — and there isn\'t one on this page.',
    ifWeSkip:        'Every new visitor has to make a leap of faith with no external validation. Competitors with reviews have a systematic advantage on every head-to-head comparison. The gap compounds as they collect more reviews and you collect none.',
    estimatedImpact: { metric: 'CVR', range: '+15–40% (moving from 0 to 10+ reviews)', basis: 'Spiegel Research Center, Northwestern University; Nielsen Trust Report 2023' },
    confidence:      { level: 'High', basis: 'Effect is strongest for unknown brands buying from first-time customers — exactly this situation. The research is extensive and the mechanism is well understood.' },
    whyItWorks:      'Humans are tribal. In the absence of personal experience, we use other people\'s choices as evidence of quality. A product with zero reviews forces the buyer to rely entirely on the seller\'s own claims — which are inherently suspected of bias. Reviews transfer credibility to a neutral third party. The buyer is no longer trusting you; they are trusting the 312 people who came before them.',
  },
  weak_desire_creation: {
    whatIsHappening: 'The description on this page reads as a product specification — temperatures, features, what is included, how it works. A visitor who arrived with genuine interest reads this content and is routed into comparison-shopping mode before a single desire signal fires. They are now evaluating the product, not wanting it. Evaluation favours whoever they recognise more. For a new brand, that comparison almost always loses.',
    betMoneyOnIt:    'YES',
    whyTop3:         'This product has a ready-to-use desire paragraph generated specifically for it — calibrated to this product type, this pain point, this buyer context. It can be pasted in today. No designer needed, no copywriter briefed, no strategy meeting required. The only reason not to act on this in the next 24 hours is deciding it can wait — and then watching the numbers to see whether you were right.',
    ifWeSkip:        'The description will continue to convert interested visitors into feature-comparers. Feature-comparers leave to check Amazon, Google, and the brand they already trust. At 1,500 visitors per month and a 1% CVR, that is 15 sales. An 8% relative CVR lift — the lower bound of the documented benchmark range — is 1.2 additional sales per month. At £43 per order, that is £52 sitting in an unedited product description. In 30 days, you will have had one clean opportunity to paste in a paragraph and not taken it. The description does not improve by itself.',
    estimatedImpact: { metric: 'CVR', range: '+8–20%', basis: 'StoryBrand framework outcomes; Copyhackers copy testing case studies; e-commerce description A/B tests' },
    confidence:      { level: 'Medium', basis: 'Effect size depends on copy execution quality. The generated paragraph is calibrated to this product — but a real-world test is the only proof. That is why this is #3 and not #1.' },
    whyItWorks:      'The brands winning on cold traffic are not winning on better products. They win on desire creation — descriptions that make the buyer feel the outcome before asking them to evaluate the features. A buyer in a desire state will rationalise a higher price, overlook minor trust gaps, and act before finishing their comparison. Your description does not create that state. If a competitor\'s does, they win the sale without a better product, a lower price, or more reviews. You are giving them that advantage for free.',
  },
  strong_discount_not_featured: {
    betMoneyOnIt:    'YES',
    whyTop3:         'The offer already exists. There is nothing to create, nothing to configure, no new strategy needed. Making a strong discount visible is the lowest-effort, highest-certainty revenue unlock on this list.',
    ifWeSkip:        'Visitors who would have been motivated by the saving will leave without noticing it. You are running a sale that nobody knows about. That is margin erosion with no CVR benefit.',
    estimatedImpact: { metric: 'CVR', range: '+8–15%', basis: 'Shopify store A/B tests: explicit savings badge vs. native strikethrough price only' },
    confidence:      { level: 'High', basis: 'Pure presentation change on an offer that already exists. The only variable is whether the visitor notices and mentally processes the saving. Making it explicit removes that variable.' },
    whyItWorks:      'Loss aversion, reframed: "You save £X" is not about gain — it is about avoiding loss. The brain processes "I will lose this £X saving if I do not act" more powerfully than it processes "I will gain this product." An explicit badge forces that calculation to happen. A strikethrough price requires mental arithmetic that most visitors will not do.',
  },
  no_urgency: {
    betMoneyOnIt:    'MAYBE',
    whyTop3:         'Status quo bias makes inaction the default. Without any cost to waiting, the overwhelming majority of interested visitors will leave to "think about it" — and statistically never return. Urgency is the mechanism that converts "interested" into "purchased today."',
    ifWeSkip:        'Visitors who are genuinely interested but not ready to commit right now will leave with good intentions and no mechanism to follow through. Studies consistently show 95%+ of visitors who leave without purchasing do not return. Interest without urgency is revenue that visits once and leaves forever.',
    estimatedImpact: { metric: 'CVR', range: '+10–20%', basis: 'Urgency app aggregate data; Bold Urgency and Hurrify conversion studies' },
    confidence:      { level: 'Medium', basis: 'Effect is real but implementation-dependent. Genuine scarcity (low stock, real restock date) significantly outperforms fabricated urgency. Fake countdown timers backfire with savvy shoppers.' },
    whyItWorks:      '"I\'ll think about it" is the most common exit thought on any product page — and it is almost never followed through. Urgency changes the decision frame from "optional" to "time-sensitive." The brain treats losses and gains asymmetrically: the cost of missing a time-limited opportunity feels more real than the benefit of acting on one. Urgency makes inaction feel expensive instead of safe.',
  },
  description_center_aligned: {
    betMoneyOnIt:    'MAYBE',
    whyTop3:         'Trust is assessed visually before a word is read. This is a quick fix that removes a trust-destroying signal affecting every visitor. Not the highest CVR lever, but it has the best effort-to-trust-recovery ratio on this list.',
    ifWeSkip:        'Experienced online shoppers — who are your most likely buyers — will pattern-match the formatting as supplier copy and mentally downgrade the brand before reading the first sentence. The rest of the page\'s trust signals have to work harder because of this one formatting choice.',
    estimatedImpact: { metric: 'CVR (via trust)', range: '+3–8%', basis: 'Usability testing and eye-tracking studies on formatting as a trust signal' },
    confidence:      { level: 'Medium', basis: 'Indirect effect — formatting restores trust, trust improves conversion. Hard to isolate in a clean A/B test, but consistently identified in conversion audits as a compounding negative.' },
    whyItWorks:      'Trust is evaluated in under 300 milliseconds on first glance — faster than conscious reading. Center-aligned body copy is the single most recognisable visual pattern of unedited supplier content. The moment trust breaks, visitor psychology shifts from "find reasons to buy" to "find reasons not to buy." Every subsequent trust signal has to overcome that initial suspicion.',
  },
  low_inventory_unused: {
    betMoneyOnIt:    'YES',
    whyTop3:         'You have real, data-backed scarcity and you are not using it. Displaying genuine low inventory is the most credible urgency trigger available — it cannot be faked and sophisticated shoppers know it.',
    ifWeSkip:        'Visitors assume unlimited availability. Unlimited availability means unlimited time to decide. That decision almost never gets made.',
    estimatedImpact: { metric: 'CVR', range: '+8–18% on products showing genuine low-stock', basis: 'Shopify merchants with live inventory counter vs. no display' },
    confidence:      { level: 'High', basis: 'Real scarcity is more credible than manufactured urgency. The stock number is verifiable and trusted even by skeptical shoppers.' },
    whyItWorks:      'Scarcity increases perceived value — what is rare is assumed to be desirable and worth having. When inventory is genuinely low, displaying it converts an operational fact into a purchase trigger. It is the only urgency mechanism that cannot be dismissed as a sales tactic, because the number is real.',
  },
  no_compare_price: {
    betMoneyOnIt:    'YES',
    whyTop3:         'Without an anchor, the price exists in a vacuum. The visitor\'s brain cannot answer "is this a good deal?" so it defaults to "I should check" — and they leave to check.',
    ifWeSkip:        'You are sending motivated visitors to Amazon and Google to answer a question you could have answered on your own page in five minutes. A percentage of them will not come back.',
    estimatedImpact: { metric: 'CVR', range: '+5–12%', basis: 'Price anchoring research (Ariely, Predictably Irrational); Shopify store A/B data' },
    confidence:      { level: 'High', basis: 'Anchoring is one of the most robust cognitive biases in purchasing decisions. The mechanism is deterministic and the fix is a single Shopify Admin field.' },
    whyItWorks:      'The first price a buyer sees sets their mental reference point for value. There is no "fair price" in the abstract — value is always relative. Without an anchor, buyers are forced to construct a reference point externally, which means leaving the page. A compare-at price answers "is this worth it?" before the visitor even asks the question.',
  },
};


// ---------------------------------------------------------------------------
// selectTopIssues — pick the 3–5 highest-priority issues for the report.
// Scoring: severity (weight) + effort bonus + bonus for generated copy.
// Avoids returning more than 5 issues regardless of how many exist.
// ---------------------------------------------------------------------------
function selectTopIssues(actions, max = 5) {
  const SEVERITY_SCORE = { critical: 100, high: 60, medium: 30, low: 10 };
  const EFFORT_BONUS   = { low: 20, medium: 5, high: -5 };

  return [...actions]
    .map(a => ({
      ...a,
      _score: (SEVERITY_SCORE[a.severity] || 0)
            + (EFFORT_BONUS[a.effort]     || 0)
            + (a.generatedFix             ? 10 : 0)
            + (a.scoreImpact !== null && a.scoreImpact <= -5 ? 8 : 0),
    }))
    .sort((a, b) => b._score - a._score)
    .slice(0, max);
}

// ---------------------------------------------------------------------------
// toReportIssue — format a single action item into the client-facing shape.
// Each field is written for a business owner, not a developer.
// ---------------------------------------------------------------------------
function toReportIssue(action, rank) {
  const headline  = REPORT_HEADLINES[action.issueId] || action.title;
  const decisions = ISSUE_DECISION_DATA[action.issueId] || {};

  // Use the per-issue override first; fall back to the buyer-thought template
  const buyerThought    = action.diagnosis?.buyerThought;
  const whatIsHappening = decisions.whatIsHappening
    || (buyerThought
        ? `When a visitor lands on this page, they are thinking: "${buyerThought}"`
        : action.diagnosis?.gap || null);

  // Microcopy: if the fix's microcopy array contains developer field references,
  // replace it with the actual generated copy variants from the engine.
  const rawMicrocopy = action.fix?.microcopy;
  let microcopy = null;
  if (rawMicrocopy?.length > 0) {
    const hasInternalRef = rawMicrocopy.some(m => typeof m === 'string' && m.includes('generatedFix'));
    if (hasInternalRef && action.generatedFix?.variants?.length > 0) {
      const built = action.generatedFix.variants.map(v => v.content).filter(Boolean);
      microcopy = built.length > 0 ? built : null;
    } else {
      microcopy = rawMicrocopy;
    }
  }

  return {
    rank,
    issueId:          action.issueId,
    severity:         action.severity,
    effort:           action.effort,
    headline,
    whatIsHappening,
    betMoneyOnIt:     decisions.betMoneyOnIt     ?? null,
    whyTop3:          decisions.whyTop3          ?? null,
    ifWeSkip:         decisions.ifWeSkip         ?? null,
    estimatedImpact:  decisions.estimatedImpact  ?? null,
    confidence:       decisions.confidence       ?? null,
    whyItWorks:       decisions.whyItWorks       ?? null,
    exactFix:         action.fix?.action         ?? null,
    exactPlacement:   action.placement           ?? null,
    microcopy,
    businessDecision: action.businessDecision    ?? null,
  };
}

// ---------------------------------------------------------------------------
// getProductReport
// Business-grade report for one product.
// Returns the 3–5 strongest issues formatted for a non-technical audience.
// Does not merge review state — this is a read-only analytical report.
// ---------------------------------------------------------------------------
async function getProductReport(rawProduct, _opts = {}) {
  const croProduct = toCroProduct(rawProduct);
  const analysis   = analyzeProduct(croProduct);

  // Collect all issues (same dedup logic as getProductActions)
  const allIssues = [
    ...analysis.criticalBlockers,
    ...analysis.revenueOpportunities,
    ...analysis.quickWins,
    ...analysis.topIssues,
  ];
  const seen = new Set();
  const deduped = allIssues.filter(i => {
    if (seen.has(i.issueId)) return false;
    seen.add(i.issueId);
    return true;
  });

  const actionItems = deduped.map(issue => toActionItem(issue));
  const top         = selectTopIssues(actionItems, 3);
  const interactions = detectInteractions(top.map(i => i.issueId));

  const reportIssues = top.map((action, idx) => toReportIssue(action, idx + 1));

  // Next single action: the highest-ranked issue's exact fix
  const topIssue = reportIssues[0];
  const nextAction = topIssue
    ? `${topIssue.headline} — ${topIssue.exactFix}`
    : null;

  return {
    productId:         analysis.productId,
    title:             analysis.title,
    optimizationScore: analysis.optimizationScore,
    scoreLabel:        analysis.scoreLabel,
    summary:           analysis.summary,
    reportGeneratedAt: new Date().toISOString(),
    topIssues:         reportIssues,
    issueInteractions: interactions,
    nextAction,
  };
}

// ---------------------------------------------------------------------------
// buildActionSummary — human-readable one-liner of what will change.
// Derived entirely from existing action item fields. No new logic.
// ---------------------------------------------------------------------------
function buildActionSummary(item) {
  const parts = [];
  if (item.fix?.action)     parts.push(item.fix.action);
  if (item.placement)       parts.push(`Placement: ${item.placement}`);
  if (item.fix?.difficulty) parts.push(`Difficulty: ${item.fix.difficulty}`);
  return parts.join(' — ') || item.title || item.issueId;
}

// ---------------------------------------------------------------------------
// buildContentChangePreview
// For content_change items only: resolves currentContent, proposedContent,
// and a human-readable diffSummary. All other applyTypes return null fields.
// rawProduct is the DB product row (bodyHtml is the only target field for
// all current CONTENT_CHANGE rules).
// ---------------------------------------------------------------------------
function buildContentChangePreview(item, rawProduct) {
  if (item.applyType !== 'content_change') {
    return { currentContent: null, proposedContent: null, diffSummary: null };
  }

  const currentContent  = rawProduct?.bodyHtml ?? null;
  const proposedContent = item.generatedFix?.bestGuess?.content ?? null;

  let diffSummary;
  if (!proposedContent) {
    diffSummary = 'No generated fix available yet — content cannot be previewed.';
  } else if (!currentContent || currentContent.trim().length === 0) {
    const words = proposedContent.split(/\s+/).filter(Boolean).length;
    diffSummary = `Description is empty. Proposed content (${words} words) will become the full body.`;
  } else {
    const currentWords  = currentContent.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
    const proposedWords = proposedContent.split(/\s+/).filter(Boolean).length;
    diffSummary = `Desire block (${proposedWords} words) will be inserted into existing description (${currentWords} words). Existing content is preserved.`;
  }

  return { currentContent, proposedContent, diffSummary };
}

// ---------------------------------------------------------------------------
// buildActionPreview
// Groups action items into autoApplicable / requiresReview buckets.
// Includes all classification fields + a human-readable changeSummary.
// For content_change items, adds currentContent, proposedContent, diffSummary.
// Does not apply anything. Pure projection over existing action items.
// ---------------------------------------------------------------------------
function buildActionPreview(actions, rawProduct) {
  const autoApplicable = [];
  const requiresReview = [];

  for (const item of actions) {
    const contentPreview = buildContentChangePreview(item, rawProduct);

    const entry = {
      issueId:              item.issueId,
      title:                item.title,
      severity:             item.severity,
      canAutoApply:         item.canAutoApply,
      executionType:        item.executionType,
      riskLevel:            item.riskLevel,
      classificationReason: item.classificationReason,
      applyType:            item.applyType,
      reviewStatus:         item.reviewStatus,
      changeSummary:        buildActionSummary(item),
      ...contentPreview,
    };

    if (item.canAutoApply) {
      autoApplicable.push(entry);
    } else {
      requiresReview.push(entry);
    }
  }

  return {
    autoApplicable,
    requiresReview,
    totals: {
      autoApplicable: autoApplicable.length,
      requiresReview: requiresReview.length,
      total:          actions.length,
    },
  };
}

// ---------------------------------------------------------------------------
// checkApplyGate
//
// Pure gate check for a single content_change action item.
// Does NOT run patch detection. Does NOT write anything.
// Returns a deterministic gated response.
//
// item      — action item from getProductActions (review state already merged)
// rawProduct — DB product row (for currentContent)
// ---------------------------------------------------------------------------
function checkApplyGate(item, rawProduct) {
  const meta = {
    issueId:       item.issueId,
    title:         item.title,
    severity:      item.severity,
    applyType:     item.applyType,
    canAutoApply:  item.canAutoApply,
    executionType: item.executionType,
    riskLevel:     item.riskLevel,
    reviewStatus:  item.reviewStatus,
  };

  if (item.applyType !== 'content_change') {
    return {
      eligibleToApply: false,
      blockReason:     `applyType is "${item.applyType}". Only content_change actions can be applied.`,
      currentContent:  null,
      proposedContent: null,
      meta,
    };
  }

  if (!item.canAutoApply) {
    return {
      eligibleToApply: false,
      blockReason:     'canAutoApply is false. Issue confidence is too low for automated execution.',
      currentContent:  null,
      proposedContent: null,
      meta,
    };
  }

  if (item.reviewStatus !== 'approved') {
    return {
      eligibleToApply: false,
      blockReason:     `reviewStatus is "${item.reviewStatus}". Action must be approved before it can be applied.`,
      currentContent:  null,
      proposedContent: null,
      meta,
    };
  }

  const currentContent  = rawProduct?.bodyHtml ?? null;
  const proposedContent = item.generatedFix?.bestGuess?.content ?? null;

  if (!proposedContent) {
    return {
      eligibleToApply: false,
      blockReason:     'No generated fix content available for this action.',
      currentContent,
      proposedContent: null,
      meta,
    };
  }

  return {
    eligibleToApply: true,
    blockReason:     null,
    currentContent,
    proposedContent,
    meta,
  };
}

// ---------------------------------------------------------------------------
// mergeProposedContent
// Builds the full resultContent by inserting proposedContent into the existing
// body. Inserts after the first closing </p> tag if one exists; otherwise
// prepends. Falls back to full replacement when body is empty.
// ---------------------------------------------------------------------------
function mergeProposedContent(currentContent, proposedContent) {
  const wrapped = `<p>${proposedContent}</p>`;
  if (!currentContent || currentContent.trim().length === 0) return wrapped;
  const idx = currentContent.indexOf('</p>');
  if (idx !== -1) {
    return currentContent.slice(0, idx + 4) + '\n' + wrapped + currentContent.slice(idx + 4);
  }
  return wrapped + '\n' + currentContent;
}

// ---------------------------------------------------------------------------
// applyContentChange
//
// Real execution for a single CONTENT_CHANGE action item.
// Flow:
//   1. Gate check via checkApplyGate — abort if not eligible
//   2. Build resultContent from current + proposed
//   3. Write to Shopify via updateProductDescription
//   4. On success: persist ContentExecution record + update local product
//   5. On Shopify failure: return error, do not persist
// ---------------------------------------------------------------------------
async function applyContentChange(prisma, store, rawProduct, actionItem) {
  // 1. Gate
  const gate = checkApplyGate(actionItem, rawProduct);
  if (!gate.eligibleToApply) {
    return { applied: false, blockReason: gate.blockReason };
  }

  const { currentContent, proposedContent } = gate;

  // 1b. Idempotency guard — skip if an active applied execution exists for this issue+product.
  // "Active" means applied and NOT subsequently rolled back. A rolled_back row referencing the
  // applied row means the apply has been undone and re-apply is legitimate.
  const existing = await prisma.contentExecution.findFirst({
    where: {
      productId: rawProduct.id,
      issueId:   actionItem.issueId,
      status:    'applied',
    },
  });
  if (existing) {
    const wasRolledBack = await prisma.contentExecution.findFirst({
      where: { referenceExecutionId: existing.id, status: 'rolled_back' },
    });
    if (!wasRolledBack) {
      return { applied: false, skipped: true, reason: 'already applied' };
    }
  }

  // 2. Build result using the same PATCH_MODE_REGISTRY pipeline as preview,
  //    so apply always produces exactly what the merchant previewed.
  let resultContent;
  try {
    resultContent = buildResultContent(actionItem.issueId, currentContent, proposedContent);
  } catch (err) {
    return { applied: false, error: `Patch failed: ${err.message}` };
  }

  // 3. Shopify write
  try {
    await updateProductDescription(store, rawProduct.shopifyProductId, resultContent);
  } catch (err) {
    return { applied: false, error: `Shopify write failed: ${err.message}` };
  }

  // 4a. Persist execution record
  const patchMode = (!currentContent || currentContent.trim().length === 0)
    ? 'replace_full_body'
    : 'insert_after_anchor';

  // afterReadyAt: the timestamp at which the 7-day after-window closes and
  // the after-snapshot can be captured. Exactly 7 days from now.
  const afterReadyAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  try {
    await prisma.contentExecution.create({
      data: {
        storeId:              store.id,
        productId:            rawProduct.id,
        issueId:              actionItem.issueId,
        selectedVariantIndex: 0,
        patchMode,
        anchorUsed:           patchMode === 'insert_after_anchor' ? '</p>' : null,
        matchedBlock:         null,
        previousContent:      currentContent,
        newContent:           proposedContent,
        resultContent,
        status:               'applied',
        afterReadyAt,
      },
    });
  } catch (err) {
    if (err.code === 'P2002') {
      return { applied: false, skipped: true, reason: 'already applied' };
    }
    throw err;
  }

  // 4b. Update local product
  await prisma.product.update({
    where: { id: rawProduct.id },
    data:  { bodyHtml: resultContent },
  });

  return {
    applied:          true,
    issueId:          actionItem.issueId,
    productId:        rawProduct.id,
    shopifyProductId: rawProduct.shopifyProductId,
    previousContent:  currentContent,
    appliedContent:   proposedContent,
  };
}

// ---------------------------------------------------------------------------
// rollbackContentChange
//
// Reverses a content_change apply for a single issue.
// Flow:
//   1. Find the latest 'applied' ContentExecution for (productId, issueId)
//   2. Safety check: current bodyHtml must match resultContent (no manual edits)
//   3. Idempotency: if a 'rolled_back' row already references this execution → skip
//   4. Write previousContent back to Shopify
//   5. Update Product.bodyHtml = previousContent
//   6. Persist a new ContentExecution row with status='rolled_back'
// ---------------------------------------------------------------------------
async function rollbackContentChange(prisma, store, rawProduct, issueId) {
  // 1. Find latest applied execution
  const execution = await prisma.contentExecution.findFirst({
    where:   { productId: rawProduct.id, issueId, status: 'applied' },
    orderBy: { createdAt: 'desc' },
  });

  if (!execution) {
    return { success: false, rolledBack: false, reason: 'no applied execution found' };
  }

  // 2. Idempotency first: if already rolled back, skip before any content checks.
  // Must come before the safety check because after a successful rollback
  // bodyHtml is the restored value, which intentionally differs from resultContent.
  const existingRollback = await prisma.contentExecution.findFirst({
    where: { referenceExecutionId: execution.id, status: 'rolled_back' },
  });
  if (existingRollback) {
    return {
      success:     false,
      rolledBack:  false,
      skipped:     true,
      reason:      'already rolled back',
      executionId: execution.id,
      timestamp:   existingRollback.createdAt.toISOString(),
    };
  }

  // 3. Safety: abort if content has been manually edited since apply
  const currentBodyHtml = rawProduct.bodyHtml ?? null;
  if (currentBodyHtml !== execution.resultContent) {
    return {
      success:     false,
      rolledBack:  false,
      reason:      'content changed since apply — manual edit detected, rollback aborted',
      executionId: execution.id,
    };
  }

  const previousContent = execution.previousContent ?? null;

  // 4. Write previousContent back to Shopify
  try {
    await updateProductDescription(store, rawProduct.shopifyProductId, previousContent ?? '');
  } catch (err) {
    return { success: false, rolledBack: false, reason: `Shopify write failed: ${err.message}` };
  }

  // 5. Update local product
  await prisma.product.update({
    where: { id: rawProduct.id },
    data:  { bodyHtml: previousContent },
  });

  // 6. Persist audit row + clear the partial unique index on the original applied row.
  // The index is (productId, issueId) WHERE status='applied'. Updating the original row
  // to 'superseded' removes it from that index so re-apply can succeed without manual cleanup.
  // History stays intact: the audit row's referenceExecutionId links back to the original.
  const [rollbackRow] = await prisma.$transaction([
    prisma.contentExecution.create({
      data: {
        storeId:              store.id,
        productId:            rawProduct.id,
        issueId,
        patchMode:            'rollback',
        previousContent:      execution.resultContent,
        newContent:           previousContent ?? '',
        resultContent:        previousContent,
        status:               'rolled_back',
        referenceExecutionId: execution.id,
      },
    }),
    prisma.contentExecution.update({
      where: { id: execution.id },
      data:  { status: 'superseded' },
    }),
  ]);

  return {
    success:     true,
    rolledBack:  true,
    executionId: execution.id,
    timestamp:   rollbackRow.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// buildBatchPreview
//
// Control-layer decision view over the product catalog.
// Groups all auto-applicable and review-required actions into three buckets,
// scores them deterministically, and marks each item as readyToApply.
//
// Groups:
//   high_impact  — severity=critical  AND canAutoApply=true
//   quick_wins   — severity=medium|low AND canAutoApply=true
//   needs_review — canAutoApply=false  OR riskLevel!=low  (everything else)
//
// Score: critical=100 | high=80 | medium=50 | low=20  (sorted DESC per group)
// readyToApply: canAutoApply=true AND reviewStatus=approved AND riskLevel=low
// ---------------------------------------------------------------------------
const SEVERITY_SCORE = { critical: 100, high: 80, medium: 50, low: 20 };

function toPreviewItem(item, productId) {
  return {
    productId,
    issueId:      item.issueId,
    title:        item.title,
    severity:     item.severity,
    canAutoApply: item.canAutoApply,
    riskLevel:    item.riskLevel,
    reviewStatus: item.reviewStatus,
    score:        SEVERITY_SCORE[item.severity] ?? 0,
    readyToApply: item.canAutoApply === true &&
                  item.reviewStatus === 'approved' &&
                  item.riskLevel    === 'low',
  };
}

async function buildBatchPreview(shop, rawProducts, { prisma, storeId } = {}) {
  const productResults = (
    await runBatched(rawProducts, async p => {
      try { return await getProductActions(p, { prisma, storeId }); }
      catch (_) { return null; }
    }, 5)
  ).filter(Boolean);

  const high_impact  = [];
  const quick_wins   = [];
  const needs_review = [];

  for (const pr of productResults) {
    for (const item of pr.actions) {
      const s = toPreviewItem(item, pr.productId);
      if (item.severity === 'critical' && item.canAutoApply) {
        high_impact.push(s);
      } else if ((item.severity === 'medium' || item.severity === 'low') && item.canAutoApply) {
        quick_wins.push(s);
      } else {
        needs_review.push(s);
      }
    }
  }

  const byScore = (a, b) => b.score - a.score;

  return {
    shop,
    generatedAt:  new Date().toISOString(),
    totalActions: high_impact.length + quick_wins.length + needs_review.length,
    groups: {
      high_impact:  high_impact.sort(byScore),
      quick_wins:   quick_wins.sort(byScore),
      needs_review: needs_review.sort(byScore),
    },
  };
}

module.exports = {
  getProductActions,
  getStoreQueue,
  saveReviewState,
  getReviewStateForProduct,
  getProductReport,
  buildActionPreview,
  checkApplyGate,
  applyContentChange,
  rollbackContentChange,
  buildBatchPreview,
};
