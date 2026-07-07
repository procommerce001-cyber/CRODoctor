'use strict';

// ---------------------------------------------------------------------------
// output-contract-validator.js  —  Output Contract Validator (v1, pure)
//
// validateGeneratorOutputContract(input) → { ok, reason?, severity? }
//
// Judges whether a CRO generator's output has the right STRUCTURE / FORMAT for
// its issueType, before that output could become a fix / preview. Validate-only:
// it never normalizes, never rewrites, never mutates input, and never throws.
//
// It COMPLEMENTS validateContentSafety — it does not replace or duplicate it.
// Explicitly out of scope here: claims, guarantees, language consistency,
// cross-product contamination, duplicate CRO blocks, truthfulness. Those stay
// in content-safety-validator.js and run fail-closed at apply time.
//
// Return contract:
//   ok:true                        — output satisfies (or is exempt from) the contract
//   ok:false, severity:'fallback'  — malformed/wrong-shape; caller should drop the
//                                    LLM output and fall back to its template
//   ok:true,  severity:'warn'      — unknown issueType (no contract owned here); do
//                                    not block, but surface for observability
//
// Pure: no DB, no env, no network, no fs, no Shopify, no Anthropic, no deps.
// ---------------------------------------------------------------------------

const { getOutputContract, CONTENT_TYPES } = require('./output-contracts');

// Any HTML-looking tag.
const ANY_TAG          = /<[^>]+>/;
// Unsafe HTML we reject even inside html_list contracts.
const UNSAFE_HTML      = /<\s*(script|style|iframe|object|embed|link|meta)\b/i;
const EVENT_HANDLER    = /\son\w+\s*=/i;
const UNSAFE_PROTOCOL  = /(javascript|data)\s*:/i;

const fail = (reason, severity = 'fallback') => ({ ok: false, reason, severity });
const pass = (extra) => (extra ? { ok: true, ...extra } : { ok: true });

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// Count non-overlapping occurrences of a simple tag like <ul or </ul.
function countTag(html, tag) {
  const re = new RegExp('<\\s*' + tag + '\\b', 'gi');
  const m = html.match(re);
  return m ? m.length : 0;
}

// Validate a plain-text contract's content string.
function validatePlainText(content, contract) {
  if (!isNonEmptyString(content)) return fail('Output content is empty or not a string.');
  const text = content.trim();
  if (ANY_TAG.test(text)) return fail('Plain-text contract received HTML markup.');
  if (contract.minLength != null && text.length < contract.minLength) {
    return fail(`Output shorter than minimum ${contract.minLength} characters.`);
  }
  if (contract.maxLength != null && text.length > contract.maxLength) {
    return fail(`Output longer than maximum ${contract.maxLength} characters.`);
  }
  return pass();
}

// Validate an html_list contract's content string: bare <ul><li>…</li></ul> only.
function validateHtmlList(content, contract) {
  if (!isNonEmptyString(content)) return fail('Output content is empty or not a string.');
  const html = content.trim();

  if (UNSAFE_HTML.test(html))     return fail('List content contains unsafe HTML tags.');
  if (EVENT_HANDLER.test(html))   return fail('List content contains inline event handlers.');
  if (UNSAFE_PROTOCOL.test(html)) return fail('List content contains an unsafe URL protocol.');

  const ulOpen = countTag(html, 'ul');
  if (ulOpen === 0) return fail('html_list contract requires a <ul> root.');
  if (ulOpen > 1)   return fail('html_list contract received nested/double <ul>.');
  if (countTag(html, 'li') === 0) return fail('html_list contract requires at least one <li> item.');

  // Reject non-list block tags (only ul/li/ol allowed as structural tags; inline
  // emphasis like <b>/<strong>/<em> is tolerated).
  const disallowedBlock = /<\s*\/?\s*(div|p|section|span|table|h[1-6]|ul\s+\w|article|header|footer)\b/i;
  // Note: <ul ...> with attributes is caught here as a defensive measure; v1
  // expects a bare <ul>.
  if (/<\s*ul\s+[^>]*>/i.test(html)) return fail('html_list contract expects a bare <ul> with no attributes.');
  if (disallowedBlock.test(html))    return fail('html_list contract received non-list block HTML.');

  if (contract.minLength != null && html.length < contract.minLength) {
    return fail(`Output shorter than minimum ${contract.minLength} characters.`);
  }
  if (contract.maxLength != null && html.length > contract.maxLength) {
    return fail(`Output longer than maximum ${contract.maxLength} characters.`);
  }
  return pass();
}

function validateContent(content, contract) {
  return contract.expectedContentType === CONTENT_TYPES.HTML_LIST
    ? validateHtmlList(content, contract)
    : validatePlainText(content, contract);
}

// ---------------------------------------------------------------------------
// validateGeneratorOutputContract({ issueType, generatorId, output, patchMode, context })
// Only `issueType` and `output` are used in v1; the rest are accepted for a
// stable call signature (PR 1B) and ignored here.
// ---------------------------------------------------------------------------
function validateGeneratorOutputContract(input) {
  const issueType = input && input.issueType;
  const output    = input && input.output;

  const contract = getOutputContract(issueType);

  // Unknown issueType: this validator owns no contract for it. Do not block.
  if (!contract) {
    return { ok: true, severity: 'warn', reason: `No output contract registered for issueType "${String(issueType)}".` };
  }

  // Null/undefined output.
  if (output == null) {
    if (contract.allowNullAsNoFix) return pass(); // e.g. disabled TrustBullets LLM path
    return fail('Generator returned no output.');
  }

  // Output must be a plain object carrying bestGuess/variants.
  if (typeof output !== 'object' || Array.isArray(output)) {
    return fail('Output is not a result object.');
  }

  // Required shape: bestGuess.content.
  if (contract.requireBestGuessContent) {
    if (output.bestGuess == null || typeof output.bestGuess !== 'object' || Array.isArray(output.bestGuess)) {
      return fail('Output is missing bestGuess.');
    }
    if (!isNonEmptyString(output.bestGuess.content)) {
      return fail('Output is missing a non-empty bestGuess.content.');
    }
  }

  // Required shape: variants array with at least one entry.
  if (contract.requireVariants) {
    if (!Array.isArray(output.variants)) return fail('Output variants is not an array.');
    if (output.variants.length < 1)      return fail('Output requires at least one variant.');
  }

  // Content-level validation of bestGuess.content.
  const bestGuessCheck = validateContent(output.bestGuess ? output.bestGuess.content : null, contract);
  if (!bestGuessCheck.ok) return bestGuessCheck;

  // If variants[0].content exists, it must also be a valid string of the same
  // shape. We do NOT require equality with bestGuess — generators may legitimately
  // offer alternative variants.
  if (Array.isArray(output.variants) && output.variants.length > 0) {
    const first = output.variants[0];
    if (first && first.content !== undefined) {
      const variantCheck = validateContent(first.content, contract);
      if (!variantCheck.ok) return { ...variantCheck, reason: `variants[0]: ${variantCheck.reason}` };
    }
  }

  return pass();
}

module.exports = { validateGeneratorOutputContract };
