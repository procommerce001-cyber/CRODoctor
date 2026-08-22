# Webhook Registration Lifecycle — Beta 0 Decision Record

**Date raised:** 2026-08-22
**Raised by:** Beta 0 decision brief (pre-rehearsal analysis)
**Related:** runbook (`docs/controlled-beta-0-ops-runbook.md`) §6.1, §10.4, §16, §17, §19, §20.1 · checkpoint (`docs/project-checkpoint-current-status.md`) §6.6

---

## Status

**OPEN — must be resolved before real-store Beta 0.**

This document records an open question and a *provisional* direction. **It is not an approval.** No option below has been selected.

---

## Context

- During the OAuth callback / initial sync, CRODoctor calls `registerWebhooks`, which issues `POST` requests to Shopify's `webhooks.json` for the topics `orders/create`, `products/update`, and `app/uninstalled`.
- The current implementation uses the **raw/global `fetch`**, not `shopifyFetch`.
- PR #14's write kill switch is implemented **inside `shopifyFetch`**. These POSTs therefore **bypass it entirely** and succeed even when `CONTROLLED_BETA_READ_ONLY`, `DISABLE_SHOPIFY_WRITES`, and `APPLY_DISABLED` are all active.
- Because they never reach `shopifyFetch`, they also produce **no `BETA_READ_ONLY_WRITE_BLOCKED` event** — they are invisible to the runbook's blocked-event reconciliation.

**What this behaviour is:**

- A **Shopify Admin API write**. It creates webhook subscription resources in the merchant's app configuration.
- **Standard, ordinarily necessary** app-lifecycle behaviour — the app needs these notifications to function.

**What this behaviour is not:**

- **Not** a product, theme, cart, checkout, ScriptTag, or storefront content change.
- **Not** visible to a shopper. Nothing customer-facing changes.

**Why it still matters:**

- It makes any unqualified claim of **"zero Shopify writes" inaccurate**, in the runbook, in a report, or to a merchant.
- "It's normal for Shopify apps" is an explanation, **not an approval**. It modifies state inside a client's Shopify account after we told them we would not change things. The gap between those two statements is the decision below.
- It is also a **coverage gap in the kill switch** worth knowing about generally: a write path added the same way in future would be equally unguarded.

---

## Options

### Option A — Accept as documented app-lifecycle behaviour

**Pros**
- No code change; no delay to the rehearsal or to Beta 0.
- Keeps the app functioning as designed (webhooks drive sync and uninstall detection).
- Honest and defensible *if* disclosed — merchants installing any Shopify app expect webhook registration.

**Cons**
- Requires the merchant script to be widened, which slightly weakens the simplest version of the read-only promise.
- Leaves the kill-switch bypass in place, so a future write added via raw `fetch` would also be unguarded.
- The "accepted" framing can quietly expand to cover future lifecycle writes that were never reviewed.

**Requirements**
- Release owner **and** product owner sign-off.
- Merchant communication updated per runbook §10.4 **before** install.
- Proof checklist reconciles count, topics, and cleanup on uninstall.
- Data owner consulted **if** webhook payloads will be persisted (`orders/create` carries order data).

### Option B — Route `registerWebhooks` through `shopifyFetch` / the kill switch

**Pros**
- Closes the bypass; restores a single, honest chokepoint for every Shopify write.
- **Would** create a single enforced chokepoint for Shopify Admin writes — making "no Shopify writes while the kill switch is on" accurate for the first time, with no merchant disclosure needed. *(It has never been true: the bypass has existed since the kill switch was introduced.)*
- Produces a visible `BETA_READ_ONLY_WRITE_BLOCKED` event, so the reconciliation model covers it.

**Cons**
- Requires a code PR plus review, test, and verification — real delay.
- **Blocking webhooks may degrade app behaviour**: without `app/uninstalled`, the app will not learn it was uninstalled; without `products/update`/`orders/create`, sync freshness depends on other paths. This needs checking before choosing B.
- Beta 0 would then run with no webhooks at all — which is arguably *further* from how the app really behaves, weakening the rehearsal's realism.

**Requirements**
- Code PR + tests + post-merge verification before any real-store OAuth install.
- Explicit determination of what breaks when the three topics are absent.

### Option C — Disable or defer webhook registration for Beta 0

**Pros**
- Simplest possible read-only story: nothing is written at install, no disclosure required.
- Narrow, reversible change behind a flag.

**Cons**
- Same functional degradation as Option B (no uninstall detection, no push-based freshness).
- Also a code PR — no faster than B, with less long-term value, since it fixes only this call rather than the chokepoint.
- Diverges Beta 0 further from production behaviour.

**Requirements**
- Code PR + verification before real-store OAuth install.
- Runbook updated to state webhooks are absent and what that implies for data freshness.

---

## Current recommendation (provisional — not final)

1. **For the dev-store rehearsal:** proceed as-is and **observe**. Record whether registration occurs, the count, the topics, whether it succeeds under the chosen read-only `SHOPIFY_SCOPES`, and whether the subscriptions are removed on uninstall. The rehearsal is exactly the right place to learn this, and it involves no client.
2. **For real-store Beta 0:** **do not proceed** until owners select A, B, or C and record it here.
3. **Provisional lean: Option A**, on the reasoning that webhook registration is genuinely necessary for the app to work, is invisible to shoppers, and is honestly disclosable in one sentence — whereas B and C buy a cleaner sentence at the cost of degrading the very behaviour the rehearsal is meant to validate. **This lean should be re-examined against the rehearsal evidence**, particularly if registration turns out to fail under read-only scopes (in which case C becomes nearly free).
4. **If Option A is selected:** update merchant communication (runbook §10.4) and the proof checklist, and confirm whether webhook payload retention needs data-owner approval.
5. **If Option B or C is selected:** implement and verify a code PR **before** the real-store OAuth install, and confirm what the absence of webhooks degrades.

---

## Decision required from

- **Release owner** — code-path and guardrail implications.
- **Product owner** — merchant communication and trust implications.
- **Data owner** — only if webhook payloads (notably `orders/create`) will be stored or retained.

---

## Blocks

- Real-store Beta 0.
- Real-store OAuth install.
- Finalization of merchant communication.

## Does not block

- Documentation review and PRs.
- Planning work.
- **Non-client dev-store rehearsal** — provided the rehearsal uses a non-client development store with no real merchant data, and records the webhook behaviour described above.

---

## Decision log

| Date | Decision | Decided by | Notes |
|---|---|---|---|
| | *(unrecorded — open)* | | |
