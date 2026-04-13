-- Add baselineExecutionId to ProductMetricsSnapshot
-- Nullable — existing rows unaffected.
-- Links a snapshot to the ContentExecution it was taken for (before or after apply).

ALTER TABLE "ProductMetricsSnapshot"
    ADD COLUMN "baselineExecutionId" TEXT;
