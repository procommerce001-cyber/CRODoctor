'use strict';

// ---------------------------------------------------------------------------
// delta-sync.scheduler.js
//
// Fallback for missed webhooks. Runs every 6 hours and incrementally fetches
// orders and products updated since store.lastSyncAt. On first run (null
// cursor) it performs a full sync, matching the initial-sync behaviour.
//
// Only syncs stores where isActive = true and accessToken is set.
// Updates store.lastSyncAt only after the full store sync succeeds.
// ---------------------------------------------------------------------------

const { fetchProducts, fetchOrders } = require('../services/shopify.service');

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// ---------------------------------------------------------------------------
// runDeltaSync
// ---------------------------------------------------------------------------
async function runDeltaSync(prisma) {
  const stores = await prisma.store.findMany({
    where:  { isActive: true, accessToken: { not: null } },
    select: { id: true, shopDomain: true, accessToken: true, lastSyncAt: true },
  });

  for (const store of stores) {
    await syncStore(prisma, store).catch(err =>
      console.error(`[DeltaSync] store=${store.shopDomain}:`, err.message)
    );
  }
}

async function syncStore(prisma, store) {
  const cursor = store.lastSyncAt ?? null;

  const [products, orders] = await Promise.all([
    fetchProducts(store, cursor),
    fetchOrders(store, cursor),
  ]);

  // ── Products ──────────────────────────────────────────────────────────────
  for (const p of products) {
    const product = await prisma.product.upsert({
      where:  { storeId_shopifyProductId: { storeId: store.id, shopifyProductId: String(p.id) } },
      update: {
        title: p.title, handle: p.handle, status: p.status,
        vendor: p.vendor || null, productType: p.product_type || null,
        tags: p.tags || null, bodyHtml: p.body_html || null,
        publishedAt: p.published_at ? new Date(p.published_at) : null,
        updatedAt:   new Date(p.updated_at),
      },
      create: {
        storeId: store.id, shopifyProductId: String(p.id),
        title: p.title, handle: p.handle, status: p.status,
        vendor: p.vendor || null, productType: p.product_type || null,
        tags: p.tags || null, bodyHtml: p.body_html || null,
        publishedAt: p.published_at ? new Date(p.published_at) : null,
        createdAt:   new Date(p.created_at),
        updatedAt:   new Date(p.updated_at),
      },
      select: { id: true },
    });

    for (const v of (p.variants || [])) {
      await prisma.productVariant.upsert({
        where:  { shopifyVariantId: String(v.id) },
        update: {
          title: v.title, sku: v.sku || null, price: v.price,
          compareAtPrice:    v.compare_at_price   || null,
          inventoryQuantity: v.inventory_quantity ?? null,
          availableForSale:  v.inventory_quantity === null || v.inventory_quantity > 0,
          updatedAt:         new Date(v.updated_at),
        },
        create: {
          productId:         product.id,
          shopifyVariantId:  String(v.id),
          title: v.title, sku: v.sku || null, price: v.price,
          compareAtPrice:    v.compare_at_price   || null,
          inventoryQuantity: v.inventory_quantity ?? null,
          availableForSale:  v.inventory_quantity === null || v.inventory_quantity > 0,
          createdAt:         new Date(v.created_at),
          updatedAt:         new Date(v.updated_at),
        },
      });
    }

    for (const img of (p.images || [])) {
      await prisma.productImage.upsert({
        where:  { shopifyImageId: String(img.id) },
        update: { src: img.src, altText: img.alt || null, position: img.position || 0 },
        create: {
          productId:      product.id,
          shopifyImageId: String(img.id),
          src:            img.src,
          altText:        img.alt || null,
          position:       img.position || 0,
        },
      });
    }
  }

  // ── Orders ────────────────────────────────────────────────────────────────
  for (const o of orders) {
    const shippingAmount = o.total_shipping_price_set?.shop_money?.amount ?? '0';
    const itemCount      = (o.line_items || []).reduce((s, li) => s + li.quantity, 0);

    const savedOrder = await prisma.order.upsert({
      where:  { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: String(o.id) } },
      update: {
        financialStatus:    o.financial_status    || null,
        fulfillmentStatus:  o.fulfillment_status   || null,
        totalDiscounts:     o.total_discounts      || '0',
        totalShippingPrice: shippingAmount,
        totalTax:           o.total_tax            || '0',
        totalPrice:         o.total_price,
        itemCount,
        updatedAt:          new Date(o.updated_at),
        cancelledAt:        o.cancelled_at ? new Date(o.cancelled_at) : null,
      },
      create: {
        storeId:            store.id,
        shopifyOrderId:     String(o.id),
        orderNumber:        o.order_number,
        financialStatus:    o.financial_status    || null,
        fulfillmentStatus:  o.fulfillment_status   || null,
        currency:           o.currency,
        subtotalPrice:      o.subtotal_price       || '0',
        totalDiscounts:     o.total_discounts      || '0',
        totalShippingPrice: shippingAmount,
        totalTax:           o.total_tax            || '0',
        totalPrice:         o.total_price,
        itemCount,
        landingSite:        o.landing_site   || null,
        referringSite:      o.referring_site  || null,
        createdAt:          new Date(o.created_at),
        updatedAt:          new Date(o.updated_at),
        cancelledAt:        o.cancelled_at ? new Date(o.cancelled_at) : null,
      },
    });

    // Batch-resolve internal IDs for line items
    const shopifyProductIds = (o.line_items || [])
      .map(li => li.product_id).filter(Boolean).map(String);
    const shopifyVariantIds = (o.line_items || [])
      .map(li => li.variant_id).filter(Boolean).map(String);

    const [dbProducts, dbVariants] = await Promise.all([
      prisma.product.findMany({
        where:  { storeId: store.id, shopifyProductId: { in: shopifyProductIds } },
        select: { id: true, shopifyProductId: true },
      }),
      prisma.productVariant.findMany({
        where:  { shopifyVariantId: { in: shopifyVariantIds } },
        select: { id: true, shopifyVariantId: true },
      }),
    ]);

    const productMap = Object.fromEntries(dbProducts.map(p => [p.shopifyProductId, p.id]));
    const variantMap = Object.fromEntries(dbVariants.map(v => [v.shopifyVariantId, v.id]));

    for (const li of (o.line_items || [])) {
      await prisma.orderLineItem.upsert({
        where:  { orderId_shopifyLineItemId: { orderId: savedOrder.id, shopifyLineItemId: String(li.id) } },
        update: {
          quantity: li.quantity, price: li.price, totalDiscount: li.total_discount || '0',
          productId: li.product_id ? (productMap[String(li.product_id)] ?? null) : null,
          variantId: li.variant_id ? (variantMap[String(li.variant_id)] ?? null) : null,
        },
        create: {
          orderId:           savedOrder.id,
          productId:         li.product_id ? (productMap[String(li.product_id)] ?? null) : null,
          variantId:         li.variant_id ? (variantMap[String(li.variant_id)] ?? null) : null,
          shopifyLineItemId: String(li.id),
          title:             li.title,
          quantity:          li.quantity,
          price:             li.price,
          totalDiscount:     li.total_discount || '0',
          vendor:            li.vendor || null,
        },
      });
    }
  }

  // Stamp cursor only after this store's full sync succeeds
  await prisma.store.update({
    where: { id: store.id },
    data:  { lastSyncAt: new Date() },
  });

  console.log(`[DeltaSync] store=${store.shopDomain} synced ${products.length} products, ${orders.length} orders`);
}

// ---------------------------------------------------------------------------
// startDeltaSyncScheduler
// Call once at server startup — same pattern as startImpactWindowScheduler.
// ---------------------------------------------------------------------------
function startDeltaSyncScheduler(prisma) {
  runDeltaSync(prisma).catch(err =>
    console.error('[DeltaSync] initial sweep error:', err.message)
  );

  setInterval(() => {
    runDeltaSync(prisma).catch(err =>
      console.error('[DeltaSync] sweep error:', err.message)
    );
  }, SYNC_INTERVAL_MS);

  console.log('[DeltaSync] scheduler started (interval: 6h)');
}

module.exports = { startDeltaSyncScheduler, runDeltaSync };
