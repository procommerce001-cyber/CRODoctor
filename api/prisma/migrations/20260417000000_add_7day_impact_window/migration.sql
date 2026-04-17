-- Add 7-day impact window fields.
--
-- ProductMetricsSnapshot: windowStart / windowEnd mark the date range a
-- snapshot covers. Null on legacy all-time cumulative rows — no data loss.
--
-- ContentExecution: afterReadyAt records the timestamp (appliedAt + 7 days)
-- at which the after-window is complete and the after-snapshot can be captured.
-- Null on non-apply rows (previewed, rolled_back).

ALTER TABLE "ProductMetricsSnapshot"
    ADD COLUMN "windowStart" TIMESTAMP(3),
    ADD COLUMN "windowEnd"   TIMESTAMP(3);

ALTER TABLE "ContentExecution"
    ADD COLUMN "afterReadyAt" TIMESTAMP(3);
