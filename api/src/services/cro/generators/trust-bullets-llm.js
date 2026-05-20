'use strict';

// ---------------------------------------------------------------------------
// trust-bullets-llm.js
//
// LLM-generation path for no_trust_bullets.
// Scope: no_trust_bullets only. Runs before the generateTrustBullets fallback.
//
// generateTrustBulletsWithLLM(product, copyPlan)
//   → same shape as generateTrustBullets | null
//
// Returns null on any failure so the caller falls back cleanly to the
// template-generated trust bullets. Never throws.
//
// Output contract:
//   { bestGuess: { content: '<ul>…</ul>' }, variants: [{ content: '<ul>…</ul>' }] }
//
// No heading wrapper — no_trust_bullets wrapContent is a pass-through that
// expects a bare <ul> block, matching the contract of generateTrustBullets.
// ---------------------------------------------------------------------------

const { buildCopyRole } = require('../copy-role');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL             = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS        = 10_000;
const MAX_TOKENS        = 100;

const MIN_LENGTH        = 30;
const MAX_LENGTH        = 200;

const BARRIER_DESCRIPTIONS = {
  risk:    'buyer fears financial loss on a high-value purchase from an unknown brand',
  trust:   'buyer does not know this brand and has no basis to trust it yet',
  value:   'buyer is uncertain whether the price is justified',
  fit:     'buyer is not sure this product is right for their specific situation',
  urgency: 'buyer is delaying and needs a reason to decide now',
};

// What pre-purchase trust angle addresses each barrier most directly.
const BARRIER_TRUST_ANGLE = {
  risk:    'signal that you only carry products you stand behind, and that the buyer is making a safe choice',
  trust:   'signal that this is a real brand with genuine product knowledge — the buyer can ask anything and get a straight answer',
  value:   'signal that you are selective about what you stock and back the quality at this price',
  fit:     'signal that you will be honest about whether this product is right for them before they commit',
  urgency: 'signal that your team is available right now to answer any question that might be holding them back',
};

// ---------------------------------------------------------------------------
// detectProductType — mirrors generateTrustBullets in rules.js
// ---------------------------------------------------------------------------
function detectProductType(product) {
  const title    = (product.title    || '').toLowerCase();
  const bodyHtml = (product.bodyHtml || '').toLowerCase();
  const combined = title + ' ' + bodyHtml;
  const price    = parseFloat(String(product.variants?.[0]?.price || 0));
  const hasSizeVariants = (product.variants || []).some(v =>
    /\b(xs|s|m|l|xl|xxl|\d{1,2}\/\d{1,2})\b/i.test(v.option1 || '')
  );

  if (price >= 100) return 'high_ticket';
  if (['back', 'posture', 'pain', 'relief', 'therapy', 'massage', 'support', 'health', 'spine', 'neck', 'recovery'].some(k => combined.includes(k))) return 'health';
  if (hasSizeVariants) return 'fashion';
  return 'functional';
}

// ---------------------------------------------------------------------------
// buildSupportBullets — template bullets 2 and 3 from generateTrustBullets.
// Kept here so assembly is self-contained and does not depend on rules.js.
// ---------------------------------------------------------------------------
function buildSupportBullets(product) {
  const type       = detectProductType(product);
  const vendor     = (product.vendor || '').trim();
  const price      = parseFloat(String(product.variants?.[0]?.price || 0));
  const shortTitle = (product.title || '').replace(/\s*[-–]\s*(v\.?\d+|test|demo|new|old)\s*$/i, '').trim();

  const b2 = vendor
    ? `Questions about ${shortTitle}? The ${vendor} team is here — get in touch before you buy.`
    : `Questions before you order? Get in touch — we'll give you a straight answer.`;

  const b3 =
    type === 'fashion'     ? `Not sure about sizing? Message us before you order and we'll help you get the right fit.` :
    type === 'health'      ? `Not sure if this addresses your specific situation? Ask us first — we'll be honest.` :
    type === 'high_ticket' ? (price > 0
      ? `A $${Math.round(price)} purchase deserves proper consideration — we're available to walk you through it.`
      : `This is a considered purchase — we're available to answer every question before you commit.`)
    : null;

  return { b2, b3 };
}

// ---------------------------------------------------------------------------
// buildTrustBulletsPrompt — pure, deterministic
// reviews:  optional string[] from fetchProductReviews — enriches the prompt
//           when ≥ 2 excerpts are available; ignored otherwise (CopyPlan stays primary).
// copyRole: optional CopyRole from buildCopyRole — prepended as a strict role
//           contract before the CopyPlan block. When null the prompt is identical
//           to the pre-copy-role behaviour.
// ---------------------------------------------------------------------------
function buildTrustBulletsPrompt(product, copyPlan, reviews = [], copyRole = null) {
  const title = (product.title || 'this product').trim();
  const type  = detectProductType(product);
  const price = parseFloat(String(product.variants?.[0]?.price || 0));

  const lines = [
    `Product: ${title}`,
    `Type: ${type}`,
    price > 0 ? `Price: £${price.toFixed(0)}` : null,
    `Barrier: ${copyPlan.barrier} — ${BARRIER_DESCRIPTIONS[copyPlan.barrier] ?? copyPlan.barrier}`,
    `Trust angle to address: ${BARRIER_TRUST_ANGLE[copyPlan.barrier] ?? 'build brand credibility before the purchase decision'}`,
    `Emotional frame: ${copyPlan.emotionalFrame}`,
    `Tone: ${copyPlan.toneKey}`,
    `Price tier: ${copyPlan.priceTier}`,
    `Traffic quality: ${copyPlan.trafficQuality}`,
  ].filter(Boolean);

  const hasVoices = Array.isArray(reviews) && reviews.length >= 2;

  const parts = [];

  // ── COPY ROLE block (prepended when a role contract is available) ──────────
  // The role sets the writer's buyer-specific mindset before the CopyPlan
  // strategic direction. It is a hard constraint, not a soft suggestion.
  // Fields may be null for the general role — only non-null fields are emitted.
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

  // ── Instruction + CopyPlan block ──────────────────────────────────────────
  parts.push('Write one short pre-purchase trust bullet for a product page.');
  parts.push('');
  parts.push(lines.join('\n'));

  if (hasVoices) {
    parts.push('');
    parts.push('Customer voices (use the vocabulary and emotional register — not these sentences verbatim):');
    reviews.forEach(r => parts.push(`- "${r}"`));
  }

  parts.push('');
  parts.push(
    'The bullet must speak to the stated trust angle. It must address a hesitation the buyer has before deciding — not after purchasing.'
    + (hasVoices ? ' If customer voices are provided, mirror their language register and the specific pre-purchase concerns they describe.' : '')
  );
  parts.push('');
  parts.push('Rules:');
  parts.push('- Plain text only. No HTML. No markdown. No bullet character, dash, or asterisk prefix. No quotes around the output.');
  parts.push('- One sentence only. Maximum 160 characters.');
  parts.push('- Pre-purchase framing only. Do not mention returns, refunds, or post-purchase outcomes.');
  parts.push('- Do not start with "We offer" or "We provide".');
  if (copyRole && Array.isArray(copyRole.forbiddenPhrases) && copyRole.forbiddenPhrases.length > 0) {
    parts.push(`- Do not write any of the following: ${copyRole.forbiddenPhrases.map(p => `"${p}"`).join(', ')}.`);
  }
  parts.push('- Output only the bullet text, nothing else.');

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// stripHtml — removes HTML tags
// ---------------------------------------------------------------------------
function stripHtml(text) {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// validateOutput — acceptance gates. Returns cleaned text or null.
// ---------------------------------------------------------------------------
function validateOutput(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let text = stripHtml(raw.trim());
  if (/<[^>]+>/.test(text))     return null;
  if (text.length < MIN_LENGTH)  return null;

  if (text.length > MAX_LENGTH) {
    const cut  = text.slice(0, MAX_LENGTH);
    const last = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    text = last > 0 ? cut.slice(0, last + 1).trim() : cut.trim();
    if (text.length < MIN_LENGTH) return null;
  }

  return text;
}

// ---------------------------------------------------------------------------
// assembleHtml — builds <ul> from LLM b1 + template b2 (+ b3 when present).
// Matches the structure produced by generateTrustBullets in rules.js.
// No outer heading wrapper — no_trust_bullets wrapContent is a pass-through.
// ---------------------------------------------------------------------------
function assembleHtml(b1, b2, b3) {
  const items = [b1, b2, ...(b3 ? [b3] : [])].map(b => `<li>${b}</li>`).join('');
  return `<ul>${items}</ul>`;
}

// ---------------------------------------------------------------------------
// generateTrustBulletsWithLLM — main export
// reviews: optional string[] from fetchProductReviews — passed to buildTrustBulletsPrompt.
// External call shape (action-center.service.js) is unchanged.
// ---------------------------------------------------------------------------
async function generateTrustBulletsWithLLM(product, copyPlan, reviews = []) {
  if (!copyPlan)                      return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;

  // Derive the copy role contract. Returns null for unrecognised categories —
  // null is passed straight through to buildTrustBulletsPrompt which omits the
  // COPY ROLE block, leaving the prompt identical to pre-copy-role behaviour.
  const copyRole = buildCopyRole(product, copyPlan);

  const prompt     = buildTrustBulletsPrompt(product, copyPlan, reviews, copyRole);
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

    const data    = await res.json();
    const llmCopy = validateOutput(data?.content?.[0]?.text);
    if (!llmCopy) return null;

    const { b2, b3 } = buildSupportBullets(product);
    const html        = assembleHtml(llmCopy, b2, b3);
    const variant     = { content: html };

    return { bestGuess: variant, variants: [variant] };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateTrustBulletsWithLLM, buildTrustBulletsPrompt };
