'use strict';

// ---------------------------------------------------------------------------
// analyzeProduct
//
// Takes a single Prisma product (with variants and images included).
// Returns the standardized product CRO analysis object.
//
// Output shape:
// {
//   productId, title, status,
//   optimizationScore, scoreLabel, scoreDescription,
//   summary, totalIssues, criticalCount,
//   categories: { trust, valueClarity, friction, urgency, emotionalSelling, aov, consistency },
//   topIssues: Issue[],
//   quickWins: Issue[],
//   revenueOpportunities: Issue[],
//   missingData: MissingDataItem[]
// }
// ---------------------------------------------------------------------------

const { RULES }                          = require('./rules');
const { scoreProduct }                   = require('./scoring');
const { CATEGORIES, PRODUCT_MISSING_DATA } = require('./constants');

// ---------------------------------------------------------------------------
// runRules — evaluate all rules against the product, return issue objects
// ---------------------------------------------------------------------------
function runRules(product) {
  const issues = [];

  for (const rule of RULES) {
    try {
      const checkResult = rule.check(product);

      // tri-state: null = insufficient data → skip silently (not an issue, not clean)
      if (checkResult === null || checkResult === undefined) continue;

      // false = rule evaluated cleanly, no issue found
      // checkResult may also be a structured object with { triggered, ... }
      const triggered = (typeof checkResult === 'object')
        ? checkResult.triggered
        : checkResult;

      if (!triggered) continue;

      const built = rule.build(product);

      issues.push({
        issueId:              rule.id,
        triggered:            true,
        surface:              rule.surface  || 'pdp',
        title:                rule.title,
        severity:             rule.severity,
        category:             rule.category,
        impact:               rule.impact,
        effort:               rule.effort,
        confidence:           rule.confidence,
        implementationType:   rule.implementationType,
        scoreImpact:          built.scoreImpact  ?? null,
        evidence:             built.evidence     ?? [],
        recommendedFix:       built.recommendedFix ?? null,
        generatedFix:         built.generatedFix  ?? null,
        userHesitation:       built.userHesitation,
        psychologicalTrigger: built.psychologicalTrigger,
        whyItMatters:         built.whyItMatters,
        exactFix:             built.exactFix,
        businessImpact:       built.businessImpact,
        priorityBucket:       built.priorityBucket,
        productTypeNotes:     built.productTypeNotes,
      });
    } catch (_) {
      // A broken rule must never crash the analysis
    }
  }

  // Sort: critical first, then by category alpha for deterministic order
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) => {
    const sA = severityOrder[a.severity] ?? 9;
    const sB = severityOrder[b.severity] ?? 9;
    if (sA !== sB) return sA - sB;
    return a.category.localeCompare(b.category);
  });

  return issues;
}

// ---------------------------------------------------------------------------
// groupByCategory — populate the categories map
// ---------------------------------------------------------------------------
function groupByCategory(issues) {
  const cats = {};
  for (const key of Object.values(CATEGORIES)) {
    cats[key] = { issueCount: 0, issues: [] };
  }

  for (const issue of issues) {
    if (cats[issue.category]) {
      cats[issue.category].issues.push(issue);
      cats[issue.category].issueCount++;
    }
  }

  return cats;
}

// ---------------------------------------------------------------------------
// buildSummary — one-sentence text summary of the product's state
// ---------------------------------------------------------------------------
function buildSummary(product, issues, scoreResult) {
  const criticals = issues.filter(i => i.severity === 'critical');
  if (product.status === 'draft') {
    return `Draft product — not visible to customers. ${issues.length} issue(s) detected.`;
  }
  if (criticals.some(i => i.issueId === 'all_variants_oos')) {
    return `Out of stock on all variants — revenue is $0. ${issues.length} issue(s) to fix.`;
  }
  if (scoreResult.score < 20) {
    return `Critical state: ${criticals.length} blocker(s) preventing revenue. Immediate action needed.`;
  }
  if (scoreResult.score < 40) {
    return `Significant gaps across ${issues.length} area(s). Fixing these has high revenue impact.`;
  }
  if (scoreResult.score < 60) {
    return `Functional but under-optimized. ${issues.length} improvement(s) with clear revenue potential.`;
  }
  return `Well optimized. ${issues.length} minor refinement(s) available.`;
}

// ---------------------------------------------------------------------------
// analyzeProduct — main export
// ---------------------------------------------------------------------------
function analyzeProduct(product) {
  const issues      = runRules(product);
  const scoreResult = scoreProduct(issues);
  const categories  = groupByCategory(issues);

  const criticalBlockers     = issues.filter(i => i.severity === 'critical');
  const quickWins            = issues.filter(i => i.severity === 'medium' || i.severity === 'low');
  const revenueOpportunities = issues.filter(i => i.severity === 'high');

  return {
    productId:         product.id,
    shopifyProductId:  product.shopifyProductId,
    title:             product.title,
    status:            product.status,
    optimizationScore: scoreResult.score,
    scoreLabel:        scoreResult.label,
    scoreDescription:  scoreResult.description,
    summary:           buildSummary(product, issues, scoreResult),
    totalIssues:       issues.length,
    criticalCount:     criticalBlockers.length,
    categories,
    topIssues:         issues.slice(0, 5),
    criticalBlockers,
    quickWins,
    revenueOpportunities,
    missingData:       PRODUCT_MISSING_DATA,
  };
}

module.exports = { analyzeProduct };
