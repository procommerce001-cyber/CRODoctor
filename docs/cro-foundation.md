# CRO Foundation — Architecture Reference

## Overview

The CRO engine analyzes synced Shopify product data and returns structured,
actionable revenue recommendations. It is a rule-based system grounded in
deterministic data — it does not guess, and it explicitly declares what it
cannot know from product data alone.

---

## Directory Structure

```
api/src/
├── routes/
│   └── cro.routes.js          — All CRO HTTP endpoints
└── services/
    ├── cro.service.js          — Legacy compat shim (re-exports from cro/)
    └── cro/
        ├── constants.js        — Enums: severity, impact, effort, confidence, score bands
        ├── rules.js            — 16 CRO rules (pure functions, no side effects)
        ├── scoring.js          — Deterministic 0–100 scoring from issue severity
        ├── analyzeProduct.js   — Single-product analysis → standardized object
        ├── analyzeStore.js     — Store-wide analysis → action plan object
        └── formatters.js       — Prisma → CRO model conversion + safe API serializers
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/cro/health` | Engine status, rules loaded count |
| GET | `/cro/products?shop=` | Summary CRO analysis for all products |
| GET | `/cro/products/:id` | Full CRO analysis for one product |
| GET | `/cro/priorities?shop=` | Top 10 issues across store, ranked by severity + effort |
| GET | `/cro/action-plan?shop=` | Full store-level action plan |

---

## Score Meaning

Scores run **0–100**. Higher = better optimized.

| Range | Label | Meaning |
|-------|-------|---------|
| 80–100 | Strong | Well optimized. Minor improvements available. |
| 60–79 | Good | Solid foundation. Clear revenue opportunities. |
| 40–59 | Needs Work | Significant gaps. Multiple fixable issues. |
| 20–39 | Weak | Major problems. High revenue impact if fixed. |
| 0–19 | Critical | Cannot generate meaningful revenue in current state. |

**Algorithm:** Start at 100. Deduct per issue severity:
- `critical` → −25
- `high` → −12
- `medium` → −5
- `low` → −2
- Floor at 0.

Priority products in `/cro/action-plan` are sorted **ascending** (score 0 first)
— lowest score = most urgent to fix.

---

## Issue Object Shape

```json
{
  "issueId": "no_risk_reversal",
  "title": "No guarantee or risk reversal — buyer carries 100% of the risk",
  "severity": "high",
  "category": "trust",
  "impact": ["conversion", "trust"],
  "effort": "low",
  "confidence": "high",
  "implementationType": "CONTENT_CHANGE",
  "whyItMatters": "...",
  "psychologicalReason": "...",
  "exactFix": {
    "what": "...",
    "where": "...",
    "copy": "...",
    "type": "copy",
    "difficulty": "easy"
  }
}
```

---

## Product Analysis Shape (`GET /cro/products/:id`)

```json
{
  "productId": "...",
  "shopifyProductId": "...",
  "title": "...",
  "status": "active | draft",
  "optimizationScore": 39,
  "scoreLabel": "Weak",
  "scoreDescription": "...",
  "summary": "One-sentence state description",
  "totalIssues": 6,
  "criticalCount": 1,
  "categories": {
    "trust": { "issueCount": 1, "issues": [...] },
    "valueClarity": { "issueCount": 1, "issues": [...] },
    "friction": { "issueCount": 1, "issues": [...] },
    "urgency": { "issueCount": 0, "issues": [] },
    "emotionalSelling": { "issueCount": 1, "issues": [...] },
    "aov": { "issueCount": 1, "issues": [...] },
    "consistency": { "issueCount": 1, "issues": [...] }
  },
  "topIssues": [ ...up to 5 issues... ],
  "criticalBlockers": [ ...severity=critical... ],
  "quickWins": [ ...severity=medium|low... ],
  "revenueOpportunities": [ ...severity=high... ],
  "missingData": [ ...items engine cannot determine from product data... ]
}
```

---

## Store Action Plan Shape (`GET /cro/action-plan`)

```json
{
  "shop": "...",
  "generatedAt": "ISO timestamp",
  "storeScore": { "score": 39, "label": "Weak", "description": "..." },
  "summary": {
    "totalProducts": 13,
    "activeProducts": 7,
    "draftProducts": 6,
    "totalIssues": 79,
    "criticalBlockers": 23,
    "quickWins": 27,
    "revenueOpportunities": 29
  },
  "criticalBlockers": [ ...Issue[] across all products... ],
  "quickWins": [ ...Issue[]... ],
  "revenueOpportunities": [ ...Issue[]... ],
  "priorityProducts": [ ...sorted ascending by score... ],
  "systemPatterns": [
    {
      "id": "all_active_products_oos",
      "title": "100% of active products are out of stock",
      "impact": "...",
      "urgency": "critical"
    }
  ],
  "missingData": [ ...store-level unknowns... ],
  "nextBestActions": [
    {
      "rank": 1,
      "title": "...",
      "why": "...",
      "implementationType": "APP_CONFIG",
      "effort": "low",
      "revenueImpact": "..."
    }
  ]
}
```

---

## Rule Categories

Every issue belongs to exactly one category:

| Category | Key | What It Covers |
|----------|-----|----------------|
| Trust | `trust` | Social proof, guarantees, images, risk reversal |
| Value Clarity | `valueClarity` | Pricing, discounts, offer strength, anchoring |
| Friction | `friction` | OOS, draft status, purchase blockers |
| Urgency | `urgency` | Scarcity, timers, stock counters |
| Emotional Selling | `emotionalSelling` | Description quality, copywriting, desire |
| AOV | `aov` | Bundles, volume pricing, upsells |
| Consistency | `consistency` | Alt text, formatting, brand naming |

---

## What the Engine Can and Cannot Know

### Can determine from synced Shopify data:
- Product status (active/draft)
- Variant availability and inventory counts
- Presence and length of description
- Description formatting issues (center-align)
- Presence of guarantee language in description
- Compare-at price and discount percentage
- Image count and alt text presence

### Cannot determine (declared in `missingData`):
- Whether a reviews app is installed
- Cart type (page cart vs slide cart)
- Checkout configuration or friction
- Actual conversion rate, ATC rate, cart abandonment rate
- Traffic source mix (cold vs warm)
- Mobile vs desktop split
- Whether urgency/scarcity apps are active
- Live page layout or theme structure

These are returned in `missingData[]` on every response so the consumer
knows exactly what confidence level to assign to each recommendation.

---

## What Is Intentionally Deferred to Action Center

The following are **not** part of the foundation and will be built in Phase 2:

- **Theme patching** — generating and applying Liquid/CSS patches to a draft theme
- **Content execution** — auto-applying description fixes via Shopify Products API
- **Snapshot and rollback** — capturing theme state before changes
- **Approval workflow** — merchant review before deploying to live theme
- **Experimentation layer** — A/B test setup and measurement
- **Analytics integration** — connecting real CVR/AOV data to close the missingData gaps
- **Dashboard/frontend** — UI for viewing and acting on recommendations

The execution layer scaffolding (`src/cro/execution/`) exists but is not
wired into any endpoint. It will be completed in the Action Center phase.

---

## Adding a New Rule

1. Open `src/services/cro/rules.js`
2. Add an entry to the `RULES` array following the existing schema
3. Assign `category`, `severity`, `impact`, `effort`, `confidence`, `implementationType`
4. Implement `check(product)` — must return boolean, never throw
5. Implement `build(product)` — must return `{ whyItMatters, psychologicalReason, exactFix }`
6. Run `curl /cro/health` to confirm `rulesLoaded` incremented
7. No other files need to change
