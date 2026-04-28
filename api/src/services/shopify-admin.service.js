'use strict';

// ---------------------------------------------------------------------------
// Shopify Admin REST API client
// Uses the per-store accessToken already stored in the database.
// All theme operations target a DRAFT theme — never the published one.
// ---------------------------------------------------------------------------

const API_VERSION = '2024-01';

function baseUrl(shopDomain) {
  return `https://${shopDomain}/admin/api/${API_VERSION}`;
}

function headers(accessToken) {
  return {
    'X-Shopify-Access-Token': accessToken,
    'Content-Type': 'application/json',
  };
}

async function shopifyFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API ${res.status} — ${url}\n${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

async function listThemes(store) {
  const data = await shopifyFetch(
    `${baseUrl(store.shopDomain)}/themes.json`,
    { headers: headers(store.accessToken) }
  );
  return data.themes; // [{ id, name, role: 'main'|'unpublished'|'demo' }]
}

async function getPublishedTheme(store) {
  const themes = await listThemes(store);
  return themes.find(t => t.role === 'main') || null;
}

async function getDraftTheme(store) {
  const themes = await listThemes(store);
  // Use the first unpublished theme — or the one named "CRODoctor Draft"
  return themes.find(t => t.role === 'unpublished' && t.name.includes('CRODoctor')) ||
         themes.find(t => t.role === 'unpublished') ||
         null;
}

async function duplicateTheme(store, sourceThemeId, newName = 'CRODoctor Draft') {
  // Shopify does not have a direct "duplicate theme" REST endpoint.
  // Strategy: copy all asset files from source to a new theme.
  // We create the new theme first (Shopify creates a blank one),
  // then bulk-copy assets. This is the safe, API-compliant approach.
  const { theme } = await shopifyFetch(
    `${baseUrl(store.shopDomain)}/themes.json`,
    {
      method: 'POST',
      headers: headers(store.accessToken),
      body: JSON.stringify({ theme: { name: newName, role: 'unpublished', src: null } }),
    }
  );
  return theme;
}

// ---------------------------------------------------------------------------
// Theme Assets
// ---------------------------------------------------------------------------

async function listAssets(store, themeId) {
  const data = await shopifyFetch(
    `${baseUrl(store.shopDomain)}/themes/${themeId}/assets.json`,
    { headers: headers(store.accessToken) }
  );
  return data.assets; // [{ key, public_url, created_at, updated_at, size }]
}

async function getAsset(store, themeId, assetKey) {
  const data = await shopifyFetch(
    `${baseUrl(store.shopDomain)}/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(assetKey)}`,
    { headers: headers(store.accessToken) }
  );
  return data.asset; // { key, value (text) or attachment (base64), content_type }
}

async function putAsset(store, themeId, assetKey, value) {
  const { asset } = await shopifyFetch(
    `${baseUrl(store.shopDomain)}/themes/${themeId}/assets.json`,
    {
      method: 'PUT',
      headers: headers(store.accessToken),
      body: JSON.stringify({ asset: { key: assetKey, value } }),
    }
  );
  return asset;
}

async function deleteAsset(store, themeId, assetKey) {
  const res = await fetch(
    `${baseUrl(store.shopDomain)}/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(assetKey)}`,
    { method: 'DELETE', headers: headers(store.accessToken) }
  );
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Delete asset failed: ${res.status} — ${text}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Product Content (for CONTENT_CHANGE patches)
// ---------------------------------------------------------------------------

async function updateProductDescription(store, shopifyProductId, bodyHtml) {
  const { product } = await shopifyFetch(
    `${baseUrl(store.shopDomain)}/products/${shopifyProductId}.json`,
    {
      method: 'PUT',
      headers: headers(store.accessToken),
      body: JSON.stringify({ product: { id: shopifyProductId, body_html: bodyHtml } }),
    }
  );
  return product;
}

async function updateImageAltText(store, shopifyProductId, imageId, altText) {
  const { image } = await shopifyFetch(
    `${baseUrl(store.shopDomain)}/products/${shopifyProductId}/images/${imageId}.json`,
    {
      method: 'PUT',
      headers: headers(store.accessToken),
      body: JSON.stringify({ image: { id: imageId, alt: altText } }),
    }
  );
  return image;
}

// ---------------------------------------------------------------------------
// Theme preview URL helper
// ---------------------------------------------------------------------------

function previewUrl(store, draftThemeId) {
  return `https://${store.shopDomain}?preview_theme_id=${draftThemeId}`;
}

// ---------------------------------------------------------------------------
// fetchOrderMetrics
// Fetches all paid, non-cancelled orders from the last `periodDays` days.
// Returns aggregated revenue, order count, AOV, and currency.
// Used by the CRO report to replace generic % estimates with real £/$ figures.
// ---------------------------------------------------------------------------

async function fetchOrderMetrics(store, periodDays = 90) {
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

  let orders  = [];
  let nextUrl = `${baseUrl(store.shopDomain)}/orders.json`
    + `?status=any&financial_status=paid`
    + `&created_at_min=${encodeURIComponent(since)}`
    + `&limit=250`
    + `&fields=id,total_price,currency,cancelled_at`;

  while (nextUrl) {
    const res = await fetch(nextUrl, { headers: headers(store.accessToken) });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify orders API ${res.status}: ${text}`);
    }
    const data      = await res.json();
    orders          = orders.concat(data.orders || []);
    const link      = res.headers.get('link') || '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl         = nextMatch ? nextMatch[1] : null;
  }

  // Exclude orders that were later cancelled (financial_status=paid but cancelled_at set)
  const valid   = orders.filter(o => !o.cancelled_at);
  const revenue = valid.reduce((sum, o) => sum + parseFloat(o.total_price || 0), 0);
  const count   = valid.length;

  return {
    periodDays,
    orderCount:   count,
    totalRevenue: Math.round(revenue * 100) / 100,
    aov:          count > 0 ? Math.round((revenue / count) * 100) / 100 : 0,
    currency:     valid[0]?.currency || orders[0]?.currency || 'USD',
  };
}

// ---------------------------------------------------------------------------
// shopifyGraphQL — thin Admin GraphQL API wrapper.
// Reuses the same per-store accessToken and API version as the REST client.
// ---------------------------------------------------------------------------
async function shopifyGraphQL(store, query, variables = {}) {
  return shopifyFetch(
    `${baseUrl(store.shopDomain)}/graphql.json`,
    {
      method:  'POST',
      headers: headers(store.accessToken),
      body:    JSON.stringify({ query, variables }),
    }
  );
}

// ---------------------------------------------------------------------------
// fetchWindowedStoreAnalytics
//
// Fetches store-wide session count from Shopify Analytics (ShopifyQL) for a
// given measurement window. Requires the read_analytics scope.
//
// Returns { sessions: number } on success.
// Returns { sessions: null } on any failure (missing scope, plan limitation,
// API error, parse error) — never throws. Callers treat null as "unavailable".
//
// windowStart / windowEnd: Date objects at UTC midnight.
// ShopifyQL SINCE/UNTIL are both date-inclusive, so UNTIL = windowEnd - 1 day
// to match our [windowStart, windowEnd) half-open UTC windows.
//
// Only sessions are fetched here. Conversion rate is derived later in the
// measurement layer as storeOrderCount / storeSessions, using our own order
// data as the numerator for full transparency.
// ---------------------------------------------------------------------------
async function fetchWindowedStoreAnalytics(store, windowStart, windowEnd) {
  try {
    const since = windowStart.toISOString().slice(0, 10);
    const untilDate = new Date(windowEnd);
    untilDate.setUTCDate(untilDate.getUTCDate() - 1);
    const until = untilDate.toISOString().slice(0, 10);

    const gqlQuery = `
      mutation FetchStoreSessions($ql: String!) {
        shopifyqlQuery(query: $ql) {
          tableData {
            unformattedData {
              headers { name }
              rows
            }
          }
          parseErrors { code message }
        }
      }
    `;

    const data = await shopifyGraphQL(store, gqlQuery, {
      ql: `FROM sessions SINCE ${since} UNTIL ${until} SELECT sum(sessions)`,
    });

    const result = data?.data?.shopifyqlQuery;

    if (!result) return { sessions: null };

    if (result.parseErrors?.length > 0) {
      console.warn('[Analytics] ShopifyQL parse error:', result.parseErrors[0]?.message);
      return { sessions: null };
    }

    const rows = result.tableData?.unformattedData?.rows ?? [];
    if (!rows.length || !rows[0]?.length) return { sessions: null };

    const sessions = parseInt(rows[0][0], 10);
    return { sessions: Number.isFinite(sessions) ? sessions : null };
  } catch (err) {
    console.warn('[Analytics] fetchWindowedStoreAnalytics failed (non-fatal):', err.message);
    return { sessions: null };
  }
}

module.exports = {
  listThemes,
  getPublishedTheme,
  getDraftTheme,
  duplicateTheme,
  listAssets,
  getAsset,
  putAsset,
  deleteAsset,
  updateImageAltText,
  previewUrl,
  fetchOrderMetrics,
  shopifyGraphQL,
  fetchWindowedStoreAnalytics,
};
