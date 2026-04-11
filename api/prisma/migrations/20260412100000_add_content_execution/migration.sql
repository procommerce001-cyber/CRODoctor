-- CreateTable: ContentExecution
-- Immutable audit log for content_change apply calls from the Action Center.
-- One row per call. Status: previewed | applied | rolled_back | failed
CREATE TABLE "ContentExecution" (
    "id"                   TEXT NOT NULL,
    "storeId"              TEXT NOT NULL,
    "productId"            TEXT NOT NULL,
    "issueId"              TEXT NOT NULL,
    "selectedVariantIndex" INTEGER,
    "previousContent"      TEXT,
    "newContent"           TEXT NOT NULL,
    "status"               TEXT NOT NULL DEFAULT 'previewed',
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentExecution_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ContentExecution"
    ADD CONSTRAINT "ContentExecution_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Index for efficient per-product lookups
CREATE INDEX "ContentExecution_storeId_productId_idx"
    ON "ContentExecution"("storeId", "productId");
