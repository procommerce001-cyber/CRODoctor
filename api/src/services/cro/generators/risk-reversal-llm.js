'use strict';

// ---------------------------------------------------------------------------
// risk-reversal-llm.js
//
// LLM-generation path for no_risk_reversal.
// Scope: no_risk_reversal only. Runs before the generateTrustBlock fallback.
//
// generateRiskReversalWithLLM(product, copyPlan)
//   → same shape as generateTrustBlock | null
//
// Returns null on any failure so the caller falls back cleanly to the
// template-generated trust block. Never throws.
// ---------------------------------------------------------------------------

const { buildCopyRole, detectCategory } = require('../copy-role');
const { callAnthropicWithRetry }        = require('./anthropic-fetch');

const MODEL      = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 20_000;
const MAX_TOKENS        = 120;

const MIN_LENGTH        = 30;
const MAX_LENGTH        = 300;

const BARRIER_DESCRIPTIONS = {
  risk:    'buyer fears financial loss from a high-value purchase with an unknown brand',
  trust:   'buyer has never purchased from this brand and carries full purchase risk',
  value:   'buyer is not sure the product is worth the price they are paying',
  fit:     'buyer is uncertain whether the product is right for their specific situation',
  urgency: 'buyer is delaying the decision and needs permission to act now',
};

// ---------------------------------------------------------------------------
// detectProductType — mirrors the subset used by generateTrustBlock in rules.js
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

  // Unambiguous health keywords — substring match is safe for these terms.
  // 'health' is excluded here: substring match would catch "healthy", "health-conscious",
  // "healthy cooking" etc. and misclassify non-health products. It is checked separately
  // below with a word-boundary regex so only the standalone word triggers the type.
  const preciseHealthKw = ['posture', 'pain', 'relief', 'therapy', 'massage', 'spine', 'neck', 'recovery'];
  if (preciseHealthKw.some(k => combined.includes(k))) return 'health';
  if (/\bhealth\b/i.test(combined)) return 'health';

  // Ambiguous short keywords — require word-boundary match to prevent false positives
  // (e.g. "backs up", "get your time back", "support hose", "setback").
  if (/\bback\b/.test(combined) || /\bsupport\b/.test(combined)) return 'health';

  if (hasSizeVariants) return 'fashion';
  return 'functional';
}

// ---------------------------------------------------------------------------
// buildHeadingAndB2 — same template logic as generateTrustBlock in rules.js.
// Kept here so the HTML assembly is self-contained and does not depend on
// rules.js internals.
// ---------------------------------------------------------------------------
function buildHeadingAndB2(product) {
  const category = detectCategory(product);
  const title    = (product.title || 'this product').trim();
  const team     = 'our team';
  const type     = detectProductType(product);

  const shortTitle = title.replace(/\s*[-–]\s*(v\.?\d+|test|demo|new|old)\s*$/i, '').trim();

  if (category === 'baby_infant') {
    return {
      heading: `Not the right fit for your baby's current size or stage? We'll make it right.`,
      b2:      `Every baby grows differently — if the fit isn't right for your baby's current weight or age, we stand behind it and will sort it with you.`,
    };
  }

  const heading =
    type === 'health'      ? `Not seeing the improvement you expected? We want to hear from you.` :
    type === 'fashion'     ? `Not the right fit? Reach out — we'll help you sort it.` :
    type === 'high_ticket' ? `Not what you expected from ${shortTitle}? Reach out to ${team}.` :
    `Not what you expected? Reach out — we'll help make it right.`;

  const b2 =
    type === 'health'      ? `We want this product to work for you. If it doesn't, we want to know — we'll do our best to help.` :
    type === 'high_ticket' ? `A purchase at this level should feel right. If something's off, reach out — we take that seriously.` :
    `We take every order seriously. If something isn't right, getting in touch is easy — we'll do our best to sort it.`;

  return { heading, b2 };
}

// ---------------------------------------------------------------------------
// buildRiskReversalPrompt — pure, deterministic
// reviews: optional string[] from fetchProductReviews — enriches the prompt
// when ≥ 2 excerpts are available; ignored otherwise (CopyPlan stays primary).
// ---------------------------------------------------------------------------
function buildRiskReversalPrompt(product, copyPlan, reviews = [], copyRole = null) {
  const title = (product.title || 'this product').trim();
  const type  = detectProductType(product);
  const price = parseFloat(String(product.variants?.[0]?.price || 0));

  const lines = [
    `Product: ${title}`,
    `Type: ${type}`,
    price > 0 ? `Price: £${price.toFixed(0)}` : null,
    `Barrier: ${copyPlan.barrier} — ${BARRIER_DESCRIPTIONS[copyPlan.barrier] ?? copyPlan.barrier}`,
    `Emotional frame: ${copyPlan.emotionalFrame}`,
    `Tone: ${copyPlan.toneKey}`,
    `Price tier: ${copyPlan.priceTier}`,
    `Traffic quality: ${copyPlan.trafficQuality}`,
  ].filter(Boolean);

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

  parts.push('Write one to two sentences of guarantee copy for a product page.');
  parts.push('');
  parts.push(lines.join('\n'));

  if (hasVoices) {
    parts.push('');
    parts.push('Customer voices (use the vocabulary and emotional register — not these sentences verbatim):');
    reviews.forEach(r => parts.push(`- "${r}"`));
  }

  parts.push('');
  parts.push(
    'The copy must directly address the stated barrier. Make the buyer feel that the purchase risk has been transferred away from them.'
    + (hasVoices ? ' If customer voices are provided, mirror their language register and the specific hesitations they describe.' : '')
  );
  parts.push('');
  parts.push('Rules:');
  parts.push('- Plain text only. No HTML. No markdown. No quotes around the output. No labels.');
  parts.push('- Do not use or invent any brand names, product names, company names, or team names other than the product and vendor explicitly provided in this prompt.');
  parts.push('- Refer to the seller only as "we", "us", or "our team". Never write "[Product] team" or "[Brand] team" unless the exact name was provided above.');
  parts.push('- If you need to name the seller, use only "we", "us", "our team", or "this product".');
  parts.push('- Do not use generic phrases like "100% satisfaction guaranteed".');
  parts.push('- Do not invent specific return windows (e.g. "30 days") — keep the copy general.');
  if (copyRole && Array.isArray(copyRole.forbiddenPhrases) && copyRole.forbiddenPhrases.length > 0) {
    parts.push(`- Do not write any of the following: ${copyRole.forbiddenPhrases.map(p => `"${p}"`).join(', ')}.`);
  }
  parts.push('- Output only the guarantee copy, nothing else.');

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
  if (/<[^>]+>/.test(text))    return null;
  if (text.length < MIN_LENGTH) return null;

  if (text.length > MAX_LENGTH) {
    const cut  = text.slice(0, MAX_LENGTH);
    const last = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
    text = last > 0 ? cut.slice(0, last + 1).trim() : cut.trim();
    if (text.length < MIN_LENGTH) return null;
  }

  return text;
}

// ---------------------------------------------------------------------------
// validateNoBrandHallucination
//
// Catches the specific failure mode where the LLM writes "[Foreign Brand] team"
// in the output — i.e. a TitleCase multi-word phrase followed by "team" that
// does not appear in the current product title or vendor string.
//
// Returns true (safe) when no foreign brand pattern is detected.
// Returns false (reject) when a hallucinated "[X Y] team" is found whose
// capitalized words are not substrings of the product/vendor context.
//
// Intentionally narrow: only rejects "[TitleCase Words] team" patterns.
// Does not attempt to catch all possible hallucinations.
// ---------------------------------------------------------------------------
function validateNoBrandHallucination(text, product) {
  const context = ((product.title || '') + ' ' + (product.vendor || '')).toLowerCase();
  const teamPattern = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)+)\s+team\b/g;
  let match;
  while ((match = teamPattern.exec(text)) !== null) {
    if (!context.includes(match[1].toLowerCase())) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// assembleHtml — builds guarantee block HTML from heading + b1 (LLM) + b2 (template).
// Matches the structure produced by generateTrustBlock in rules.js.
// ---------------------------------------------------------------------------
function assembleHtml(heading, b1, b2) {
  return [
    `<p><strong>${heading}</strong></p>`,
    `<ul>`,
    `<li>${b1}</li>`,
    `<li>${b2}</li>`,
    `</ul>`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// generateRiskReversalWithLLM — main export
// reviews: optional string[] from fetchProductReviews — passed to buildRiskReversalPrompt.
// ---------------------------------------------------------------------------
async function generateRiskReversalWithLLM(product, copyPlan, reviews = []) {
  if (!copyPlan)                      return null;
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const copyRole = buildCopyRole(product, copyPlan);
  const prompt   = buildRiskReversalPrompt(product, copyPlan, reviews, copyRole);

  try {
    const res = await callAnthropicWithRetry({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      messages:   [{ role: 'user', content: prompt }],
    }, TIMEOUT_MS);

    if (!res) return null;

    const data    = await res.json();
    const llmCopy = validateOutput(data?.content?.[0]?.text);
    if (!llmCopy) return null;

    // Belt-and-suspenders: reject if the output contains a "[Foreign Brand] team"
    // pattern whose words are not in the current product/vendor context.
    // Falls back to template cleanly — no error thrown.
    if (!validateNoBrandHallucination(llmCopy, product)) return null;

    const { heading, b2 } = buildHeadingAndB2(product);
    const html             = assembleHtml(heading, llmCopy, b2);
    const variant          = { content: html };

    return { bestGuess: variant, variants: [variant] };
  } catch (_) {
    return null;
  }
}

module.exports = { generateRiskReversalWithLLM, buildRiskReversalPrompt };
