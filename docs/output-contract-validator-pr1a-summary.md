# Output Contract Validator — PR 1A Summary

_Last updated: 2026-07-07_

## Why this validator exists

The external LLM-pipeline audit alleged "no validation before Shopify write."
Verification against the code showed that claim was **overstated** — a fail-closed
apply-time gate already exists (`validateContentSafety` → `buildResultContent` →
`wrapIssueContent` → orphan-safe two-phase write). The genuine, narrower gap was
that **per-generator output shape/format checking was decentralized and
inconsistent** (each generator did its own ad-hoc length/HTML checks and returned
`null`). The Output Contract Validator centralizes that shape/format judgment in
one pure, tested place.

## The boundary — contract validation vs `validateContentSafety`

| Output Contract Validator (new) | `validateContentSafety` (existing, unchanged) |
|---|---|
| **Structure / format only** | **Safety / truth / context** |
| Right shape for the issueType? bestGuess.content present & non-empty? plain_text vs html_list? double-wrapped? length envelope? | Unsafe HTML, unsupported claims/guarantees, cross-product contamination, duplicate CRO blocks, language consistency, trust-badge labels |
| Pure, no DB/store context | Runs at apply, needs store + product + siblings, fail-closed |

The contract validator **complements** the safety validator. It must never
re-implement claim / language / contamination / duplicate-block / truthfulness
checks — those remain solely in `validateContentSafety`.

## Current status

- **PR 1A merged** (`f2a2709`, merge `ac82ec8`) and post-merge verified.
- **Pure helper + registry + tests only. No runtime wiring.**

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
| `no_trust_bullets` | html_list (`<ul><li>`) | restricted | **yes** (LLM path disabled → null = "no fix") |

Behavior: unknown issueType → `ok:true, severity:'warn'`; contract violation →
`ok:false, severity:'fallback'` (drop LLM output, keep template). Validate-only —
no normalization, deterministic, non-mutating, never throws.

## Tests

- 30 validator tests (valid/invalid shapes, HTML policy, unsafe-HTML rejection, null handling, unknown issueType, no-mutation, determinism, no DB/env/network).
- Full suite: **231/231**.

## ⚠️ Explicit warning

**Do NOT wire this into `action-center.service.js` (or any runtime path) until
PR 1B is separately planned, scoped, implemented, audited, and merge-verified.**
PR 1A is intentionally inert.
