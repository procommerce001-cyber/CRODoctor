# LLM Pipeline — External Audit Summary & Verification

_Last updated: 2026-07-05_

Records an external audit of the CRODoctor LLM copy pipeline, and Claude's
verification of each claim against the actual codebase. Preserved so we don't
re-litigate settled findings.

## External audit

- **Score:** 62 / 100
- **Overall characterization:** LLM pipeline described as prototype-grade, with
  one alleged critical issue and several high-priority concerns.

### Reported findings

| Sev | Finding |
|-----|---------|
| Critical | LLM output may be written to live Shopify product HTML without centralized validation / sanitization / normalization. |
| High | Three of five generators used raw `fetch` without retry. |
| High | No system-role / system-field message in active LLM calls. |
| High | Issue routing in `action-center.service.js` is implicit. |
| Medium | Short-description insertion anchor is implicit. |
| Medium | No post-generation deduplication / consistency pass. |
| Medium | Generator contracts are under-documented. |
| Medium | Hardcoded Anthropic model strings. |
| Low | TrustBullets LLM path intentionally disabled but contains dead code. |

## Claude verification against current code

**Verdict: `AUDIT_CONFIRMED_START_WITH_RETRY_AND_SYSTEM_MESSAGES`**

### Confirmed (real, high-priority)

- **Retry inconsistency across generators** — three of five used raw `fetch` with
  no retry. Real. → Addressed by PR #4.
- **Missing top-level system messages** in active LLM calls. Real. → Addressed by PR #4.

### Overstated / rejected

- **The "critical" claim (no validation before Shopify write) was overstated.**
  Current code already has a **fail-closed pre-write safety gate**:
  - `validateContentSafety`
  - `buildResultContent`
  - `wrapIssueContent`
  Existing write-path safety was stronger than the report implied.
  **No confirmed P0 write-safety blocker was found.**

### Partially confirmed (narrower real version)

- The legitimate, narrower remainder of the external "P0" is: **add an
  output-contract / per-issue format validator** to *complement* (not replace) the
  existing safety validation — enforcing output shape (plain text vs HTML, required
  fields, placement/wrapper rules, no malformed output, no double wrapping).
  Tracked as **P1.5** in the roadmap.

### Still open (lower priority, see roadmap)

- Implicit issue routing in `action-center.service.js` → future **IssueRouter** (P2).
- Implicit short-description insertion anchor (Medium).
- No dedup/consistency pass across generators (P2).
- Under-documented generator contracts (P2/P3).
- Hardcoded model strings → shared LLM config later (P2, not urgent).
- TrustBullets disabled-path dead code (P3, not a blocker).

## Bottom line

The audit was **directionally useful** but its headline P0 was overstated: the
Shopify write path already fails closed. The two genuinely confirmed high-priority
issues (retry + system messages) were the correct starting point and are now shipped
in PR #4. The remaining narrower need is an output-contract validator, split into a
pure validator PR and a careful wiring PR.
