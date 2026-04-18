require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { PrismaClient } = require('@prisma/client');
const { fetchProducts, fetchOrders } = require('./services/shopify.service');
const { requireSession }             = require('./lib/auth-middleware');
const { startImpactWindowScheduler } = require('./scheduler/impact-window.scheduler');
const { startDeltaSyncScheduler }    = require('./scheduler/delta-sync.scheduler');
const webhooksRouter       = require('./routes/webhooks.routes');
const authRouter           = require('./routes/auth.routes');
const croRouter            = require('./routes/cro.routes');
const actionCenterRouter   = require('./routes/action-center.routes');
const metricsRouter        = require('./routes/metrics.routes');
const dashboardRouter      = require('./routes/dashboard.routes');
const decisionEngineRouter = require('./routes/decision-engine.routes');

const app = express();
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL + '?connection_limit=10&pool_timeout=10' } },
});

// Make prisma available to routers via app.get('prisma')
app.set('prisma', prisma);
const PORT = process.env.PORT || 3000;

const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');


// ---------------------------------------------------------------------------
// Safe store serializer — never expose the access token to API clients
// ---------------------------------------------------------------------------
function safeStore(store) {
  return {
    id:             store.id,
    name:           store.name,
    shopDomain:     store.shopDomain,
    hasAccessToken: !!store.accessToken,
    createdAt:      store.createdAt,
    updatedAt:      store.updatedAt,
  };
}


// ---------------------------------------------------------------------------
// CORS — restrict to configured frontend origin(s) only
// ---------------------------------------------------------------------------
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';

app.use(cors({
  origin: (origin, callback) => {
    // Allow same-origin / server-to-server requests (no Origin header)
    if (!origin) return callback(null, true);
    if (origin === ALLOWED_ORIGIN) return callback(null, true);
    callback(new Error(`CORS: origin "${origin}" is not allowed`));
  },
  credentials: true,
}));

// ---------------------------------------------------------------------------
// Middleware — order matters: CORS → Session → JSON → Auth
// ---------------------------------------------------------------------------
// Webhook router must be mounted before express.json() so the raw Buffer body
// is intact for Shopify HMAC verification. It handles its own body parsing.
app.use('/webhooks', webhooksRouter);

app.use(session({
  store: new PgSession({
    conString: process.env.DATABASE_URL,
    tableName: 'session',
    pruneSessionInterval: 60 * 60, // prune expired sessions every hour
  }),
  name:   'cro.sid',
  secret: process.env.SESSION_SECRET || 'dev-fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

app.use(express.json());
app.use(requireSession);

// ---------------------------------------------------------------------------
// Existing endpoints — unchanged
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/stores', async (req, res) => {
  try {
    const stores = await prisma.store.findMany({
      orderBy: { createdAt: 'desc' }
    });
    res.json(stores.map(safeStore));
  } catch (err) {
    console.error('GET STORES ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/stores', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Name is required' });
    }

    const store = await prisma.store.create({
      data: { name }
    });

    res.json(safeStore(store));
  } catch (err) {
    console.error('CREATE STORE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

// Kept for backward compatibility — works if a token is already known.
app.post('/connect-shopify', async (req, res) => {
  try {
    const { shopDomain, accessToken } = req.body;

    if (!shopDomain || !accessToken) {
      return res.status(400).json({ error: 'shopDomain and accessToken are required' });
    }

    const shopifyRes = await fetch(`https://${shopDomain}/admin/api/2023-10/shop.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken }
    });

    if (!shopifyRes.ok) {
      const text = await shopifyRes.text();
      return res.status(502).json({ error: `Shopify API error: ${shopifyRes.status}`, details: text });
    }

    const { shop } = await shopifyRes.json();

    const store = await prisma.store.upsert({
      where: { shopDomain },
      update: { name: shop.name, accessToken },
      create: { name: shop.name, shopDomain, accessToken }
    });

    res.json(safeStore(store));
  } catch (err) {
    console.error('CONNECT SHOPIFY ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Debug endpoints — non-production only
// ---------------------------------------------------------------------------

function requireDev(_req, res, next) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found.' });
  }
  next();
}


app.get('/debug/store', requireDev, async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop query param required' });

  try {
    const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return res.json({ exists: false });
    res.json({ exists: true, hasToken: !!store.accessToken, name: store.name, shopDomain: store.shopDomain });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Product endpoints
// ---------------------------------------------------------------------------

app.get('/products', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop query param required' });

  try {
    const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return res.status(404).json({ error: 'Store not found' });

    const products = await prisma.product.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      include: {
        variants: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            shopifyVariantId: true,
            title: true,
            sku: true,
            price: true,
            compareAtPrice: true,
            inventoryQuantity: true,
            availableForSale: true,
          },
        },
        images: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            src: true,
            altText: true,
            position: true,
          },
        },
      },
    });

    res.json({ shop, total: products.length, products: products.map(formatProduct) });
  } catch (err) {
    console.error('GET PRODUCTS ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/products/:id', async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: {
        variants: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            shopifyVariantId: true,
            title: true,
            sku: true,
            price: true,
            compareAtPrice: true,
            inventoryQuantity: true,
            availableForSale: true,
          },
        },
        images: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            src: true,
            altText: true,
            position: true,
          },
        },
      },
    });

    if (!product) return res.status(404).json({ error: 'Product not found' });

    res.json(formatProduct(product));
  } catch (err) {
    console.error('GET PRODUCT ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

function formatProduct(p) {
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
    images:      p.images,
    variants:    p.variants.map(v => ({
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
// CRO routes (mounted from src/routes/cro.routes.js)
// ---------------------------------------------------------------------------

app.use('/auth', authRouter);
app.use('/cro', croRouter);
app.use('/action-center', actionCenterRouter);
app.use('/metrics', metricsRouter);
app.use('/dashboard', dashboardRouter);
app.use('/decision-engine', decisionEngineRouter);

// ---------------------------------------------------------------------------
// Sync endpoints
// ---------------------------------------------------------------------------

app.post('/sync/products', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop query param required' });

  try {
    const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return res.status(404).json({ error: 'Store not found' });
    if (!store.accessToken) return res.status(400).json({ error: 'Store has no access token' });

    const shopifyProducts = await fetchProducts(store);

    let syncedProducts = 0, syncedVariants = 0, syncedImages = 0;

    for (const p of shopifyProducts) {
      const product = await prisma.product.upsert({
        where: { storeId_shopifyProductId: { storeId: store.id, shopifyProductId: String(p.id) } },
        update: {
          title: p.title,
          handle: p.handle,
          status: p.status,
          vendor: p.vendor || null,
          productType: p.product_type || null,
          tags: p.tags || null,
          bodyHtml: p.body_html || null,
          publishedAt: p.published_at ? new Date(p.published_at) : null,
          updatedAt: new Date(p.updated_at)
        },
        create: {
          storeId: store.id,
          shopifyProductId: String(p.id),
          title: p.title,
          handle: p.handle,
          status: p.status,
          vendor: p.vendor || null,
          productType: p.product_type || null,
          tags: p.tags || null,
          bodyHtml: p.body_html || null,
          publishedAt: p.published_at ? new Date(p.published_at) : null,
          createdAt: new Date(p.created_at),
          updatedAt: new Date(p.updated_at)
        }
      });
      syncedProducts++;

      for (const v of (p.variants || [])) {
        await prisma.productVariant.upsert({
          where: { shopifyVariantId: String(v.id) },
          update: {
            title: v.title,
            sku: v.sku || null,
            price: v.price,
            compareAtPrice: v.compare_at_price || null,
            inventoryQuantity: v.inventory_quantity ?? null,
            availableForSale: (v.inventory_quantity === null || v.inventory_quantity > 0),
            updatedAt: new Date(v.updated_at)
          },
          create: {
            productId: product.id,
            shopifyVariantId: String(v.id),
            title: v.title,
            sku: v.sku || null,
            price: v.price,
            compareAtPrice: v.compare_at_price || null,
            inventoryQuantity: v.inventory_quantity ?? null,
            availableForSale: (v.inventory_quantity === null || v.inventory_quantity > 0),
            createdAt: new Date(v.created_at),
            updatedAt: new Date(v.updated_at)
          }
        });
        syncedVariants++;
      }

      for (const img of (p.images || [])) {
        await prisma.productImage.upsert({
          where: { shopifyImageId: String(img.id) },
          update: { src: img.src, altText: img.alt || null, position: img.position || 0 },
          create: {
            productId: product.id,
            shopifyImageId: String(img.id),
            src: img.src,
            altText: img.alt || null,
            position: img.position || 0
          }
        });
        syncedImages++;
      }
    }

    res.json({ success: true, synced: { products: syncedProducts, variants: syncedVariants, images: syncedImages } });
  } catch (err) {
    console.error('SYNC PRODUCTS ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/sync/orders', async (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).json({ error: 'shop query param required' });

  try {
    const store = await prisma.store.findUnique({ where: { shopDomain: shop } });
    if (!store) return res.status(404).json({ error: 'Store not found' });
    if (!store.accessToken) return res.status(400).json({ error: 'Store has no access token' });

    const shopifyOrders = await fetchOrders(store);

    // Batch-lookup internal product/variant IDs to avoid N+1 queries
    const shopifyProductIds = [...new Set(shopifyOrders.flatMap(o =>
      o.line_items.map(li => li.product_id).filter(Boolean).map(String)
    ))];
    const shopifyVariantIds = [...new Set(shopifyOrders.flatMap(o =>
      o.line_items.map(li => li.variant_id).filter(Boolean).map(String)
    ))];

    const dbProducts = await prisma.product.findMany({
      where: { storeId: store.id, shopifyProductId: { in: shopifyProductIds } },
      select: { id: true, shopifyProductId: true }
    });
    const dbVariants = await prisma.productVariant.findMany({
      where: { shopifyVariantId: { in: shopifyVariantIds } },
      select: { id: true, shopifyVariantId: true }
    });

    const productMap = Object.fromEntries(dbProducts.map(p => [p.shopifyProductId, p.id]));
    const variantMap = Object.fromEntries(dbVariants.map(v => [v.shopifyVariantId, v.id]));

    let syncedOrders = 0, syncedLineItems = 0;

    for (const o of shopifyOrders) {
      const shippingAmount = o.total_shipping_price_set?.shop_money?.amount ?? '0';
      const itemCount = o.line_items.reduce((sum, li) => sum + li.quantity, 0);

      const savedOrder = await prisma.order.upsert({
        where: { storeId_shopifyOrderId: { storeId: store.id, shopifyOrderId: String(o.id) } },
        update: {
          financialStatus: o.financial_status || null,
          fulfillmentStatus: o.fulfillment_status || null,
          totalDiscounts: o.total_discounts || '0',
          totalShippingPrice: shippingAmount,
          totalTax: o.total_tax || '0',
          totalPrice: o.total_price,
          itemCount,
          updatedAt: new Date(o.updated_at),
          cancelledAt: o.cancelled_at ? new Date(o.cancelled_at) : null
        },
        create: {
          storeId: store.id,
          shopifyOrderId: String(o.id),
          orderNumber: o.order_number,
          financialStatus: o.financial_status || null,
          fulfillmentStatus: o.fulfillment_status || null,
          currency: o.currency,
          subtotalPrice: o.subtotal_price || '0',
          totalDiscounts: o.total_discounts || '0',
          totalShippingPrice: shippingAmount,
          totalTax: o.total_tax || '0',
          totalPrice: o.total_price,
          itemCount,
          landingSite: o.landing_site || null,
          referringSite: o.referring_site || null,
          createdAt: new Date(o.created_at),
          updatedAt: new Date(o.updated_at),
          cancelledAt: o.cancelled_at ? new Date(o.cancelled_at) : null
        }
      });
      syncedOrders++;

      for (const li of (o.line_items || [])) {
        await prisma.orderLineItem.upsert({
          where: { orderId_shopifyLineItemId: { orderId: savedOrder.id, shopifyLineItemId: String(li.id) } },
          update: { quantity: li.quantity, price: li.price, totalDiscount: li.total_discount || '0' },
          create: {
            orderId: savedOrder.id,
            productId: li.product_id ? (productMap[String(li.product_id)] ?? null) : null,
            variantId: li.variant_id ? (variantMap[String(li.variant_id)] ?? null) : null,
            shopifyLineItemId: String(li.id),
            title: li.title,
            quantity: li.quantity,
            price: li.price,
            totalDiscount: li.total_discount || '0',
            vendor: li.vendor || null
          }
        });
        syncedLineItems++;
      }
    }

    res.json({ success: true, synced: { orders: syncedOrders, lineItems: syncedLineItems } });
  } catch (err) {
    console.error('SYNC ORDERS ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startImpactWindowScheduler(prisma);
  startDeltaSyncScheduler(prisma);
});

module.exports = { app, prisma };
