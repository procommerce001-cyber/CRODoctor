'use strict';

// ---------------------------------------------------------------------------
// anthropic-fetch.js
//
// Minimal Anthropic API fetch helper with one-retry resilience.
// Scope: consumed by CRO LLM generators only. Not a general HTTP client.
//
// callAnthropicWithRetry(body, timeoutMs) → ok Response | null
//
// Retries once on:
//   AbortError  — timeout fired by the per-attempt AbortController
//   TypeError   — network/fetch-level failure before a response arrived
//   HTTP 408 / 429 / 500 / 502 / 503 / 504 — transient server-side errors
//
// Returns null immediately (no retry) on:
//   Any other thrown error (e.g. programming error)
//   Non-retryable 4xx (e.g. 400 bad request, 401 auth, 403 forbidden)
//   Retry also fails
//
// Never throws. Callers treat null as "fall back to template".
// ---------------------------------------------------------------------------

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const RETRYABLE_STATUS  = new Set([408, 429, 500, 502, 503, 504]);

async function callAnthropicWithRetry(body, timeoutMs) {
  async function attempt() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(ANTHROPIC_API_URL, {
        method:  'POST',
        signal:  controller.signal,
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    let res;
    try {
      res = await attempt();
    } catch (e) {
      if (e.name !== 'AbortError' && e.name !== 'TypeError') return null;
      res = await attempt();  // one retry on timeout or network failure
    }
    if (!res.ok) {
      if (!RETRYABLE_STATUS.has(res.status)) return null;
      res = await attempt();  // one retry on retryable HTTP status
      if (!res.ok) return null;
    }
    return res;
  } catch (_) {
    return null;
  }
}

module.exports = { callAnthropicWithRetry };
