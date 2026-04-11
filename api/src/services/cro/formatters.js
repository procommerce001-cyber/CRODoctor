'use strict';

// ---------------------------------------------------------------------------
// CRO Formatters
//
// Shared helpers for converting Prisma models into shapes the CRO engine
// expects. Also provides the safe product serializer used by API responses.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// toCroProduct
// Converts a raw Prisma product (with variants + images) into the lean
// shape expected by the CRO rule check/build functions.
// This is the contract between the DB layer and the engine — never pass
// raw Prisma objects directly into rules.
// ---------------------------------------------------------------------------
function toCroProduct(p) {
  return {
    id:               p.id,
    shopifyProductId: p.shopifyProductId,
    title:            p.title,
    status:           p.status,
    bodyHtml:         p.bodyHtml || null,
    handle:           p.handle,
    vendor:           p.vendor || null,
    productType:      p.productType || null,
    tags:             p.tags || null,
    publishedAt:      p.publishedAt,
    createdAt:        p.createdAt,
    updatedAt:        p.updatedAt,
    images: (p.images || []).map(img => ({
      id:       img.id,
      src:      img.src,
      altText:  img.altText || null,
      position: img.position,
    })),
    variants: (p.variants || []).map(v => ({
      id:                v.id,
      shopifyVariantId:  v.shopifyVariantId,
      title:             v.title,
      sku:               v.sku || null,
      price:             v.price,
      compareAtPrice:    v.compareAtPrice || null,
      inventoryQuantity: v.inventoryQuantity ?? null,
      availableForSale:  v.availableForSale,
    })),
  };
}

// ---------------------------------------------------------------------------
// safeProductResponse
// Strips internal/sensitive fields before returning a product to API clients.
// Never expose accessToken or storeId.
// ---------------------------------------------------------------------------
function safeProductResponse(p) {
  return {
    id:          p.id,
    shopifyId:   p.shopifyProductId,
    title:       p.title,
    description: p.bodyHtml || null,
    handle:      p.handle,
    status:      p.status,
    vendor:      p.vendor || null,
    productType: p.productType || null,
    tags:        p.tags || null,
    publishedAt: p.publishedAt,
    createdAt:   p.createdAt,
    updatedAt:   p.updatedAt,
    images:      (p.images || []).map(img => ({
      id:       img.id,
      src:      img.src,
      altText:  img.altText || null,
      position: img.position,
    })),
    variants: (p.variants || []).map(v => ({
      id:                v.id,
      shopifyId:         v.shopifyVariantId,
      title:             v.title,
      sku:               v.sku || null,
      price:             v.price,
      compareAtPrice:    v.compareAtPrice || null,
      inventoryQuantity: v.inventoryQuantity ?? null,
      availableForSale:  v.availableForSale,
    })),
  };
}

// ---------------------------------------------------------------------------
// safeStoreResponse
// Strips accessToken before returning a store to API clients.
// ---------------------------------------------------------------------------
function safeStoreResponse(store) {
  return {
    id:             store.id,
    name:           store.name,
    shopDomain:     store.shopDomain,
    hasAccessToken: !!store.accessToken,
    createdAt:      store.createdAt,
    updatedAt:      store.updatedAt,
  };
}

module.exports = { toCroProduct, safeProductResponse, safeStoreResponse };
