'use strict';

// ---------------------------------------------------------------------------
// content-safety-validator.js
//
// Pre-Apply content safety gate. Runs inside applyContentChange, after all
// existing eligibility/gate checks pass, before any Shopify write or DB write.
//
// Contract:
//   validateContentSafety(context, prisma?) → Promise<ValidationResult>
//
// ValidationResult:
//   { safe: true }
//   { safe: false, reason: string, code: string }
//
// All failures return a merchant-safe reason string that never exposes internal
// details (no Prisma errors, no stack traces, no LLM internals).
//
// Failure is fast-fail: checks run in priority order and the first failure
// returns immediately. If the validator itself throws, it logs and returns
// safe:true — a validator bug must never block legitimate applies.
//
// Checks (in order):
//   1. HTML safety          — blocks script/iframe/event-handler injection
//   2. Duplicate CRO block  — blocks re-insertion of the same change
//   3. Cross-product guard  — blocks content mentioning another product's name
//   4. Unsupported claims   — blocks invented guarantees/refund-windows
//   5. Language consistency — blocks Hebrew↔Latin mismatches
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// STOPWORDS
//
// Words excluded from "distinctive product identifier" detection.
// Task-specified list (must not block): back, health, product, power, smart,
// support, team, magnetic, wireless, home.
// Extended with common English/product-copy words to suppress false positives.
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  // Task-specified — explicitly must not block these
  'back', 'health', 'product', 'power', 'smart', 'support', 'team',
  'magnetic', 'wireless', 'home',
  // Common English conjunctions / prepositions / pronouns
  'that', 'this', 'with', 'from', 'your', 'their', 'have', 'will',
  'been', 'also', 'more', 'very', 'just', 'into', 'over', 'when',
  'what', 'where', 'here', 'they', 'them', 'some', 'only', 'each',
  // Common product adjectives
  'best', 'good', 'easy', 'fast', 'safe', 'long', 'wide', 'slim',
  'soft', 'hard', 'full', 'high', 'small', 'light', 'thin', 'thick',
  'mini', 'plus', 'zero', 'pure', 'real', 'true', 'flat',
  // Common product nouns
  'size', 'type', 'pack', 'case', 'band', 'ring', 'clip', 'hook',
  'lock', 'cord', 'wire', 'tube', 'wrap', 'strap', 'unit', 'base',
  'core', 'sets', 'inch', 'feet', 'piece', 'combo',
  // Common action words in product copy
  'help', 'work', 'make', 'keep', 'feel', 'look', 'move', 'stay',
  'care', 'need', 'want', 'love', 'hold', 'wear', 'free', 'give',
  'show', 'know', 'find', 'save', 'stop', 'lose', 'does', 'gets',
  // Body / wellness terms
  'body', 'skin', 'face', 'foot', 'hand', 'hair', 'pain', 'rest',
  'sleep', 'muscle', 'joint', 'nerve',
  // Home / room terms
  'room', 'desk', 'door', 'wall', 'floor', 'shelf', 'table', 'chair',
  // Colour terms
  'white', 'black', 'blue', 'gold', 'pink', 'gray', 'dark', 'clear',
  // Measurement / quantity
  'multi', 'dual', 'anti', 'ultra', 'mega', 'nano', 'micro',
]);

// ---------------------------------------------------------------------------
// Unsafe HTML patterns
// ---------------------------------------------------------------------------
const UNSAFE_TAG_PATTERN      = /<(script|iframe|object|embed|base|form|applet)\b/i;
const EVENT_HANDLER_PATTERN   = /\bon[a-z]{3,}\s*=/i;
const UNSAFE_PROTOCOL_PATTERN = /\b(javascript|vbscript|data)\s*:/i;
const EXTERNAL_LINK_PATTERN   = /<link\b[^>]*\brel\s*=\s*["']?stylesheet/i;

// ---------------------------------------------------------------------------
// Unsupported commercial-claim patterns
// Blocked when the same claim does not already exist in the product's bodyHtml.
// ---------------------------------------------------------------------------
const UNSUPPORTED_CLAIM_PATTERNS = [
  /money[- ]back\b/i,
  /full[\s-]refund\b/i,
  // Verb-form refund promises: "refund you", "refund your investment", "refund the full amount".
  // Catches semantic refund promises that don't use the noun form "full refund" or "money-back".
  /\brefund\s+(you|your|the)\b/i,
  // Adverb-led refund: "fully refund", "completely refund".
  /\b(fully|completely)\s+refund\b/i,
  /\d+[\s-]day[\s-](return|refund|guarantee|money|warranty|trial)\b/i,
  /\d+[\s-](month|year)[\s-](warranty|guarantee)\b/i,
  /guaranteed[\s-]results?\b/i,
  /\brisk[- ]free\b/i,
  /free[\s-]replacement\b/i,
  /guaranteed[\s-]delivery\b/i,
  /lifetime[\s-]warranty\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeTitle(title) {
  return (title || '')
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDistinctiveWords(title) {
  return normalizeTitle(title)
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOPWORDS.has(w));
}

function hebrewRatio(text) {
  const clean = stripHtml(text);
  if (!clean.length) return 0;
  const hebrewChars = (clean.match(/[א-תװ-״יִ-פֿ]/g) || []).length;
  const alphaChars  = (clean.match(/[a-zA-Zא-ת]/g) || []).length;
  return alphaChars > 0 ? hebrewChars / alphaChars : 0;
}

// ---------------------------------------------------------------------------
// Trust Badge allowlist (Phase 2). Visible badge labels must come ONLY from the
// approved library; no policy/commercial badge labels may be injected.
// ---------------------------------------------------------------------------
const { ALLOWED_BETA_BADGE_LABELS, extractBadgeLabels } = require('./cro/trust-badges');
const ALLOWED_BADGE_LABEL_SET = new Set(ALLOWED_BETA_BADGE_LABELS);

// Phase-2 disallowed badge/claim phrases that the generic claim check does not
// already cover (free/fast shipping, free/easy returns, satisfaction guarantee,
// risk-free, standalone warranty). Belt-and-suspenders alongside the allowlist.
const DISALLOWED_BADGE_PHRASES = [
  /free\s+shipping/i,
  /fast\s+shipping/i,
  /free\s+returns?/i,
  /easy\s+returns?/i,
  /\breturns?\b/i,
  /\bwarranty\b/i,
  /money[- ]back/i,
  /satisfaction\s+guarantee/i,
  /\bguarantee[d]?\b/i,
  /risk[- ]free/i,
];

// ---------------------------------------------------------------------------
// Check 1 — HTML safety
// ---------------------------------------------------------------------------
function checkHtmlSafety(proposedContent) {
  if (UNSAFE_TAG_PATTERN.test(proposedContent))      return { safe: false, code: 'unsafe_html', reason: 'This content contains unsupported HTML and cannot be applied safely.' };
  if (EVENT_HANDLER_PATTERN.test(proposedContent))   return { safe: false, code: 'unsafe_html', reason: 'This content contains unsupported HTML and cannot be applied safely.' };
  if (UNSAFE_PROTOCOL_PATTERN.test(proposedContent)) return { safe: false, code: 'unsafe_html', reason: 'This content contains unsupported HTML and cannot be applied safely.' };
  if (EXTERNAL_LINK_PATTERN.test(proposedContent))   return { safe: false, code: 'unsafe_html', reason: 'This content contains unsupported HTML and cannot be applied safely.' };
  return { safe: true };
}

// ---------------------------------------------------------------------------
// Check 2 — Duplicate CRO block
// ---------------------------------------------------------------------------
function checkDuplicateCROBlock(issueId, proposedContent, currentBodyHtml) {
  if (!currentBodyHtml) return { safe: true };

  // Block if a data-cro-block marker for the same issueId already exists
  if (currentBodyHtml.includes(`data-cro-block="${issueId}"`)) {
    return { safe: false, code: 'duplicate_cro_block', reason: 'This product already contains this CRO change.' };
  }

  // Block if the exact proposed text already exists in the body
  const contentText = stripHtml(proposedContent);
  if (contentText.length > 20) {
    const bodyText = stripHtml(currentBodyHtml);
    if (bodyText.toLowerCase().includes(contentText.toLowerCase())) {
      return { safe: false, code: 'duplicate_cro_block', reason: 'This product already contains this CRO change.' };
    }
  }

  return { safe: true };
}

// ---------------------------------------------------------------------------
// Check 3 — Cross-product contamination
//
// Blocks if 2+ distinctive words from the same sibling product's title appear
// in the proposed content. Uses a threshold of 2 to avoid false positives from
// short single-word collisions (e.g. "aura" as a common wellness term).
// Common words / stopwords are excluded from matching.
// ---------------------------------------------------------------------------
function checkCrossProductContamination(product, proposedContent, siblingProducts) {
  if (!siblingProducts || siblingProducts.length === 0) return { safe: true };

  const contentLower = proposedContent.toLowerCase();

  for (const sibling of siblingProducts) {
    if (sibling.id === product.id) continue;

    const distinctive = extractDistinctiveWords(sibling.title);
    if (distinctive.length < 2) continue;  // need at least 2 distinctive words to match against

    const hits = distinctive.filter(w => contentLower.includes(w));
    if (hits.length >= 2) {
      return {
        safe:   false,
        code:   'cross_product_contamination',
        reason: 'This content appears to mention another product. Please regenerate it before applying.',
      };
    }
  }
  return { safe: true };
}

// ---------------------------------------------------------------------------
// Check 4 — Unsupported commercial claim
//
// Blocks invented money-back/refund/return-window claims that are not already
// present on the product page. Applies to all issue types; particularly important
// for no_risk_reversal where strong guarantee language is generated.
// ---------------------------------------------------------------------------
function checkUnsupportedClaims(proposedContent, currentBodyHtml) {
  const contentText = stripHtml(proposedContent).toLowerCase();
  const bodyText    = currentBodyHtml ? stripHtml(currentBodyHtml).toLowerCase() : '';

  for (const pattern of UNSUPPORTED_CLAIM_PATTERNS) {
    if (!pattern.test(contentText)) continue;
    // Allow if identical language already exists on the product page
    // (the merchant has explicitly published such a policy)
    if (bodyText && pattern.test(bodyText)) continue;
    return {
      safe:   false,
      code:   'unsupported_claim',
      reason: 'This content may include an unsupported guarantee or policy claim. Please regenerate or review manually.',
    };
  }
  return { safe: true };
}

// ---------------------------------------------------------------------------
// Check 5 — Language consistency
//
// Blocks when the proposed content is in a clearly different script/language
// from the product's existing body. Uses Hebrew character ratio as a simple
// heuristic. Does not block on mixed / ambiguous content.
// ---------------------------------------------------------------------------
function checkLanguageConsistency(proposedContent, currentBodyHtml) {
  if (!currentBodyHtml) return { safe: true };

  const bodyHebrew    = hebrewRatio(currentBodyHtml);
  const contentHebrew = hebrewRatio(proposedContent);
  const contentText   = stripHtml(proposedContent);
  const bodyText      = stripHtml(currentBodyHtml);

  if (contentText.length < 20 || bodyText.length < 50) return { safe: true };

  // Product page predominantly Hebrew but proposed content is Latin
  if (bodyHebrew > 0.30 && contentHebrew < 0.05) {
    return { safe: false, code: 'language_mismatch', reason: 'This content appears to be in a different language than the product page.' };
  }
  // Product page predominantly Latin but proposed content is Hebrew
  if (bodyHebrew < 0.05 && contentHebrew > 0.30) {
    return { safe: false, code: 'language_mismatch', reason: 'This content appears to be in a different language than the product page.' };
  }

  return { safe: true };
}

// ---------------------------------------------------------------------------
// Check 6 — Trust Badge allowlist (Phase 2, no_trust_bullets only)
//
// Every visible badge label must be an approved library label, and no
// policy/commercial claim phrase may appear anywhere in the badge content.
// Only runs for no_trust_bullets; legacy/empty content passes through.
// ---------------------------------------------------------------------------
function checkTrustBadgeLabels(issueId, proposedContent) {
  if (issueId !== 'no_trust_bullets') return { safe: true };

  const labels = extractBadgeLabels(proposedContent);
  for (const label of labels) {
    if (!ALLOWED_BADGE_LABEL_SET.has(label)) {
      return {
        safe: false,
        code: 'badge_not_allowed',
        reason: 'This trust badge is not an approved badge and cannot be applied.',
      };
    }
  }

  const visibleText = stripHtml(proposedContent);
  for (const pattern of DISALLOWED_BADGE_PHRASES) {
    if (pattern.test(visibleText)) {
      return {
        safe: false,
        code: 'badge_unsupported_claim',
        reason: 'This trust badge makes a policy claim that needs evidence and merchant approval.',
      };
    }
  }
  return { safe: true };
}

// ---------------------------------------------------------------------------
// validateContentSafety — main export
//
// context:
//   store           — { id } store record (used to scope the sibling query)
//   product         — rawProduct row (must have .id, .title)
//   issueId         — e.g. "no_risk_reversal"
//   proposedContent — the exact reviewedProposedContent about to be applied
//   currentBodyHtml — current product.bodyHtml
//   siblingProducts — optional pre-loaded [{ id, title }] array.
//                     When provided, skips the DB query (used in tests and
//                     callers that have already loaded products).
//
// prisma — optional PrismaClient (required if siblingProducts not provided)
// ---------------------------------------------------------------------------
async function validateContentSafety(
  { store, product, issueId, proposedContent, currentBodyHtml, siblingProducts },
  prisma,
) {
  try {
    if (!proposedContent || proposedContent.trim().length === 0) {
      return { safe: false, code: 'empty_content', reason: 'This change needs to be regenerated before it can be applied.' };
    }

    // 1. HTML safety — synchronous, no DB
    const htmlCheck = checkHtmlSafety(proposedContent);
    if (!htmlCheck.safe) return htmlCheck;

    // 2. Duplicate CRO block — synchronous, no DB
    const dupCheck = checkDuplicateCROBlock(issueId, proposedContent, currentBodyHtml);
    if (!dupCheck.safe) return dupCheck;

    // 3. Cross-product contamination — may need DB query
    let siblings = siblingProducts;
    if (!siblings && prisma && store?.id) {
      siblings = await prisma.product.findMany({
        where:  { storeId: store.id },
        select: { id: true, title: true },
      });
    }
    const crossCheck = checkCrossProductContamination(product, proposedContent, siblings || []);
    if (!crossCheck.safe) return crossCheck;

    // 4. Unsupported commercial claims — synchronous, no DB
    const claimCheck = checkUnsupportedClaims(proposedContent, currentBodyHtml);
    if (!claimCheck.safe) return claimCheck;

    // 5. Language consistency — synchronous, no DB
    const langCheck = checkLanguageConsistency(proposedContent, currentBodyHtml);
    if (!langCheck.safe) return langCheck;

    // 6. Trust Badge allowlist — synchronous, no DB (no_trust_bullets only)
    const badgeCheck = checkTrustBadgeLabels(issueId, proposedContent);
    if (!badgeCheck.safe) return badgeCheck;

    return { safe: true };

  } catch (err) {
    // Validator errors must not block legitimate applies.
    // Log for diagnosis but allow the apply to continue.
    console.error('[ContentSafetyValidator] unexpected error (non-blocking):', err?.message ?? err);
    return { safe: true };
  }
}

module.exports = {
  validateContentSafety,
  // Individual checks exported for unit testing
  checkHtmlSafety,
  checkDuplicateCROBlock,
  checkCrossProductContamination,
  checkUnsupportedClaims,
  checkLanguageConsistency,
};
