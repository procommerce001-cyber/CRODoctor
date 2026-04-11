-- Harden ContentExecution: add patch audit fields
-- Adds patchMode, anchorUsed, matchedBlock, and resultContent to support
-- deterministic patch modes and safe rollback.

ALTER TABLE "ContentExecution" ADD COLUMN "patchMode"     TEXT;
ALTER TABLE "ContentExecution" ADD COLUMN "anchorUsed"    TEXT;
ALTER TABLE "ContentExecution" ADD COLUMN "matchedBlock"  TEXT;
ALTER TABLE "ContentExecution" ADD COLUMN "resultContent" TEXT;
