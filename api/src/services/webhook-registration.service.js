'use strict';

// ---------------------------------------------------------------------------
// Webhook Registration
//
// Registers the three required Shopify webhook topics for a store immediately
// after OAuth. Called from auth.routes.js inside runInitialSync so it runs
// in the background and never blocks the OAuth response.
//
// Shopify returns 422 when a webhook for that topic + address already exists —
// that is treated as success so re-installs are idempotent.
//
// Required scopes: the app's OAuth scope must include read_orders for
// orders/create and read_products for products/update.
// ---------------------------------------------------------------------------

const API_VERSION = '2024-01';

const TOPICS = [
  'orders/create',
  'products/update',
  'app/uninstalled',
];

/**
 * @param {{ shopDomain: string, accessToken: string }} store
 * @param {string} appBaseUrl  - public HTTPS root of this server (APP_BASE_URL)
 * @returns {Promise<Array<{ topic: string, success: boolean, error?: string }>>}
 */
async function registerWebhooks(store, appBaseUrl) {
  const address = `${appBaseUrl}/webhooks/shopify`;
  const results = [];

  for (const topic of TOPICS) {
    try {
      const res = await fetch(
        `https://${store.shopDomain}/admin/api/${API_VERSION}/webhooks.json`,
        {
          method:  'POST',
          headers: {
            'X-Shopify-Access-Token': store.accessToken,
            'Content-Type':           'application/json',
          },
          body: JSON.stringify({ webhook: { topic, address, format: 'json' } }),
        }
      );

      // 422 = webhook already registered for this topic + address — idempotent
      if (res.ok || res.status === 422) {
        results.push({ topic, success: true });
      } else {
        const text = await res.text();
        console.error(`[WebhookReg] failed to register ${topic}: ${res.status} ${text}`);
        results.push({ topic, success: false, error: text });
      }
    } catch (err) {
      console.error(`[WebhookReg] network error registering ${topic}:`, err.message);
      results.push({ topic, success: false, error: err.message });
    }
  }

  const ok  = results.filter(r => r.success).map(r => r.topic);
  const bad = results.filter(r => !r.success).map(r => r.topic);
  console.log(`[WebhookReg] store=${store.shopDomain} registered=[${ok.join(',')}]${bad.length ? ` FAILED=[${bad.join(',')}]` : ''}`);

  return results;
}

module.exports = { registerWebhooks };
