'use strict';

// ---------------------------------------------------------------------------
// POST /webhooks/shopify
//
// Single entry-point for all Shopify webhook topics.
// Must be mounted in server.js BEFORE app.use(express.json()) so the raw
// Buffer body is preserved for HMAC verification.
//
// express.raw() is applied per-route here; the rest of the app is unaffected.
// ---------------------------------------------------------------------------

const express = require('express');
const router  = express.Router();

const { verifyWebhookHmac } = require('../lib/shopify-webhook');

const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

router.post('/shopify', express.raw({ type: 'application/json' }), async (req, res) => {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const topic      = req.headers['x-shopify-topic'];
  const shopDomain = req.headers['x-shopify-shop-domain'];
  const webhookId  = req.headers['x-shopify-webhook-id'];

  // Verify HMAC before any processing — uses raw Buffer body
  if (!verifyWebhookHmac(req.body, hmacHeader, CLIENT_SECRET)) {
    return res.status(401).send('Unauthorized');
  }

  // Ack immediately — Shopify requires a 200 within 5 s or it retries
  res.status(200).send('OK');

  const prisma = req.app.get('prisma');

  setImmediate(async () => {
    try {
      // Idempotency: INSERT the webhookId; P2002 = already processed, skip
      if (webhookId) {
        try {
          await prisma.webhookEvent.create({ data: { webhookId, topic, shopDomain } });
        } catch (err) {
          if (err.code === 'P2002') {
            console.log(`[Webhook] duplicate skipped topic=${topic} id=${webhookId}`);
            return;
          }
          throw err;
        }
      }

      let payload;
      try {
        payload = JSON.parse(req.body.toString('utf8'));
      } catch {
        console.error(`[Webhook] invalid JSON topic=${topic} shop=${shopDomain}`);
        return;
      }

      switch (topic) {
        case 'orders/create':    await handleOrderCreate(prisma, shopDomain, payload);  break;
        case 'products/update':  await handleProductUpdate(prisma, shopDomain, payload); break;
        case 'app/uninstalled':  await handleAppUninstalled(prisma, shopDomain);         break;
        default:
          console.warn(`[Webhook] unhandled topic=${topic}`);
      }
    } catch (err) {
      console.error(`[Webhook] error topic=${topic} shop=${shopDomain}:`, err.message);
    }
  });
});

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

async function handleOrderCreate(prisma, shopDomain, o) {
  const store = await prisma.store.findUnique({
    where:  { shopDomain },
    select: { id: true, isActive: true },
  });
  if (!store || !store.isActive) return;

  const shippingAmount = o.total_shipping_price_set?.shop_money?.amount ?? '0';
  const itemCount      = (o.line_items || []).reduce((sum, li) => sum + li.quantity, 0);

  const savedOrder = await prisma.order.upsert({
    where:  { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: String(o.id) } },
    update: {
      financialStatus:    o.financial_status   || null,
      fulfillmentStatus:  o.fulfillment_status  || null,
      totalDiscounts:     o.total_discounts     || '0',
      totalShippingPrice: shippingAmount,
      totalTax:           o.total_tax           || '0',
      totalPrice:         o.total_price,
      itemCount,
      updatedAt:          new Date(o.updated_at),
      cancelledAt:        o.cancelled_at ? new Date(o.cancelled_at) : null,
    },
    create: {
      storeId:            store.id,
      shopifyOrderId:     String(o.id),
      orderNumber:        o.order_number,
      financialStatus:    o.financial_status   || null,
      fulfillmentStatus:  o.fulfillment_status  || null,
      currency:           o.currency,
      subtotalPrice:      o.subtotal_price      || '0',
      totalDiscounts:     o.total_discounts     || '0',
      totalShippingPrice: shippingAmount,
      totalTax:           o.total_tax           || '0',
      totalPrice:         o.total_price,
      itemCount,
      landingSite:        o.landing_site  || null,
      referringSite:      o.referring_site || null,
      createdAt:          new Date(o.created_at),
      updatedAt:          new Date(o.updated_at),
      cancelledAt:        o.cancelled_at ? new Date(o.cancelled_at) : null,
    },
  });

  // Batch-resolve internal product/variant IDs from Shopify IDs
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

  console.log(`[Webhook] orders/create upserted order=${o.id} shop=${shopDomain}`);
}

// ---------------------------------------------------------------------------

async function handleProductUpdate(prisma, shopDomain, p) {
  const store = await prisma.store.findUnique({
    where:  { shopDomain },
    select: { id: true, isActive: true },
  });
  if (!store || !store.isActive) return;

  const product = await prisma.product.upsert({
    where:  { storeId_shopifyProductId: { storeId: store.id, shopifyProductId: String(p.id) } },
    update: {
      title:       p.title,
      handle:      p.handle,
      status:      p.status,
      vendor:      p.vendor       || null,
      productType: p.product_type || null,
      tags:        p.tags         || null,
      bodyHtml:    p.body_html    || null,
      publishedAt: p.published_at ? new Date(p.published_at) : null,
      updatedAt:   new Date(p.updated_at),
    },
    create: {
      storeId:          store.id,
      shopifyProductId: String(p.id),
      title:            p.title,
      handle:           p.handle,
      status:           p.status,
      vendor:           p.vendor       || null,
      productType:      p.product_type || null,
      tags:             p.tags         || null,
      bodyHtml:         p.body_html    || null,
      publishedAt:      p.published_at ? new Date(p.published_at) : null,
      createdAt:        new Date(p.created_at),
      updatedAt:        new Date(p.updated_at),
    },
    select: { id: true },
  });

  for (const v of (p.variants || [])) {
    await prisma.productVariant.upsert({
      where:  { shopifyVariantId: String(v.id) },
      update: {
        title:             v.title,
        sku:               v.sku            || null,
        price:             v.price,
        compareAtPrice:    v.compare_at_price || null,
        inventoryQuantity: v.inventory_quantity ?? null,
        availableForSale:  v.inventory_quantity === null || v.inventory_quantity > 0,
        updatedAt:         new Date(v.updated_at),
      },
      create: {
        productId:         product.id,
        shopifyVariantId:  String(v.id),
        title:             v.title,
        sku:               v.sku            || null,
        price:             v.price,
        compareAtPrice:    v.compare_at_price || null,
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

  console.log(`[Webhook] products/update upserted product=${p.id} shop=${shopDomain}`);
}

// ---------------------------------------------------------------------------

async function handleAppUninstalled(prisma, shopDomain) {
  await prisma.store.update({
    where: { shopDomain },
    data:  { isActive: false, accessToken: null },
  });
  console.log(`[Webhook] app/uninstalled store marked inactive shop=${shopDomain}`);
}

module.exports = router;
