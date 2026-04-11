const SHOPIFY_API_VERSION = '2024-01';

function getNextPageUrl(headers) {
  const link = headers.get('link');
  if (!link) return null;
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

async function shopifyFetchAll(store, firstUrl) {
  const results = [];
  let url = firstUrl;

  while (url) {
    const res = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': store.accessToken }
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify API ${res.status}: ${text}`);
    }

    const data = await res.json();
    const key = Object.keys(data)[0];
    results.push(...data[key]);
    url = getNextPageUrl(res.headers);
  }

  return results;
}

async function fetchProducts(store) {
  const url = `https://${store.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=250`;
  return shopifyFetchAll(store, url);
}

async function fetchOrders(store) {
  const url = `https://${store.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/orders.json?limit=250&status=any`;
  return shopifyFetchAll(store, url);
}

module.exports = { fetchProducts, fetchOrders };
