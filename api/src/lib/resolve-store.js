'use strict';

// ---------------------------------------------------------------------------
// resolveStore — shared helper for route handlers.
// Validates the ?shop= query param, looks up the store, and writes the
// error response if anything is wrong.
// Returns the store record on success, or null (response already sent).
//
// req is required. When req.session.storeId is set (session-based auth),
// the resolved store.id must match — prevents cross-store data access.
// DEV_BEARER_TOKEN paths have no session, so req.session.storeId is absent
// and the ownership check is skipped (dev-only code path, never production).
// ---------------------------------------------------------------------------

async function resolveStore(prisma, shop, res, req) {
  if (!shop) {
    res.status(400).json({ error: 'shop query param required' });
    return null;
  }
  const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
  if (!store) {
    res.status(404).json({ error: 'Store not found.' });
    return null;
  }
  // Enforce session ownership. Only fires when a real session exists —
  // the DEV_BEARER_TOKEN path bypasses requireSession without setting storeId.
  if (req?.session?.storeId && req.session.storeId !== store.id) {
    res.status(403).json({ error: 'Forbidden.' });
    return null;
  }
  return store;
}

module.exports = { resolveStore };
