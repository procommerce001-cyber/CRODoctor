'use strict';

// ---------------------------------------------------------------------------
// copy-role.js
//
// Category-aware copy-intelligence layer — Phase B2 copy role contract.
// Scope: consumed by LLM generators before prompt construction.
//        Sits on top of CopyPlan — never replaces it.
//
// Exports:
//   detectCategory(product)          → string (category slug)
//   ROLE_MAP                         → { [slug]: CopyRole }
//   buildCopyRole(product, copyPlan) → CopyRole | null
//
// CopyRole fields (all required when not null):
//   avatar            — who the buyer is and their life situation
//   dailyFriction     — the specific recurring anxiety they live with pre-purchase
//   emotionalPayoff   — the specific emotional state this product delivers
//   blockingObjection — the single most common doubt blocking the click to cart
//   languageRegister  — vocabulary and tone guidance native to this category
//   forbiddenPhrases  — string[] of phrases the model must never write
//   categoryProof     — what form of evidence earns credibility in this category
//
// Design constraints:
//   - Pure and synchronous. No I/O, no async, no side effects.
//   - Never throws intentionally — all errors return null.
//   - Returns null on unrecognised category or any failure.
//     Callers treat null as "use existing prompt unchanged" — zero regression.
//   - Does NOT modify product or copyPlan.
//   - Does NOT persist anything.
//   - CopyPlan remains the source of truth for barrier/frame/tone/structure.
//     This layer adds WHO, not WHAT or HOW.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// detectCategory — keyword matching against lightweight product signals.
//
// Checks only: title, bodyHtml, tags (if present as an array or string).
// More-specific categories are tested first and fall through to general.
//
// baby_infant triggers only on compound or unambiguous baby/infant signals.
// Single keywords like "baby" are sufficient given their specificity — they
// do not appear in other product categories (health, fashion, fitness, etc.).
// ---------------------------------------------------------------------------
function detectCategory(product) {
  try {
    const title    = (product.title    || '').toLowerCase();
    const bodyHtml = (product.bodyHtml || '').toLowerCase();

    // Tags may arrive as a comma-separated string (Shopify) or an array.
    let tagsText = '';
    if (Array.isArray(product.tags)) {
      tagsText = product.tags.join(' ').toLowerCase();
    } else if (typeof product.tags === 'string') {
      tagsText = product.tags.toLowerCase();
    }

    const combined = `${title} ${bodyHtml} ${tagsText}`;

    // baby_infant — specific compound and standalone signals.
    // These keywords are unambiguous: they do not appear in health, fitness,
    // fashion, or general product categories at meaningful rates.
    const babySignals = [
      'baby swim',
      'infant swim',
      'baby float',
      'baby carrier',
      'baby wrap',
      'baby sling',
      'toddler swim',
      'infant carrier',
      'newborn swim',
      'baby pool',
      'swim baby',
      'baby aqua',
      'infant float',
    ];

    // Standalone unambiguous terms checked only in title (tighter scope)
    // to avoid false positives from review text or descriptions that
    // mention babies incidentally (e.g. "safe for babies nearby").
    const babyTitleSignals = ['baby', 'infant', 'toddler', 'newborn'];

    if (babySignals.some(s => combined.includes(s))) return 'baby_infant';
    if (babyTitleSignals.some(s => title.includes(s)))  return 'baby_infant';

    return 'general';
  } catch (_) {
    return 'general';
  }
}

// ---------------------------------------------------------------------------
// ROLE_MAP — static role contracts per category slug.
//
// baby_infant: full rigid role contract for infant/toddler swim and carry products.
//
// general: intentionally narrow prohibition layer only.
//   Does NOT invent a vague universal avatar — that would regress non-baby products.
//   Purpose: eliminate the most egregious helpdesk-style phrases from all outputs.
// ---------------------------------------------------------------------------
const ROLE_MAP = {

  // ── baby_infant ────────────────────────────────────────────────────────────
  //
  // Products: baby swim carriers, infant floats, baby wraps/slings, toddler swim aids.
  // Buyer: new or experienced parent buying swim or carry support for a pre-swimmer.
  // Core insight: the trust failure is NOT brand credibility — it is safety credibility
  // for THIS specific baby's age, weight, and developmental stage.
  // ---------------------------------------------------------------------------
  baby_infant: {
    avatar:
      'A new or experienced parent buying a swim or carry product for their infant or toddler '
      + '(typically 3–18 months). They may be taking their baby swimming for the first time '
      + 'and are anxious about holding them safely. They have probably already researched how '
      + 'to take a baby swimming and understand that standard flotation aids do not work for '
      + 'pre-swimmers. Their primary concern is safety and fit for their specific baby right now.',

    dailyFriction:
      'Every pool session with a young baby requires constant hands-on support — keeping the '
      + "baby's head above water, managing their position and comfort, trying to enjoy the session "
      + 'while managing the fear of getting it wrong. There is no safe way to let go.',

    emotionalPayoff:
      'The parent feels genuinely confident in the water with their baby — hands in the right '
      + 'place, baby secure and head supported — so they can enjoy the session together instead '
      + 'of managing anxiety.',

    blockingObjection:
      "What if this doesn't fit my specific baby — their age, their weight, their size right now? "
      + "Will it actually keep their head above water, or will I still need to catch them?",

    languageRegister:
      'Warm but specific. Parent-to-parent register — like advice from a parent who has done it, '
      + 'not a customer service script. Safety vocabulary is non-negotiable: use terms like '
      + '"ergonomic position", "head supported above water", "face clear of water", "secure hold". '
      + 'Developmental specificity earns credibility — mention age ranges or weight ranges. '
      + 'Short declarative sentences are more trustworthy than soft reassurances.',

    forbiddenPhrases: [
      "if it's not right for your situation",
      'ask us first',
      'give it a try',
      "if it doesn't suit you",
      "reach out and we'll help you sort it",
      "we want you to be happy with your purchase",
      "we take every order seriously",
      "get in touch before you buy",
      "we'll give you a straight answer",
    ],

    categoryProof:
      'Specific age and weight ranges the product is designed for; physical safety language '
      + "about head position and water clearance; how parents with babies at this stage "
      + 'use it successfully.',
  },

  // ── general ───────────────────────────────────────────────────────────────
  //
  // Intentionally minimal. Does NOT attempt a universal buyer avatar.
  // Purpose: prohibit the most common helpdesk-voice phrases that hurt all
  // categories, without risking regression on products that currently work.
  // ---------------------------------------------------------------------------
  general: {
    avatar:            null,
    dailyFriction:     null,
    emotionalPayoff:   null,
    blockingObjection: null,
    languageRegister:  null,

    forbiddenPhrases: [
      "if it's not right for your situation",
      'ask us first',
      'give it a try',
      "if it doesn't suit you",
    ],

    categoryProof: null,
  },
};

// ---------------------------------------------------------------------------
// buildCopyRole — main export.
//
// product  — rawProduct or croProduct (needs title, bodyHtml, tags, variants)
// copyPlan — CopyPlan from buildCopyPlan; passed for future category overrides
//            where price tier or barrier should influence role selection.
//            Currently used only for defensive null check.
//
// Returns a CopyRole object, or null on any failure.
// Null → caller uses its existing prompt unchanged. No regression.
//
// The returned object is a shallow copy — callers cannot mutate ROLE_MAP entries.
// ---------------------------------------------------------------------------
function buildCopyRole(product, copyPlan) {
  try {
    if (!product) return null;

    const category = detectCategory(product);
    const base     = ROLE_MAP[category];
    if (!base) return null;

    // Shallow copy so callers cannot mutate ROLE_MAP entries.
    return { ...base };
  } catch (_) {
    return null;
  }
}

module.exports = { detectCategory, ROLE_MAP, buildCopyRole };
