# Output Contract Validator — PR 1A Summary

_Last updated: 2026-07-14_

## Why this validator exists

The external LLM-pipeline audit alleged "no validation before Shopify write."
Verification showed that was **overstated** — a fail-closed apply-time gate already
exists (`validateContentSafety` → `buildResultContent` → `wrapIssueContent` →
orphan-safe two-phase write). The genuine, narrower gap was that per-generator
output shape/format checking was decentralized and inconsistent. This validator
centralizes that structure/format judgment in one pure, tested place.

## Boundary — contract validation vs `validateContentSafety`

| Output Contract Validator (new) | `validateContentSafety` (existing, unchanged) |
|---|---|
| **Structure / format only:** right shape for the issueType, bestGuess.content present & non-empty, plain_text vs html_list, double-wrap, length envelope | **Safety / truth / context:** claims, truthfulness, language consistency, cross-product contamination, duplicate CRO blocks, merchant/product context |
| Pure, no store/DB context | Runs at apply, needs store+product+siblings, fail-closed |

It **complements** — never replaces or duplicates — `validateContentSafety`.

## Current status

- **PR 1A merged (`f2a2709`, merge `ac82ec8`) and post-merge verified.**
- Pure helper + registry + tests only. **No runtime wiring.**

## Files added

- `api/src/services/cro/output-contracts.js` — registry (`OUTPUT_CONTRACTS`, `CONTENT_TYPES`, `getOutputContract`)
- `api/src/services/cro/output-contract-validator.js` — `validateGeneratorOutputContract(input) → { ok, reason?, severity? }`
- `api/src/__tests__/output-contract-validator.test.js` — 30 tests

## Contracts covered (v1)

| issueType | content type | HTML | null allowed |
|---|---|---|---|
| `no_description` | plain_text | no | no |
| `weak_desire_creation` | plain_text | no | no |
| `description_too_short` | plain_text | no | no |
| `no_risk_reversal` | plain_text | no | no |
| `no_trust_bullets` | html_list (`<ul><li>`) | restricted | **yes** (disabled LLM path → null = "no fix") |

Unknown issueType → `ok:true, severity:'warn'`; violation → `ok:false, severity:'fallback'`
(drop LLM output, keep template). Validate-only, deterministic, non-mutating, never throws.

## Tests

- 30 validator tests; full suite **231/231** after merge.

## ⚠️ Explicit warning

**Do NOT wire this into `action-center.service.js` (or any runtime path) until
PR 1B is separately planned, scoped, implemented, audited, and merge-verified.**
PR 1A is intentionally inert.
