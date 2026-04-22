-- Enable RLS on backend-only tables.
-- All three are accessed exclusively via the Prisma postgres service connection,
-- which bypasses RLS. No row-level policies are needed.
-- Fixes: Supabase Security Advisor — rls_disabled_in_public on User, WebhookEvent, session.

ALTER TABLE "public"."User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."WebhookEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."session" ENABLE ROW LEVEL SECURITY;
