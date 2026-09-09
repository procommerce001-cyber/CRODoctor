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

const { shouldBlockShopifyWrites, createBetaReadOnlyError } = require('./beta-safety.service');

const API_VERSION = '2024-01';

const TOPICS = [
  'orders/create',
  'products/update',
  'app/uninstalled',
];

// Shopify's duplicate-webhook 422 is a Rails uniqueness validation, surfaced as
// e.g. { "errors": { "address": ["for this topic has already been taken"] } }.
// Validation failures (invalid topic, bad address, missing scope) return 422
// with different messages, so the message — not the status — is the signal.
// Returns false on anything unparseable, so unknown 422s fail closed.
const DUPLICATE_SIGNATURE = /already been taken|already exists/i;

function isDuplicateWebhookError(text) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  try {
    const body = JSON.parse(text);
    const errors = body && body.errors;
    if (!errors) return false;
    const flat = typeof errors === 'string' ? errors : JSON.stringify(errors);
    return DUPLICATE_SIGNATURE.test(flat);
  } catch {
    return false; // malformed body — do not assume duplicate
  }
}

// Keep error detail useful for debugging but bounded, and never echo request
// headers or credentials (Shopify error bodies do not contain the token, but
// the response is untrusted input).
function sanitizeError(text) {
  if (typeof text !== 'string') return 'non-text error response';
  const trimmed = text.trim();
  if (trimmed === '') return 'empty error response';
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/**
 * @param {{ shopDomain: string, accessToken: string }} store
 * @param {string} appBaseUrl  - public HTTPS root of this server (APP_BASE_URL)
 * @returns {Promise<Array<{ topic: string, success: boolean, error?: string }>>}
 */
async function registerWebhooks(store, appBaseUrl) {
  // Mandatory chokepoint guard: each topic below is a POST to webhooks.json via
  // raw fetch, so it does NOT pass through shopifyFetch's mutation gate.
  // Fail closed once, before the loop, so a blocked run registers nothing at
  // all. This does NOT make registration atomic: when writes are permitted, a
  // failure partway through the loop still leaves earlier topics registered.
  // Shopify's 422-on-duplicate is what makes re-running safe.
  //
  // Operational effect when blocked: no webhook subscriptions are created, so
  // the app receives no orders/create, products/update, or app/uninstalled
  // events. The caller (auth.routes.js) already treats failure as non-fatal, so
  // OAuth install still completes. Whether blocking is the right posture for a
  // real merchant is the open webhook lifecycle decision — this guard only
  // makes the behaviour explicit and observable instead of silently bypassing.
  if (shouldBlockShopifyWrites()) {
    throw createBetaReadOnlyError();
  }

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

      if (res.ok) {
        results.push({ topic, success: true });
      } else if (res.status === 422) {
        // Shopify returns 422 both for "already registered" AND for genuine
        // validation errors (invalid topic, bad address, missing scope). The
        // status alone cannot tell them apart — only the body can. Treat as
        // idempotent success ONLY on a confirmed duplicate; anything else,
        // including a body we cannot parse, fails closed.
        const text = await res.text();
        if (isDuplicateWebhookError(text)) {
          results.push({ topic, success: true, duplicate: true });
        } else {
          const detail = sanitizeError(text);
          console.error(`[WebhookReg] 422 (not a duplicate) for ${topic}: ${detail}`);
          results.push({ topic, success: false, error: detail });
        }
      } else {
        const detail = sanitizeError(await res.text());
        console.error(`[WebhookReg] failed to register ${topic}: ${res.status} ${detail}`);
        results.push({ topic, success: false, error: detail });
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
