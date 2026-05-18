'use strict';

// ---------------------------------------------------------------------------
// description-llm.js
//
// LLM-generation path for no_description only.
// Runs before the generateDesireBlock template fallback in action-center.
//
// generateDescriptionWithLLM(product, copyPlan)
//   → { bestGuess: { content: plainText }, variants: [{ content }] } | null
//
// Returns null on any failure so the caller falls back cleanly to the
// template-generated desire block from rules.js. Never throws.
//
// Output contract:
//   content is plain text — no_description.wrapContent wraps it in <p>.
//   Same contract as desire-block-llm.js.
// ---------------------------------------------------------------------------

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL             = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS        = 10_000;
const MAX_TOKENS        = 300;

const MIN_LENGTH        = 60;
const MAX_LENGTH        = 1200;

const ARC_DESCRIPTIONS = {
  A: 'anchor → pivot → resolution → closer',
  B: 'tension → anchor → pivot → resolution',
  C: 'anchor → tension → pivot → resolution',
  D: 'pivot → anchor → resolution → closer',
};

// ---------------------------------------------------------------------------
// buildDescriptionPrompt — pure, deterministic
// Grounds the prompt entirely in CopyPlan + minimal safe product signal.
// No body signal is used because no_description fires only when bodyHtml
// is absent or trivially short — there is nothing useful to extract from it.
// reviews: optional string[] from fetchProductReviews — enriches the prompt
// when ≥ 2 excerpts are available; ignored otherwise (CopyPlan stays primary).
// ---------------------------------------------------------------------------
function buildDescriptionPrompt(product, copyPlan, reviews = []) {
  const title  = (product.title  || 'this product').trim();
  const vendor = (product.vendor || '').trim();
  const price  = parseFloat(String(product.variants?.[0]?.price || 0));

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
  ].filter(Boolean);

  const hasVoices = Array.isArray(reviews) && reviews.length >= 2;

  const parts = [
    'Write one short paragraph (3–5 sentences) for a product page that makes the reader feel what their life looks like after buying this product.',
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
  parts.push('- Output only the paragraph, nothing else.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// stripHtml — removes HTML tags
// ---------------------------------------------------------------------------
function stripHtml(text) {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
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
// generateDescriptionWithLLM — main export
// reviews: optional string[] from fetchProductReviews — passed to buildDescriptionPrompt.
// ---------------------------------------------------------------------------
async function generateDescriptionWithLLM(product, copyPlan, reviews = []) {
  if (!copyPlan)                      return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const prompt     = buildDescriptionPrompt(product, copyPlan, reviews);
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const text = validateOutput(data?.content?.[0]?.text);
    if (!text) return null;

    const variant = {
      content:    text,
      structure:  copyPlan.structureKey,
      confidence: 'high',
      placement:  'full_description',
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
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateDescriptionWithLLM, buildDescriptionPrompt };
