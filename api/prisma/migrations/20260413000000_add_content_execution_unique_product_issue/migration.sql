-- Deduplicate existing rows: keep the most recent record per (productId, issueId),
-- delete all older duplicates.
DELETE FROM "ContentExecution"
WHERE id NOT IN (
  SELECT DISTINCT ON ("productId", "issueId") id
  FROM "ContentExecution"
  ORDER BY "productId", "issueId", "createdAt" DESC
);

-- AddUniqueConstraint: ContentExecution(productId, issueId)
-- Prevents duplicate apply records for the same product+issue pair.
CREATE UNIQUE INDEX IF NOT EXISTS "ContentExecution_productId_issueId_key"
  ON "ContentExecution" ("productId", "issueId");
