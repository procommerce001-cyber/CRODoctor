-- Add referenceExecutionId for audit trail on rolled_back rows.
ALTER TABLE "ContentExecution" ADD COLUMN "referenceExecutionId" TEXT;

-- Replace the full unique index with a partial one that only covers 'applied' rows.
-- This preserves P2002 duplicate-apply protection while allowing a separate
-- 'rolled_back' row to coexist for the same (productId, issueId) pair.
DROP INDEX IF EXISTS "ContentExecution_productId_issueId_key";
CREATE UNIQUE INDEX "ContentExecution_productId_issueId_applied_key"
  ON "ContentExecution" ("productId", "issueId")
  WHERE status = 'applied';
