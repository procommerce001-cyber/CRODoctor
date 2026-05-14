-- Enable RLS on internal-only analytics tables.
--
-- Both tables are accessed exclusively via the Prisma postgres superuser
-- connection. PostgreSQL superusers bypass RLS unconditionally, so no
-- backend behaviour changes. No policies are added because no anon,
-- authenticated, or service_role PostgREST access path exists for either
-- table.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op on a table that
-- already has RLS enabled.

ALTER TABLE public."PdpEvent"                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ProductPerformanceProfile" ENABLE ROW LEVEL SECURITY;
