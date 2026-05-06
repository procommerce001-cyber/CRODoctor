'use strict';

const express = require('express');
const router  = express.Router();

// Closed set — reject any event name not in this list
const ALLOWED_EVENTS = new Set([
  'pdp_view',
  'scroll_depth',
  'block_viewed',
  'atc_click',
  'checkout_click',
  'pdp_exit',
]);

const MAX_ID_LEN   = 256;
const MAX_META_LEN = 1024; // serialised byte cap on the meta object

// ---------------------------------------------------------------------------
// POST /events/pdp
//
// Public append-only event ingest — called from the storefront pixel.
// Always responds 204 immediately so ingest latency is never on the critical
// path and never blocks ATC / checkout.
//
// Trust model: shop-domain validation against the Store table.
//   Requests for unknown shops are silently discarded.
//   No session, no merchant auth required.
//
// No PII is stored — sessionId and visitorId are opaque client-generated ids.
//
// NOTE: cross-origin CORS for Shopify storefront origins is deferred to
//   Phase 4B when the storefront script is deployed.  For Phase 4A this
//   endpoint is reachable from same-origin and server-to-server calls.
// ---------------------------------------------------------------------------
router.post('/pdp', async (req, res) => {
  // Ack immediately — storefront must never wait on this path
  res.status(204).end();

  const prisma = req.app.get('prisma');

  try {
    const {
      shop,
      shopifyProductId,
      sessionId,
      visitorId,
      event,
      ts,
      meta = {},
    } = req.body ?? {};

    // ── Shape validation ────────────────────────────────────────────────────
    if (typeof shop !== 'string' || !shop.includes('.myshopify.com')) return;

    if (
      typeof shopifyProductId !== 'string' ||
      shopifyProductId.length < 1 ||
      shopifyProductId.length > MAX_ID_LEN
    ) return;

    if (
      typeof sessionId !== 'string' ||
      sessionId.length < 1 ||
      sessionId.length > MAX_ID_LEN
    ) return;

    if (!ALLOWED_EVENTS.has(event)) return;

    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return;

    // ── Optional fields — coerce to null on invalid input, never fail ───────
    const safeVisitorId =
      typeof visitorId === 'string' &&
      visitorId.length > 0 &&
      visitorId.length <= MAX_ID_LEN
        ? visitorId
        : null;

    const safeMeta =
      meta !== null &&
      typeof meta === 'object' &&
      !Array.isArray(meta) &&
      JSON.stringify(meta).length <= MAX_META_LEN
        ? meta
        : {};

    // ── Resolve store — discard silently if unknown ──────────────────────────
    const store = await prisma.store.findUnique({
      where:  { shopDomain: shop },
      select: { id: true },
    });
    if (!store) return;

    // ── Resolve product (best-effort — null is acceptable) ───────────────────
    const product = await prisma.product.findFirst({
      where:  { storeId: store.id, shopifyProductId },
      select: { id: true },
    });

    // ── Promote exposure fields for block_viewed only ────────────────────────
    let executionId = null;
    let blockId     = null;
    if (event === 'block_viewed') {
      const eid = safeMeta.executionId;
      const bid = safeMeta.blockId;
      if (typeof eid === 'string' && eid.length > 0 && eid.length <= MAX_ID_LEN) executionId = eid;
      if (typeof bid === 'string' && bid.length > 0 && bid.length <= MAX_ID_LEN) blockId     = bid;
    }

    // ── Append event row ─────────────────────────────────────────────────────
    await prisma.pdpEvent.create({
      data: {
        storeId:         store.id,
        productId:       product?.id ?? null,
        shopifyProductId,
        sessionId,
        visitorId:       safeVisitorId,
        event,
        issuedAt:        new Date(ts),
        executionId,
        blockId,
        meta:            safeMeta,
      },
    });
  } catch (err) {
    // Log server-side only — never surface errors to the storefront
    console.error('[Events] /pdp ingest error:', err.message);
  }
});

module.exports = router;
