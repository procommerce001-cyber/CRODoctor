'use strict';

// ---------------------------------------------------------------------------
// desire-block-llm.js
//
// LLM-generation path for weak_desire_creation — Phase B2 Part C.
// Scope: weak_desire_creation only. Runs before the fragment fallback.
//
// generateDesireBlockWithLLM(product, copyPlan) → same shape as generateDesireBlock | null
//
// Returns null on any failure so the caller falls back cleanly to
// generateDesireBlock. Never throws.
// ---------------------------------------------------------------------------

const { extractSignals }         = require('./desire-block');
const { buildCopyRole }          = require('../copy-role');
const { callAnthropicWithRetry } = require('./anthropic-fetch');
const { CRO_SYSTEM_MESSAGE }     = require('./system-message');

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
// buildLLMPrompt — pure, deterministic
// reviews: optional string[] from fetchProductReviews — enriches the prompt
// when ≥ 2 excerpts are available; ignored otherwise (CopyPlan stays primary).
// ---------------------------------------------------------------------------
function buildLLMPrompt(product, copyPlan, reviews = [], copyRole = null) {
  const signals = extractSignals(product);

  const lines = [
    `Product: ${(product.title || 'this product').trim()}`,
    `Profile: ${signals.profile}`,
    `Price tier: ${copyPlan.priceTier}`,
    `Traffic quality: ${copyPlan.trafficQuality}`,
    `Barrier: ${copyPlan.barrier}`,
    `Emotional frame: ${copyPlan.emotionalFrame}`,
    `Tone: ${copyPlan.toneKey}`,
    `Narrative arc: ${copyPlan.structureKey} (${ARC_DESCRIPTIONS[copyPlan.structureKey] ?? ARC_DESCRIPTIONS.A})`,
  ];

  if (signals.pain)      lines.push(`Pain point: ${signals.pain}`);
  if (signals.setting)   lines.push(`Setting: ${signals.setting}`);
  if (signals.timeOfDay) lines.push(`Time of day: ${signals.timeOfDay}`);
  if (signals.onset)     lines.push(`Onset: ${signals.onset}`);

  const hasVoices = Array.isArray(reviews) && reviews.length >= 2;

  const parts = [];

  // ── COPY ROLE block (prepended when a role contract is available) ──────────
  if (copyRole) {
    parts.push('COPY ROLE');
    if (copyRole.avatar)            parts.push(`Buyer: ${copyRole.avatar}`);
    if (copyRole.dailyFriction)     parts.push(`Daily friction: ${copyRole.dailyFriction}`);
    if (copyRole.emotionalPayoff)   parts.push(`Emotional payoff: ${copyRole.emotionalPayoff}`);
    if (copyRole.blockingObjection) parts.push(`Blocking objection: ${copyRole.blockingObjection}`);
    if (copyRole.languageRegister)  parts.push(`Language register: ${copyRole.languageRegister}`);
    if (Array.isArray(copyRole.forbiddenPhrases) && copyRole.forbiddenPhrases.length > 0) {
      parts.push(`NEVER write any of these phrases: ${copyRole.forbiddenPhrases.map(p => `"${p}"`).join(', ')}`);
    }
    if (copyRole.categoryProof)     parts.push(`Category proof: ${copyRole.categoryProof}`);
    parts.push('');
    parts.push('---');
    parts.push('');
  }

  parts.push('Write one short paragraph (3–5 sentences) for a product page that makes the reader feel what their life looks like after buying this product.');
  parts.push('');
  parts.push(lines.join('\n'));

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
  if (copyRole && Array.isArray(copyRole.forbiddenPhrases) && copyRole.forbiddenPhrases.length > 0) {
    parts.push(`- Do not write any of the following: ${copyRole.forbiddenPhrases.map(p => `"${p}"`).join(', ')}.`);
  }
  parts.push('- Do not state, invent, infer, round, convert, or imply a specific price or price range. Price is handled elsewhere on the page.');
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
// validateOutput — acceptance gates
// Returns cleaned text or null if any gate fails.
// ---------------------------------------------------------------------------
function validateOutput(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let text = stripHtml(raw.trim());

  // Re-check after strip — reject if any tag survived
  if (/<[^>]+>/.test(text)) return null;

  if (text.length < MIN_LENGTH) return null;

  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  if (sentences.length < 2) return null;

  text = truncateToSentence(text, MAX_LENGTH);
  if (text.length < MIN_LENGTH) return null;

  return text;
}

// ---------------------------------------------------------------------------
// generateDesireBlockWithLLM — main export
// reviews: optional string[] from fetchProductReviews — passed to buildLLMPrompt.
// ---------------------------------------------------------------------------
async function generateDesireBlockWithLLM(product, copyPlan, reviews = []) {
  if (!copyPlan)                      return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const signals    = extractSignals(product);
  const copyRole   = buildCopyRole(product, copyPlan);
  const prompt     = buildLLMPrompt(product, copyPlan, reviews, copyRole);

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
      profile:    signals.profile,
      confidence: 'high',
      placement:  'between_pain_and_features',
      source:     'llm',
      tokens: {
        setting:   signals.setting,
        timeOfDay: signals.timeOfDay,
        pain:      signals.pain,
        onset:     signals.onset,
      },
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

module.exports = { generateDesireBlockWithLLM, buildLLMPrompt };
