'use strict';

// ---------------------------------------------------------------------------
// Shared Prisma include shape for product queries.
// Used by CRO routes, Action Center routes, and server.js product endpoints.
// Single definition — update here, effects propagate everywhere.
// ---------------------------------------------------------------------------

const PRODUCT_INCLUDE = {
  variants: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true, shopifyVariantId: true, title: true, sku: true,
      price: true, compareAtPrice: true, inventoryQuantity: true, availableForSale: true,
    },
  },
  images: {
    orderBy: { position: 'asc' },
    select: { id: true, src: true, altText: true, position: true },
  },
};

module.exports = { PRODUCT_INCLUDE };
