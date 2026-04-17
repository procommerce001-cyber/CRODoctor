require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { fetchProducts, fetchOrders } = require('./services/shopify.service');
const { makeRequireAuth }            = require('./lib/auth-middleware');
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

// ---------------------------------------------------------------------------
// Shopify OAuth config — sourced from environment, never hardcoded
// ---------------------------------------------------------------------------
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_SCOPES        = process.env.SHOPIFY_SCOPES || 'read_products';

// APP_BASE_URL is the publicly reachable root of this server (e.g. your ngrok
// tunnel URL).  The redirect URI is always derived from it so the host in the
// OAuth request and the host registered in the Shopify App Dashboard are
// guaranteed to match.
// Strip any accidental trailing slash once, at load time.
const APP_BASE_URL         = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const SHOPIFY_REDIRECT_URI = `${APP_BASE_URL}/auth/shopify/callback`;

// ---------------------------------------------------------------------------
// Startup strict validation
// ---------------------------------------------------------------------------

// Hard-stop: localhost can never satisfy Shopify's host-matching requirement.
if (APP_BASE_URL && /localhost|127\.0\.0\.1/.test(APP_BASE_URL)) {
  console.error('FATAL: APP_BASE_URL must be a public URL (ngrok). "localhost" is not allowed by Shopify.');
  process.exit(1);
}

// Derive the host portion for comparison checks.
let _appHost = '';
try {
  _appHost = APP_BASE_URL ? new URL(APP_BASE_URL).host : '';
} catch {
  console.error('FATAL: APP_BASE_URL is not a valid URL:', APP_BASE_URL);
  process.exit(1);
}

const _redirectHost = SHOPIFY_REDIRECT_URI
  ? new URL(SHOPIFY_REDIRECT_URI).host
  : '';

const _hostMatch     = _appHost && _redirectHost && _appHost === _redirectHost;
const _isHttps       = APP_BASE_URL.startsWith('https://');
const _noTrailingSlash = !APP_BASE_URL.endsWith('/');

console.log('');
console.log('=== SHOPIFY DEBUG ===');
console.log('APP_BASE_URL  :', APP_BASE_URL  || '(NOT SET — server will not work)');
console.log('redirect_uri  :', SHOPIFY_REDIRECT_URI || '(EMPTY)');
console.log('authorize_url : https://<shop>/admin/oauth/authorize?client_id=...&redirect_uri=' + encodeURIComponent(SHOPIFY_REDIRECT_URI));
console.log('');
console.log('MATCH STATUS:');
console.log('  APP_BASE_URL vs redirect_uri host    :', _hostMatch   ? 'OK' : 'FAIL — hosts differ');
console.log('  Protocol is https                    :', _isHttps     ? 'OK' : 'FAIL — must be https://');
console.log('  No trailing slash in APP_BASE_URL    :', _noTrailingSlash ? 'OK' : 'FAIL — remove trailing /');
console.log('');
console.log('Paste these EXACTLY into Shopify Dev Dashboard:');
console.log('  App URL                  :', APP_BASE_URL        || '(NOT SET)');
console.log('  Allowed redirection URL  :', SHOPIFY_REDIRECT_URI || '(EMPTY)');
console.log('=====================');
console.log('');

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

// In-memory nonce store — good enough for a single-process MVP.
// Replace with Redis / DB sessions before running multiple server instances.
const pendingOAuthStates = new Map(); // state -> { shop, expiresAt }
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Verify the HMAC signature that Shopify appends to OAuth callback URLs.
 * Shopify docs: https://shopify.dev/docs/apps/build/authentication-authorization/oauth/implement-oauth
 */
function verifyShopifyHmac(query) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;

  const message = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join('&');

  const digest = crypto
    .createHmac('sha256', SHOPIFY_CLIENT_SECRET)
    .update(message)
    .digest('hex');

  // timingSafeEqual requires equal-length buffers — mismatched length means bad input, not a throw
  const digestBuf = Buffer.from(digest);
  const hmacBuf   = Buffer.from(hmac);
  if (digestBuf.length !== hmacBuf.length) return false;
  return crypto.timingSafeEqual(digestBuf, hmacBuf);
}

/**
 * Validate that the shop hostname looks like a real myshopify.com domain.
 * This prevents open-redirect and SSRF attacks.
 */
function isValidShopDomain(shop) {
  return /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop);
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
// Auth middleware
// Requires a valid Bearer token on all protected routes.
// Set API_SECRET in .env. Requests without it receive 401.
// Exempt: /health, /auth/shopify, /auth/shopify/callback
// ---------------------------------------------------------------------------
const requireAuth = makeRequireAuth(process.env.API_SECRET);

// ---------------------------------------------------------------------------
// Middleware — order matters: CORS → JSON → Auth
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(requireAuth);

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
// Shopify OAuth endpoints (new)
// ---------------------------------------------------------------------------

/**
 * Step 1 — Initiate OAuth.
 * Usage: redirect the merchant's browser to GET /auth/shopify?shop=yourstore.myshopify.com
 */
app.get('/auth/shopify', (req, res) => {
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    return res.status(503).json({
      error: 'SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET are not configured on this server.'
    });
  }

  const { shop } = req.query;

  if (!shop || !isValidShopDomain(shop)) {
    return res.status(400).json({ error: 'Missing or invalid shop parameter (must be *.myshopify.com)' });
  }

  // Generate a cryptographically random state nonce to prevent CSRF
  const state = crypto.randomBytes(16).toString('hex');
  pendingOAuthStates.set(state, {
    shop,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS
  });

  const authUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authUrl.searchParams.set('client_id', SHOPIFY_CLIENT_ID);
  authUrl.searchParams.set('scope', SHOPIFY_SCOPES);
  authUrl.searchParams.set('redirect_uri', SHOPIFY_REDIRECT_URI);
  authUrl.searchParams.set('state', state);

  // Per-request strict debug — print exactly what is being sent to Shopify.
  const reqHost = req.headers.host || '(unknown)';
  const tunnelMismatch = _appHost && reqHost !== _appHost;

  console.log('');
  console.log('=== SHOPIFY DEBUG ===');
  console.log('APP_BASE_URL  :', APP_BASE_URL);
  console.log('redirect_uri  :', SHOPIFY_REDIRECT_URI);
  console.log('authorize_url :', authUrl.toString());
  console.log('');
  console.log('Incoming request host :', reqHost);
  console.log('APP_BASE_URL host     :', _appHost);
  if (tunnelMismatch) {
    console.warn('WARNING: request host differs from APP_BASE_URL host.');
    console.warn('  → Your ngrok URL likely changed. Update APP_BASE_URL in .env,');
    console.warn('    update Shopify dashboard, then restart the server.');
  }
  console.log('');
  console.log('MATCH STATUS:');
  console.log('  APP_BASE_URL vs redirect_uri:', _hostMatch ? 'OK' : 'FAIL');
  console.log('  Request host vs APP_BASE_URL:', tunnelMismatch ? `MISMATCH (req=${reqHost} app=${_appHost})` : 'OK');
  console.log('=====================');
  console.log('');

  res.redirect(authUrl.toString());
});

/**
 * Step 2 — OAuth callback.
 * Shopify redirects here with ?code=...&hmac=...&shop=...&state=...
 * We verify the HMAC, exchange the code for a permanent access token, and save it.
 */
app.get('/auth/shopify/callback', async (req, res) => {
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    return res.status(503).json({
      error: 'Shopify credentials are not configured on this server.'
    });
  }

  const { shop, code, state } = req.query;

  // 1. Validate shop domain
  if (!shop || !isValidShopDomain(shop)) {
    return res.status(400).json({ error: 'Invalid or missing shop parameter.' });
  }

  // 2. Validate state nonce (CSRF protection)
  const pending = pendingOAuthStates.get(state);
  if (!pending) {
    return res.status(403).json({ error: 'Invalid or expired state parameter.' });
  }
  if (pending.shop !== shop) {
    return res.status(403).json({ error: 'State/shop mismatch.' });
  }
  if (Date.now() > pending.expiresAt) {
    pendingOAuthStates.delete(state);
    return res.status(403).json({ error: 'OAuth state has expired. Please restart the install flow.' });
  }
  pendingOAuthStates.delete(state); // one-time use

  // 3. Verify HMAC signature from Shopify
  if (!verifyShopifyHmac(req.query)) {
    return res.status(403).json({ error: 'HMAC verification failed.' });
  }

  // 4. Exchange authorization code for permanent access token
  let accessToken;
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code
      })
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error('Shopify token exchange failed:', tokenRes.status, text);
      return res.status(502).json({ error: 'Token exchange with Shopify failed.', details: text });
    }

    const tokenData = await tokenRes.json();
    accessToken = tokenData.access_token;

    if (!accessToken) {
      return res.status(502).json({ error: 'Shopify returned no access_token.' });
    }
  } catch (err) {
    console.error('TOKEN EXCHANGE ERROR:', err);
    return res.status(500).json({ error: err.message });
  }

  // 5. Fetch shop info and persist the store + token
  try {
    const shopifyRes = await fetch(`https://${shop}/admin/api/2023-10/shop.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken }
    });

    if (!shopifyRes.ok) {
      const text = await shopifyRes.text();
      return res.status(502).json({ error: 'Failed to fetch shop info after auth.', details: text });
    }

    const { shop: shopData } = await shopifyRes.json();

    const store = await prisma.store.upsert({
      where: { shopDomain: shop },
      update: { name: shopData.name, accessToken },
      create: { name: shopData.name, shopDomain: shop, accessToken }
    });

    res.json({ message: 'Shop connected successfully via OAuth.', store: safeStore(store) });
  } catch (err) {
    console.error('POST-AUTH STORE SAVE ERROR:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Debug endpoints — non-production only
// Both endpoints are already protected by requireAuth above.
// Additionally blocked entirely in NODE_ENV=production.
// ---------------------------------------------------------------------------

function requireDev(_req, res, next) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found.' });
  }
  next();
}

/**
 * GET /debug/shopify-config
 *
 * Returns the exact values this server will use for OAuth.
 * Does NOT expose the client secret.
 * Protected by requireAuth + blocked in production.
 */
app.get('/debug/shopify-config', requireDev, (_req, res) => {
  // Build a sample authorize URL using a placeholder shop name so you can
  // inspect the full shape of the URL without triggering a real OAuth flow.
  const sampleShop = 'YOUR-STORE.myshopify.com';
  const sampleUrl  = new URL(`https://${sampleShop}/admin/oauth/authorize`);
  sampleUrl.searchParams.set('client_id',    SHOPIFY_CLIENT_ID  || '(NOT SET)');
  sampleUrl.searchParams.set('scope',        SHOPIFY_SCOPES);
  sampleUrl.searchParams.set('redirect_uri', SHOPIFY_REDIRECT_URI);
  sampleUrl.searchParams.set('state',        'SAMPLE_STATE_NONCE');

  res.json({
    APP_BASE_URL:        APP_BASE_URL        || null,
    redirect_uri:        SHOPIFY_REDIRECT_URI || null,
    scopes:              SHOPIFY_SCOPES,
    client_id_prefix:    SHOPIFY_CLIENT_ID   ? `${SHOPIFY_CLIENT_ID.slice(0, 6)}…` : null,
    full_authorize_url:  sampleUrl.toString(),
    dashboard_must_match: {
      app_url:              APP_BASE_URL        || '(NOT SET)',
      allowed_redirect_url: SHOPIFY_REDIRECT_URI || '(EMPTY)',
    },
    warnings: [
      ...(!APP_BASE_URL          ? ['APP_BASE_URL is not set']         : []),
      ...(!SHOPIFY_CLIENT_ID     ? ['SHOPIFY_CLIENT_ID is not set']    : []),
      ...(!SHOPIFY_CLIENT_SECRET ? ['SHOPIFY_CLIENT_SECRET is not set']: []),
      ...(APP_BASE_URL && APP_BASE_URL.includes('localhost')
        ? ['APP_BASE_URL contains "localhost" — Shopify requires a public URL'] : []),
      ...(APP_BASE_URL && APP_BASE_URL.endsWith('/')
        ? ['APP_BASE_URL has a trailing slash — this will cause a double-slash in redirect_uri'] : []),
      ...(APP_BASE_URL && APP_BASE_URL.startsWith('http://')
        ? ['APP_BASE_URL uses http:// — Shopify requires https://'] : []),
    ],
  });
});

// ---------------------------------------------------------------------------
// Debug endpoint
// ---------------------------------------------------------------------------

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
});

module.exports = { app, prisma };
