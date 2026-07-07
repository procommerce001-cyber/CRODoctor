'use strict';

// ---------------------------------------------------------------------------
// output-contracts.js  —  Output Contract Validator registry (v1)
//
// Pure data. Maps a CRO issueType (the same issueId strings used by
// action-center.service.js and the generators) to the STRUCTURAL contract its
// generator output must satisfy — expected content type, required fields, HTML
// policy, length envelope, and what to do when the contract is violated.
//
// Scope boundary: this describes SHAPE / FORMAT only. It intentionally says
// nothing about safety, truthfulness, claims, contamination, language, or
// duplicate CRO blocks — those remain the sole responsibility of
// validateContentSafety (content-safety-validator.js). This registry never
// replaces or duplicates that layer.
//
// No imports, no I/O, no side effects. Consumed by output-contract-validator.js
// and its tests only. NOT wired into runtime in PR 1A.
//
// Issue ids and length bounds below mirror the live generators:
//   no_description        → generateDescriptionWithLLM            (MIN 60,  MAX 1200)
//   weak_desire_creation  → generateDesireBlockWithLLM            (MIN 60,  MAX 1200)
//   description_too_short → generateShortDescriptionExpansionWithLLM (MIN 60, MAX 1200)
//   no_risk_reversal      → generateRiskReversalWithLLM           (MIN 30,  MAX 300)
//   no_trust_bullets      → generateTrustBulletsWithLLM           (MIN 30,  MAX 200; LLM path may be disabled → null)
// ---------------------------------------------------------------------------

// Content-type vocabulary (v1):
//   'plain_text' — prose string, no HTML tags permitted.
//   'html_list'  — a bare <ul>…</ul> block of <li> items, no other block HTML.
const CONTENT_TYPES = Object.freeze({ PLAIN_TEXT: 'plain_text', HTML_LIST: 'html_list' });

// Each contract is frozen so callers cannot mutate the shared registry.
const OUTPUT_CONTRACTS = Object.freeze({
  no_description: Object.freeze({
    issueType:          'no_description',
    generatorId:        'generateDescriptionWithLLM',
    expectedContentType: CONTENT_TYPES.PLAIN_TEXT,
    requireBestGuessContent: true,
    requireVariants:    true,
    htmlAllowed:        false,
    minLength:          60,
    maxLength:          1200,
    invalidBehavior:    'fallback',
    // A generator returning null is a normal "no LLM fix" outcome (caller uses
    // the template). Only no_trust_bullets treats null as *contractually* fine;
    // for prose contracts null simply means "fall back", handled by the validator.
    allowNullAsNoFix:   false,
  }),

  weak_desire_creation: Object.freeze({
    issueType:          'weak_desire_creation',
    generatorId:        'generateDesireBlockWithLLM',
    expectedContentType: CONTENT_TYPES.PLAIN_TEXT,
    requireBestGuessContent: true,
    requireVariants:    true,
    htmlAllowed:        false,
    minLength:          60,
    maxLength:          1200,
    invalidBehavior:    'fallback',
    allowNullAsNoFix:   false,
  }),

  description_too_short: Object.freeze({
    issueType:          'description_too_short',
    generatorId:        'generateShortDescriptionExpansionWithLLM',
    expectedContentType: CONTENT_TYPES.PLAIN_TEXT,
    requireBestGuessContent: true,
    requireVariants:    true,
    htmlAllowed:        false,
    minLength:          60,
    maxLength:          1200,
    invalidBehavior:    'fallback',
    allowNullAsNoFix:   false,
  }),

  no_risk_reversal: Object.freeze({
    issueType:          'no_risk_reversal',
    generatorId:        'generateRiskReversalWithLLM',
    expectedContentType: CONTENT_TYPES.PLAIN_TEXT,
    requireBestGuessContent: true,
    requireVariants:    true,
    htmlAllowed:        false,
    minLength:          30,
    maxLength:          300,
    invalidBehavior:    'fallback',
    allowNullAsNoFix:   false,
  }),

  no_trust_bullets: Object.freeze({
    issueType:          'no_trust_bullets',
    generatorId:        'generateTrustBulletsWithLLM',
    expectedContentType: CONTENT_TYPES.HTML_LIST,
    requireBestGuessContent: true,   // only enforced when output is present
    requireVariants:    true,        // only enforced when output is present
    htmlAllowed:        true,        // restricted: bare <ul><li> only
    minLength:          30,
    maxLength:          200,
    invalidBehavior:    'fallback',
    // The no_trust_bullets LLM path is intentionally disabled today
    // (generateTrustBulletsWithLLM returns null; template bullets are used).
    // A null output is therefore a valid "no fix generated" result, not a
    // contract violation.
    allowNullAsNoFix:   true,
  }),
});

// getOutputContract(issueType) → frozen contract | null (unknown issueType).
function getOutputContract(issueType) {
  if (typeof issueType !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(OUTPUT_CONTRACTS, issueType)
    ? OUTPUT_CONTRACTS[issueType]
    : null;
}

module.exports = { OUTPUT_CONTRACTS, CONTENT_TYPES, getOutputContract };
