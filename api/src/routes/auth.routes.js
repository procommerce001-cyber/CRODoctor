'use strict';

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();

const { fetchProducts }                  = require('../services/shopify.service');
const { captureWindowedBeforeSnapshot }  = require('../services/metrics.service');
const { registerWebhooks }               = require('../services/webhook-registration.service');
const { ensureScriptTag }                = require('../services/shopify-admin.service');
const {
  pendingOAuthStates,
  OAUTH_STATE_TTL_MS,
  verifyShopifyHmac,
  isValidShopDomain,
} = require('../lib/shopify-oauth');

const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SCOPES        = process.env.SHOPIFY_SCOPES || 'read_products,write_products,read_orders,read_analytics,write_script_tags';
const APP_BASE_URL  = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const REDIRECT_URI  = `${APP_BASE_URL}/auth/callback`;

// ---------------------------------------------------------------------------
// Background helper — syncs all products for a store, then captures a
// windowed before-snapshot for each one. Finally marks the store COMPLETED.
// Runs entirely outside the request lifecycle; errors are logged, not thrown.
// ---------------------------------------------------------------------------
async function runInitialSync(prisma, store) {
  const tag = `[Auth:InitialSync] store=${store.shopDomain}`;
  let synced = 0;

  // Register webhooks first — non-fatal if it fails
  await registerWebhooks(store, APP_BASE_URL).catch(err =>
    console.error(`${tag} webhook registration failed (non-fatal):`, err.message)
  );

  // Register tracker ScriptTag — non-fatal; APP_BASE_URL must resolve to the API host
  const _trackerUrl = `${APP_BASE_URL}/cro-tracker.js`;
  await ensureScriptTag(store, _trackerUrl).catch(err =>
    console.error(`${tag} script tag registration failed (non-fatal):`, err.message)
  );

  try {
    console.log(`${tag} starting product sync`);
    const shopifyProducts = await fetchProducts(store);

    for (const p of shopifyProducts) {
      const product = await prisma.product.upsert({
        where:  { storeId_shopifyProductId: { storeId: store.id, shopifyProductId: String(p.id) } },
        update: {
          title:       p.title,
          handle:      p.handle,
          status:      p.status,
          vendor:      p.vendor      || null,
          productType: p.product_type || null,
          tags:        p.tags        || null,
          bodyHtml:    p.body_html   || null,
          publishedAt: p.published_at ? new Date(p.published_at) : null,
          updatedAt:   new Date(p.updated_at),
        },
        create: {
          storeId:          store.id,
          shopifyProductId: String(p.id),
          title:            p.title,
          handle:           p.handle,
          status:           p.status,
          vendor:           p.vendor      || null,
          productType:      p.product_type || null,
          tags:             p.tags        || null,
          bodyHtml:         p.body_html   || null,
          publishedAt:      p.published_at ? new Date(p.published_at) : null,
          createdAt:        new Date(p.created_at),
          updatedAt:        new Date(p.updated_at),
        },
        select: { id: true },
      });

      // Upsert variants
      for (const v of (p.variants || [])) {
        await prisma.productVariant.upsert({
          where:  { shopifyVariantId: String(v.id) },
          update: {
            title:             v.title,
            sku:               v.sku || null,
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
            sku:               v.sku || null,
            price:             v.price,
            compareAtPrice:    v.compare_at_price || null,
            inventoryQuantity: v.inventory_quantity ?? null,
            availableForSale:  v.inventory_quantity === null || v.inventory_quantity > 0,
            createdAt:         new Date(v.created_at),
            updatedAt:         new Date(v.updated_at),
          },
        });
      }

      // Upsert images
      for (const img of (p.images || [])) {
        await prisma.productImage.upsert({
          where:  { shopifyImageId: String(img.id) },
          update: { src: img.src, altText: img.alt || null, position: img.position || 0 },
          create: {
            productId:     product.id,
            shopifyImageId: String(img.id),
            src:           img.src,
            altText:       img.alt || null,
            position:      img.position || 0,
          },
        });
      }

      // Capture the 7-day windowed before-snapshot for this product
      try {
        await captureWindowedBeforeSnapshot(prisma, product.id);
      } catch (snapErr) {
        console.warn(`${tag} before-snapshot failed for product=${product.id} (non-fatal):`, snapErr.message);
      }

      synced++;
    }

    console.log(`${tag} synced ${synced} products; marking COMPLETED`);
  } catch (err) {
    console.error(`${tag} sync failed:`, err.message);
    // Still attempt to mark COMPLETED so the UI doesn't hang forever on SYNCING.
    // In production you'd want a more granular error state here.
  }

  await prisma.store.update({
    where: { id: store.id },
    data:  { setupStatus: 'COMPLETED' },
  }).catch(err => console.error(`${tag} failed to set COMPLETED:`, err.message));
}

// ---------------------------------------------------------------------------
// GET /auth/install
// Initiates the Shopify OAuth flow.
// Usage: redirect merchant browser to /auth/install?shop=yourstore.myshopify.com
// ---------------------------------------------------------------------------
router.get('/install', (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(503).json({ error: 'Shopify credentials are not configured on this server.' });
  }

  const { shop } = req.query;
  if (!shop || !isValidShopDomain(shop)) {
    return res.status(400).json({ error: 'Missing or invalid shop parameter (must be *.myshopify.com).' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  pendingOAuthStates.set(state, { shop, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });

  const authUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authUrl.searchParams.set('client_id',    CLIENT_ID);
  authUrl.searchParams.set('scope',        SCOPES);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('state',        state);

  res.redirect(authUrl.toString());
});

// ---------------------------------------------------------------------------
// GET /auth/callback
// Shopify redirects here with ?code=&hmac=&shop=&state=
//
// Flow:
//   1. Validate shop domain, state nonce, HMAC signature
//   2. Exchange code → permanent access token
//   3. Fetch shop.json (name, email, domain)
//   4. Upsert Store — set setupStatus = SYNCING
//   5. Find-or-create User by email, linked to this Store
//   6. Respond 200 immediately (frontend polls/subscribes for COMPLETED)
//   7. Background: sync all products + capture before-snapshots → set COMPLETED
// ---------------------------------------------------------------------------
router.get('/callback', async (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(503).json({ error: 'Shopify credentials are not configured on this server.' });
  }

  const { shop, code, state } = req.query;

  // 1a. Validate shop domain
  if (!shop || !isValidShopDomain(shop)) {
    return res.status(400).json({ error: 'Invalid or missing shop parameter.' });
  }

  // 1b. Validate state nonce (CSRF protection)
  const pending = pendingOAuthStates.get(state);
  if (!pending) {
    return res.status(403).json({ error: 'Invalid or expired state parameter.' });
  }
  if (pending.shop !== shop) {
    return res.status(403).json({ error: 'State/shop mismatch.' });
  }
  if (Date.now() > pending.expiresAt) {
    pendingOAuthStates.delete(state);
    return res.status(403).json({ error: 'OAuth state expired. Please restart the install flow.' });
  }
  pendingOAuthStates.delete(state); // one-time use

  // 1c. Verify HMAC signature
  if (!verifyShopifyHmac(req.query, CLIENT_SECRET)) {
    return res.status(403).json({ error: 'HMAC verification failed.' });
  }

  // 2. Exchange authorization code for permanent access token
  let accessToken;
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error('[Auth] token exchange failed:', tokenRes.status, text);
      return res.status(502).json({ error: 'Token exchange with Shopify failed.', details: text });
    }

    const tokenData = await tokenRes.json();
    accessToken = tokenData.access_token;
    if (!accessToken) {
      return res.status(502).json({ error: 'Shopify returned no access_token.' });
    }
  } catch (err) {
    console.error('[Auth] token exchange error:', err);
    return res.status(500).json({ error: err.message });
  }

  // 3. Fetch shop info (name, contact email, storefront domain)
  let shopData;
  try {
    const shopRes = await fetch(`https://${shop}/admin/api/2023-10/shop.json`, {
      headers: { 'X-Shopify-Access-Token': accessToken },
    });
    if (!shopRes.ok) {
      const text = await shopRes.text();
      return res.status(502).json({ error: 'Failed to fetch shop info after auth.', details: text });
    }
    shopData = (await shopRes.json()).shop;
  } catch (err) {
    console.error('[Auth] shop.json fetch error:', err);
    return res.status(500).json({ error: err.message });
  }

  const prisma = req.app.get('prisma');

  // 4. Upsert Store — set setupStatus = SYNCING so the frontend knows sync has begun
  let store;
  try {
    store = await prisma.store.upsert({
      where:  { shopDomain: shop },
      update: {
        name:        shopData.name,
        shopUrl:     shopData.domain ? `https://${shopData.domain}` : null,
        accessToken,
        setupStatus: 'SYNCING',
        updatedAt:   new Date(),
      },
      create: {
        name:        shopData.name,
        shopDomain:  shop,
        shopUrl:     shopData.domain ? `https://${shopData.domain}` : null,
        accessToken,
        setupStatus: 'SYNCING',
      },
    });
  } catch (err) {
    console.error('[Auth] store upsert error:', err);
    return res.status(500).json({ error: err.message });
  }

  // 5. Find-or-create User by email, linked to this store
  let user;
  const email = shopData.email;
  if (email) {
    try {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        user = existing;
      } else {
        user = await prisma.user.create({
          data: { email, storeId: store.id },
        });
      }
    } catch (err) {
      // Non-fatal — store is saved; log and continue
      console.warn('[Auth] user upsert failed (non-fatal):', err.message);
    }
  }

  // 6. Create server-side session — must save before responding
  req.session.storeId    = store.id;
  req.session.shopDomain = shop;
  req.session.userId     = user?.id ?? null;

  req.session.save(saveErr => {
    if (saveErr) console.error('[Auth] session save error:', saveErr.message);

    res.json({
      success:     true,
      shop,
      storeId:     store.id,
      userId:      user?.id ?? null,
      setupStatus: 'SYNCING',
    });

    // 7. Background: sync products → before-snapshots → set setupStatus = COMPLETED
    setImmediate(() => {
      runInitialSync(prisma, store).catch(err =>
        console.error('[Auth] runInitialSync unhandled error:', err.message)
      );
    });
  });
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------
router.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('[Auth] logout error:', err.message);
      return res.status(500).json({ error: 'Logout failed.' });
    }
    res.clearCookie('cro.sid');
    res.json({ success: true });
  });
});

// ---------------------------------------------------------------------------
// POST /auth/ensure-tracker
// Idempotently registers the CRODoctor ScriptTag on the authenticated store.
// Call this once for existing stores that pre-date automatic registration.
// ---------------------------------------------------------------------------
router.post('/ensure-tracker', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { shopDomain } = req.session;
  try {
    const store = await prisma.store.findUnique({ where: { shopDomain } });
    if (!store || !store.accessToken) {
      return res.status(404).json({ error: 'Store not found or token missing.' });
    }
    const trackerUrl = `${APP_BASE_URL}/cro-tracker.js`;
    const scriptTag  = await ensureScriptTag(store, trackerUrl);
    res.json({ ok: true, scriptTagId: scriptTag?.id ?? null, src: trackerUrl });
  } catch (err) {
    console.error('[Auth] ensure-tracker error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /auth/me
// Returns the current session identity — useful for frontend boot.
// ---------------------------------------------------------------------------
router.get('/me', (req, res) => {
  if (!req.session?.storeId) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  res.json({
    storeId:    req.session.storeId,
    shopDomain: req.session.shopDomain,
    userId:     req.session.userId,
  });
});

module.exports = router;
