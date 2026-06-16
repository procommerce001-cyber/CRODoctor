-- Enable RLS on the remaining private merchant/store tables.
--
-- Captures the existing live (out-of-band) secure state in migration history so
-- a freshly built environment reproduces it. Without this, only User,
-- WebhookEvent, session (20260423000000) and PdpEvent,
-- ProductPerformanceProfile (20260513000000) would get RLS from migrations,
-- leaving these 11 sensitive tables (incl. Store, which holds the Shopify
-- access token, and Order/OrderLineItem merchant data) RLS-disabled on a fresh DB.
--
-- Safety properties:
--   * All tables are accessed exclusively via the backend Prisma connection,
--     whose role has BYPASSRLS=true — so enabling RLS changes no backend behaviour.
--   * NO policies are created: anon / authenticated / service_role (PostgREST)
--     get deny-all on these tables, which is the intended posture.
--   * NO FORCE ROW LEVEL SECURITY — the bypass role must keep bypassing.
--   * Idempotent / non-destructive: ENABLE ROW LEVEL SECURITY is a no-op on a
--     table that already has RLS enabled, so this is a no-op on staging/prod
--     (where RLS is already on) and only takes effect on fresh environments.
--   * No data mutation, no GRANT/REVOKE, no changes to Store.accessToken.

ALTER TABLE IF EXISTS public."Store"                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."Product"                ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."ProductVariant"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."ProductImage"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."Order"                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."OrderLineItem"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."ThemeSnapshot"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."CroExecution"           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."ActionItem"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."ContentExecution"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."ProductMetricsSnapshot" ENABLE ROW LEVEL SECURITY;
