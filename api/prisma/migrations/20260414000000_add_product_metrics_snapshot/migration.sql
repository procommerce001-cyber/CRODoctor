-- CreateTable: ProductMetricsSnapshot
-- One row per product per snapshotDate.
-- latestAppliedExecutionId is informational only (no FK constraint — ContentExecution has no PK relation defined in schema).

CREATE TABLE "ProductMetricsSnapshot" (
    "id"                       TEXT NOT NULL,
    "productId"                TEXT NOT NULL,
    "snapshotDate"             TIMESTAMP(3) NOT NULL,
    "orderCount"               INTEGER NOT NULL,
    "unitsSold"                INTEGER NOT NULL,
    "revenue"                  DECIMAL(65,30) NOT NULL,
    "latestAppliedExecutionId" TEXT,
    "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductMetricsSnapshot_pkey" PRIMARY KEY ("id")
);

-- UniqueIndex: one row per product per day
CREATE UNIQUE INDEX "ProductMetricsSnapshot_productId_snapshotDate_key"
    ON "ProductMetricsSnapshot"("productId", "snapshotDate");

-- FK to Product
ALTER TABLE "ProductMetricsSnapshot"
    ADD CONSTRAINT "ProductMetricsSnapshot_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
