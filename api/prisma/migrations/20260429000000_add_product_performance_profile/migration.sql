-- Add ProductPerformanceProfile table.
-- Stores one rolling 28-day performance snapshot per (product, capturedAt).
-- Add-only, non-destructive. No existing tables are altered.

CREATE TABLE "ProductPerformanceProfile" (
    "id"               TEXT         NOT NULL,
    "productId"        TEXT         NOT NULL,
    "storeId"          TEXT         NOT NULL,
    "capturedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "windowDays"       INTEGER      NOT NULL,
    "windowStart"      TIMESTAMP(3) NOT NULL,
    "windowEnd"        TIMESTAMP(3) NOT NULL,

    -- Traffic
    "sessions"         INTEGER,
    "atcCount"         INTEGER,
    "atcRate"          DOUBLE PRECISION,

    -- Traffic source breakdown (fractions 0–1)
    "trafficOrganic"   DOUBLE PRECISION,
    "trafficPaid"      DOUBLE PRECISION,
    "trafficSocial"    DOUBLE PRECISION,
    "trafficDirect"    DOUBLE PRECISION,
    "trafficOther"     DOUBLE PRECISION,
    "trafficOrdersN"   INTEGER,

    -- Commercial
    "orderCount"       INTEGER      NOT NULL DEFAULT 0,
    "refundCount"      INTEGER,
    "refundRate"       DOUBLE PRECISION,

    -- Variant skew
    "variantSkewPct"   DOUBLE PRECISION,
    "variantOrdersN"   INTEGER,

    -- Classification output
    "archetype"        TEXT         NOT NULL,
    "archetypeConf"    TEXT         NOT NULL,
    "archetypeSignals" JSONB        NOT NULL,
    "dataGaps"         TEXT[]       NOT NULL,

    CONSTRAINT "ProductPerformanceProfile_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "ProductPerformanceProfile"
    ADD CONSTRAINT "ProductPerformanceProfile_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProductPerformanceProfile"
    ADD CONSTRAINT "ProductPerformanceProfile_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Unique constraint: one profile per product per capture timestamp
CREATE UNIQUE INDEX "ProductPerformanceProfile_productId_capturedAt_key"
    ON "ProductPerformanceProfile"("productId", "capturedAt");

-- Index for store-scoped listing queries (dashboard, batch job)
-- The unique index above already covers (productId, capturedAt) prefix lookups.
CREATE INDEX "ProductPerformanceProfile_storeId_capturedAt_idx"
    ON "ProductPerformanceProfile"("storeId", "capturedAt");
