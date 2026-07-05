'use strict';

// ---------------------------------------------------------------------------
// short-description-llm.js
//
// LLM-generation path for description_too_short only.
// Runs before the generateDesireBlock template fallback in action-center.
//
// generateShortDescriptionExpansionWithLLM(product, copyPlan)
//   → { bestGuess: { content: plainText }, variants: [{ content }] } | null
//
// Returns null on any failure so the caller falls back cleanly to the
// template-generated desire block from rules.js. Never throws.
//
// Output contract:
//   content is plain text — description_too_short.wrapContent wraps it in <p>.
//   Applied via insert_after_anchor: appended after the existing description,
//   not replacing it. The prompt explicitly prevents repetition of existing copy.
// ---------------------------------------------------------------------------

const { callAnthropicWithRetry } = require('./anthropic-fetch');
const { CRO_SYSTEM_MESSAGE }     = require('./system-message');

const MODEL             = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS        = 10_000;
const MAX_TOKENS        = 300;

const MIN_LENGTH        = 60;
const MAX_LENGTH        = 1200;

// Maximum plain-text chars of existing body included in the prompt.
// description_too_short.check() gates on stripped text < 200 chars,
// so the full existing body always fits within this budget.
const EXISTING_BODY_CAP = 200;

const ARC_DESCRIPTIONS = {
  A: 'anchor → pivot → resolution → closer',
  B: 'tension → anchor → pivot → resolution',
  C: 'anchor → tension → pivot → resolution',
  D: 'pivot → anchor → resolution → closer',
};

// ---------------------------------------------------------------------------
// stripHtml — removes HTML tags and collapses whitespace
// ---------------------------------------------------------------------------
function stripHtml(text) {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// truncateAtWord — trim to maxLen at the last word boundary
// ---------------------------------------------------------------------------
function truncateAtWord(text, maxLen) {
  if (text.length <= maxLen) return text;
  const cut       = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > 0 ? cut.slice(0, lastSpace).trim() : cut.trim();
}

// ---------------------------------------------------------------------------
// buildExpansionPrompt — pure, deterministic
//
// The existing body is included as read-only context so the LLM knows what
// has already been said and can extend rather than repeat it.
// It is NOT used as a source of barrier inference — CopyPlan owns that.
// reviews: optional string[] from fetchProductReviews — enriches the prompt
// when ≥ 2 excerpts are available; ignored otherwise (CopyPlan stays primary).
// ---------------------------------------------------------------------------
function buildExpansionPrompt(product, copyPlan, reviews = []) {
  const title       = (product.title  || 'this product').trim();
  const vendor      = (product.vendor || '').trim();
  const price       = parseFloat(String(product.variants?.[0]?.price || 0));
  const existingRaw = stripHtml(product.bodyHtml || '');
  const existing    = truncateAtWord(existingRaw, EXISTING_BODY_CAP);

  const lines = [
    `Product: ${title}`,
    vendor ? `Brand: ${vendor}` : null,
    price > 0 ? `Price: £${price.toFixed(0)}` : null,
    `Price tier: ${copyPlan.priceTier}`,
    `Traffic quality: ${copyPlan.trafficQuality}`,
    `Barrier: ${copyPlan.barrier}`,
    `Emotional frame: ${copyPlan.emotionalFrame}`,
    `Tone: ${copyPlan.toneKey}`,
    `Narrative arc: ${copyPlan.structureKey} (${ARC_DESCRIPTIONS[copyPlan.structureKey] ?? ARC_DESCRIPTIONS.A})`,
    existing ? `Existing description: "${existing}"` : null,
  ].filter(Boolean);

  const hasVoices = Array.isArray(reviews) && reviews.length >= 2;

  const parts = [
    'Write one short paragraph (3–5 sentences) that will be appended to an existing product page description to make it more persuasive.',
    '',
    lines.join('\n'),
  ];

  if (hasVoices) {
    parts.push('');
    parts.push('Customer voices (use the vocabulary and emotional register — not these sentences verbatim):');
    reviews.forEach(r => parts.push(`- "${r}"`));
  }

  parts.push('');
  parts.push(
    `Address the barrier "${copyPlan.barrier}" through a ${copyPlan.emotionalFrame} frame using a ${copyPlan.toneKey} voice. Follow the narrative arc order.`
    + (hasVoices ? ' If customer voices are provided, mirror their language register and the specific outcomes they describe.' : '')
  );
  parts.push('');
  parts.push('Rules:');
  parts.push('- Plain text only. No HTML. No markdown. No labels. No quotes.');
  parts.push('- Do not open with the product name.');
  parts.push('- Do not use generic openers like "Introducing", "Experience", or "Discover".');
  parts.push('- Do not repeat or paraphrase what the existing description already says.');
  parts.push('- Build on it — add the persuasion layer that is currently missing.');
  parts.push('- Output only the paragraph, nothing else.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// truncateToSentence — trim to maxLen at the last complete sentence boundary
// ---------------------------------------------------------------------------
function truncateToSentence(text, maxLen) {
  if (text.length <= maxLen) return text;
  const cut  = text.slice(0, maxLen);
  const last = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  return last > 0 ? cut.slice(0, last + 1).trim() : cut.trim();
}

// ---------------------------------------------------------------------------
// validateOutput — acceptance gates. Returns cleaned text or null.
// ---------------------------------------------------------------------------
function validateOutput(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let text = stripHtml(raw.trim());

  if (/<[^>]+>/.test(text)) return null;
  if (text.length < MIN_LENGTH) return null;

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length < 2) return null;

  text = truncateToSentence(text, MAX_LENGTH);
  if (text.length < MIN_LENGTH) return null;

  return text;
}

// ---------------------------------------------------------------------------
// generateShortDescriptionExpansionWithLLM — main export
// reviews: optional string[] from fetchProductReviews — passed to buildExpansionPrompt.
// ---------------------------------------------------------------------------
async function generateShortDescriptionExpansionWithLLM(product, copyPlan, reviews = []) {
  if (!copyPlan)                      return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const prompt     = buildExpansionPrompt(product, copyPlan, reviews);

  try {
    const res = await callAnthropicWithRetry({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     CRO_SYSTEM_MESSAGE,
      messages:   [{ role: 'user', content: prompt }],
    }, TIMEOUT_MS);

    if (!res) return null;

    const data = await res.json();
    const text = validateOutput(data?.content?.[0]?.text);
    if (!text) return null;

    const variant = {
      content:    text,
      structure:  copyPlan.structureKey,
      confidence: 'high',
      placement:  'description_expansion',
      source:     'llm',
      copyPlan: {
        barrier:        copyPlan.barrier,
        proofStyle:     copyPlan.proofStyle,
        emotionalFrame: copyPlan.emotionalFrame,
        toneKey:        copyPlan.toneKey,
        priceTier:      copyPlan.priceTier,
        trafficQuality: copyPlan.trafficQuality,
      },
    };

    return { variants: [variant], bestGuess: variant };
  } catch (_) {
    return null;
  }
}

module.exports = { generateShortDescriptionExpansionWithLLM, buildExpansionPrompt };
