# Output Contract Validator — Status

## Why it exists
CRO generators produce LLM output that can become `generatedFix` / `proposedContent`
/ merchant-facing preview. The Output Contract Validator enforces that this output
has the correct **structure / format** for its issue type *before* it can reach the
fix/preview path. It complements — never replaces — the apply-time safety layer.

## PR 1A (PR #6, merge `ac82ec8`) — foundation
- Pure contracts registry (`cro/output-contracts.js`) mapping each issue type to its
  structural contract (content type, required fields, HTML policy, length envelope).
- Pure validator (`cro/output-contract-validator.js`) exporting
  `validateGeneratorOutputContract(input) → { ok, reason?, severity? }`. Validate-only:
  no mutation, no normalization, never throws.
- Validator tests. **No runtime wiring at this stage** — the validator was inert.

## PR 1B (PR #7, merge `c3e0bb6`) — generation-time wiring
- Added `acceptGeneratorOutput(issueType, output, validatorOverride)` helper in
  `action-center.service.js`.
- Wired five generation call sites: `no_risk_reversal`, `no_trust_bullets`,
  `no_description`, `description_too_short`, `weak_desire_creation`.
- Behavior:
  - valid output (`ok`) → pass through unchanged.
  - unknown issue type (`ok`, `severity:'warn'`) → pass through unchanged (do not block).
  - invalid / `severity:'fallback'` / null output → return `null` → existing template
    fallback is used.
  - validator throw → **fail open**, keep current behavior.
- `weak_desire_creation` validates only the LLM side of `??`;
  `generateDesireBlock(rawProduct, copyPlan)` remains the untouched terminal fallback.
- Template fallbacks are **not** validated.
- Completed and post-merge verified: 245/245.

## Layer boundary
- **Output Contract Validator** = shape / format checks at **generation-time**.
- **`validateContentSafety`** = claims / truthfulness / language / cross-product
  contamination / duplicate-block checks, fail-closed at **apply-time**.
- These layers are complementary. The Output Contract Validator never duplicates or
  replaces `validateContentSafety`.

## Explicitly NOT done in PR 1B
- No Shopify write path change.
- No Apply/Rollback change.
- No apply-time contract guard.
- No generator logic change.
- No logging.
- No IssueRouter.
- No dedup pass.

## Known deferred
- The validator deeply checks `bestGuess` and `variants[0]`. Variants beyond index 0
  are not deeply contract-checked. A malformed later variant could still surface via
  paths that map all variants (e.g. report microcopy / `selectedVariantIndex > 0`).
- This is **not** a blocker for PR #7. Address only later via a separate scoped
  planning task (candidate "PR 1C") if a review confirms it is needed. It would
  require a validator change, so it is out of scope for the current wiring work.
