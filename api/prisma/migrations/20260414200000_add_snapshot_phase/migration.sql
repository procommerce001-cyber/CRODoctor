-- Add phase field to ProductMetricsSnapshot.
-- Existing rows default to "standalone" (unlinked daily snapshots).
-- Drop old (productId, snapshotDate) unique index, replace with (productId, snapshotDate, phase).
-- This allows one "before" and one "after" snapshot per product per day
-- without colliding with each other or the daily standalone snapshot.

ALTER TABLE "ProductMetricsSnapshot"
    ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'standalone';

DROP INDEX "ProductMetricsSnapshot_productId_snapshotDate_key";

CREATE UNIQUE INDEX "ProductMetricsSnapshot_productId_snapshotDate_phase_key"
    ON "ProductMetricsSnapshot"("productId", "snapshotDate", "phase");
