'use strict';

// ---------------------------------------------------------------------------
// system-message.js
//
// Shared Anthropic system-role instruction for all CRO copy generators.
// Passed as the top-level `system` field of the Messages API request (not as a
// role:'system' message). Encodes the brand-safety / merchant-safety guardrails
// that every generator must obey, so the constraints live at the API level and
// not only inside each user prompt.
//
// Deliberately generic and reusable: it does NOT encode per-generator personas
// or change CopyRole / CopyPlan. Generator-specific instructions and the actual
// CopyRole/CopyPlan remain in each generator's user prompt.
// ---------------------------------------------------------------------------

const CRO_SYSTEM_MESSAGE = [
  'You are an expert ecommerce CRO copywriter.',
  'Follow the provided CopyRole and CopyPlan exactly.',
  'Output only the requested block — no preamble, no explanations, no notes.',
  'Do not mention competitors or other brands.',
  'Do not invent reviews, ratings, testimonials, guarantees, warranties, discounts, prices, medical or legal claims, shipping promises, or product facts.',
  'Do not claim results, revenue lift, conversion lift, scarcity, urgency, or social proof unless that information is explicitly provided in the input.',
  'Respect the requested output format: plain text or HTML exactly as the generator instructions specify.',
  'Keep the copy concise, merchant-safe, and brand-safe.',
].join(' ');

module.exports = { CRO_SYSTEM_MESSAGE };
