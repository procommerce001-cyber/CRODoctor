# SHOPIFY_SCOPES and Data Environment — Beta 0 Decision Record

**Date drafted:** 2026-08-23
**Applies from main:** `2e90261` after PR #17
**Related:** runbook (`docs/controlled-beta-0-ops-runbook.md`) §5.1, §5.4, §7, §11 · checkpoint (`docs/project-checkpoint-current-status.md`) §6.1, §6.2 · webhook lifecycle decision record (`docs/decisions/webhook-registration-lifecycle-beta0.md`)

---

## Status

**ACCEPTED FOR NON-CLIENT DEV-STORE REHEARSAL USE — REAL-STORE BETA 0 STILL BLOCKED.**

The scopes and data-environment decisions are accepted for non-client dev-store rehearsal use only. This does not approve real-store Beta 0, real-store OAuth install, write scopes, webhook lifecycle, merchant consent, or diagnostics against a real store.

---

## Context

- CRODoctor is preparing for a read-only Beta 0: internal diagnostics against one real store, no writes, no Apply, no merchant-facing claims.
- PR #14 (write kill switch), PR #15 (diagnostics allowlist gate), PR #16 (ops runbook), and PR #17 (checkpoint + webhook lifecycle docs) are all merged on main.
- Real-store Beta 0 and real-store OAuth install remain blocked.
- Two decisions are required before the non-client dev-store rehearsal:
  1. `SHOPIFY_SCOPES`
  2. Approved data environment
- The webhook lifecycle decision remains separately open and is not decided here. It may be informed by the rehearsal, but must be recorded before any real-store OAuth install.

---

## Decision 1 — `SHOPIFY_SCOPES`

### Recommended strategy

For the non-client dev-store rehearsal:

```text
SHOPIFY_SCOPES=read_products,read_orders,read_analytics
```

- Use this for the non-client dev-store rehearsal.
- Use the same scope set for the first real-store Beta 0 only if the rehearsal proves it sufficient.
- If analytics / ShopifyQL fails, consider adding only `read_reports`.
- Any scope change requires service restart, running-instance confirmation, and a full non-client dev-store re-rehearsal.
- No `write_products`.
- No `write_script_tags`.
- No write scopes for Beta 0 unless a new decision is drafted, approved, and recorded.

### Why

- Matches the merchant promise: the consent screen shows exactly what we said.
- Minimizes consent-screen risk: no "can edit your products" prompt contradicting a read-only brief.
- Prevents product and script writes at the grant level — a guarantee code cannot undo. This matters given the confirmed kill-switch bypass in `registerWebhooks`.
- Supports the read paths Beta 0 exercises: product ingest (`read_products`), order metrics (`read_orders`), and store/product analytics (`read_analytics`).
- Makes accidental ScriptTag installation structurally impossible rather than merely blocked.
- Keeps future write phases explicit: adding write scopes later requires visible merchant re-authorization.

### Fallback

If read-only proves insufficient:

1. Identify the exact failing call and the exact missing scope.
2. Add the minimum read scope only, most likely `read_reports`.
3. Re-run the full non-client dev-store rehearsal.
4. Update this decision record with what failed and what was added.
5. Do not proceed to real-store Beta 0 until the new scope set is verified.

### Not allowed

- No write scopes by default.
- No real-store OAuth install with write scopes unless separately approved by the release owner and product owner.
- No merchant install before the live env value is set, the service restarted, and the running instance confirmed.

---

## Decision 2 — Approved data environment

### Recommended strategy

- Dev-store rehearsal: the current staging environment is acceptable, because it uses non-client development store data only.
- First real merchant Beta 0: a dedicated Beta 0 database/environment, provisioned before any real merchant data is ingested.
- Staging is not approved for real merchant commercial data by default.
- Production is not recommended for the first Beta 0 unless separately approved later.

### Why

- Isolates real merchant data.
- Keeps staging unpolluted by client data.
- Makes deletion and offboarding cleaner and provable.
- Gives clearer access control, enforced by construction.
- Improves merchant trust.
- Still allows a fast non-client rehearsal.

### Minimum controls before any real merchant data

- [ ] Approved environment recorded.
- [ ] Access list approved.
- [ ] Retention period set.
- [ ] Deletion owner named.
- [ ] Token / data cleanup process defined.
- [ ] Tenant isolation / RLS verified if applicable.
- [ ] Merchant informed what data is accessed and retained.
- [ ] No screenshots or exports with merchant data outside approved storage.
- [ ] No tokens, DB URLs, or API keys in any record or report.

### Fallback

If the dedicated Beta 0 environment is not ready:

- Do not default to staging.
- Either delay the real-store Beta 0, or obtain explicit data-owner approval with written access, retention, and deletion limits.
- Record the exception before the OAuth install, not after.

---

## Dev-store rehearsal impact

- ✅ The scopes and data-environment decisions are **now accepted for non-client dev-store rehearsal use** (signed 2026-08-25).
- ⚠️ **This does not mean the rehearsal is ready to run.** It removes one blocker, not all of them. Still required before the rehearsal starts:
  - a **written dev-store rehearsal plan**;
  - the `SHOPIFY_SCOPES` value **set in the live environment**, plus the five write-disable/diagnostics flags;
  - **service restart completed and running instance confirmed** — mandatory before any install URL is generated, because `SHOPIFY_SCOPES` is captured at module load;
  - a plan to **record webhook registration behaviour** during the rehearsal.
- Must use a **non-client development store only**, with no real merchant data.
- Must validate the selected `SHOPIFY_SCOPES` — read-only sufficiency remains **unverified**.
- **Must not connect a real merchant store.**
- **Must not approve the webhook lifecycle for a real merchant by itself.**

---

## Real-store Beta 0 impact

Real-store Beta 0 remains blocked until:

- [ ] Runbook sign-off.
- [x] `SHOPIFY_SCOPES` decision signed. *(2026-08-25 — accepted for non-client rehearsal use only.)*
- [x] Data environment decision signed. *(2026-08-25 — accepted for non-client rehearsal use only.)*
- [ ] Webhook lifecycle decision recorded.
- [ ] Non-client dev-store rehearsal passed.
- [ ] Merchant consent captured.
- [ ] Final go / no-go completed.

---

## Owner sign-off required

| Role | Name | Decision | Date |
|---|---|---|---|
| Release owner | Dekel Hillel | Approved scope strategy as written, with no write scopes. | 2026-08-25 |
| Product owner | Dekel Hillel | Approved merchant-trust framing and accepted later re-authorisation for write-capable phases. | 2026-08-25 |
| Data owner | Dekel Hillel | Approved staging for non-client rehearsal only; dedicated environment required before real merchant data. | 2026-08-25 |

**This sign-off accepts the scopes and data-environment decisions for non-client dev-store rehearsal use only. Real-store Beta 0 remains blocked.**

---

## Open questions

- Does `read_analytics` alone satisfy all ShopifyQL / analytics needs, or is `read_reports` required?
- Does webhook registration succeed under the selected read-only scope set?
- What is the exact retention period for real merchant Beta 0 data?
- Who is the named deletion owner?

---

## Risks / unknowns

- `read_analytics` vs `read_reports` for ShopifyQL remains unverified.
- Webhook registration under read-only scopes remains unverified, and feeds the separate webhook lifecycle decision.
- A missing scope may cause silent thin data rather than a clear error.
- Dedicated Beta 0 environment setup may require resolving Prisma migration-history divergence.
- Retention period and deletion owner remain hard prerequisites before any real merchant data.

---

## Final recommendation

Recommended:

- `SHOPIFY_SCOPES=read_products,read_orders,read_analytics` for non-client dev-store rehearsal.
- Current staging for non-client dev-store rehearsal only.
- Dedicated Beta 0 environment/database before any real merchant data.
- No real-store OAuth install until all required decisions and sign-offs are recorded.
