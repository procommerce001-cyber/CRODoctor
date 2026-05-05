-- Add product-level session and ATC columns to ProductMetricsSnapshot.
-- Both nullable so existing rows and standalone/all-time snapshots are unaffected.
-- Populated on phase='before' and phase='after' snapshots when read_analytics scope is granted.
ALTER TABLE "ProductMetricsSnapshot" ADD COLUMN "productSessions" INTEGER;
ALTER TABLE "ProductMetricsSnapshot" ADD COLUMN "productAtcCount" INTEGER;
