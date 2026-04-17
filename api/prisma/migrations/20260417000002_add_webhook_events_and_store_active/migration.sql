-- Add isActive flag to Store so app/uninstalled can mark it without destroying data
ALTER TABLE "Store" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;

-- Idempotency log for Shopify webhook deliveries.
-- Unique on webhookId (X-Shopify-Webhook-Id header) — a P2002 on INSERT
-- means we already processed this delivery and should skip it.
CREATE TABLE "WebhookEvent" (
    "id"          TEXT NOT NULL,
    "webhookId"   TEXT NOT NULL,
    "topic"       TEXT NOT NULL,
    "shopDomain"  TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebhookEvent_webhookId_key" ON "WebhookEvent"("webhookId");
