-- Add store-level metric columns to ProductMetricsSnapshot.
-- Nullable so existing rows are unaffected.
-- Populated on phase='before' and phase='after' snapshots to enable store-wide AOV comparison.
ALTER TABLE "ProductMetricsSnapshot" ADD COLUMN "storeRevenue" DECIMAL;
ALTER TABLE "ProductMetricsSnapshot" ADD COLUMN "storeOrderCount" INTEGER;
