'use strict';

// ---------------------------------------------------------------------------
// resolveStore — shared helper for route handlers.
// Validates the ?shop= query param, looks up the store, and writes the
// error response if anything is wrong.
// Returns the store record on success, or null (response already sent).
// ---------------------------------------------------------------------------

async function resolveStore(prisma, shop, res) {
  if (!shop) {
    res.status(400).json({ error: 'shop query param required' });
    return null;
  }
  const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
  if (!store) {
    res.status(404).json({ error: 'Store not found.' });
    return null;
  }
  return store;
}

module.exports = { resolveStore };
