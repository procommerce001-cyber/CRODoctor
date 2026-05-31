-- Add reviewed content fields to ActionItem.
-- Phase 2B: persist the exact proposedContent the merchant reviewed when approving.
-- Both columns are nullable — existing rows are unaffected. No data is altered.
ALTER TABLE "ActionItem" ADD COLUMN "reviewedProposedContent" TEXT;
ALTER TABLE "ActionItem" ADD COLUMN "reviewedAt" TIMESTAMP(3);
