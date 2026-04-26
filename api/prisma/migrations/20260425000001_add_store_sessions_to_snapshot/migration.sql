-- Add store-wide session count column to ProductMetricsSnapshot.
-- Nullable so existing rows are unaffected.
-- Populated on phase='before' and phase='after' snapshots when read_analytics scope is granted.
ALTER TABLE "ProductMetricsSnapshot" ADD COLUMN "storeSessions" INTEGER;
