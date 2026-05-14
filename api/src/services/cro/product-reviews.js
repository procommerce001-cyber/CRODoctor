'use strict';

// ---------------------------------------------------------------------------
// product-reviews.js
//
// Transient VOC (voice-of-customer) helper for weak_desire_creation enrichment.
// Scope: fetches 2–3 review excerpts at generation time. Never persisted.
//
// fetchProductReviews(storeObj, product) → Promise<string[]>
//
// Returns an array of 2–3 plain-text review excerpts, or [] on any failure,
// insufficient data, or when no review metafields are found.
// Never throws.
// ---------------------------------------------------------------------------

const TIMEOUT_MS       = 5_000;
const EXCERPT_MAX_LEN  = 150;   // chars — truncated at word boundary
const MIN_TEXT_LEN     = 30;    // below this → noise, not buyer language
const MAX_CANDIDATES   = 10;    // fetch at most this many raw candidates
const MAX_EXCERPTS     = 3;     // inject at most 3 into the prompt
const MIN_EXCERPTS     = 2;     // need at least 2; a single excerpt risks over-anchoring

// Shopify review apps that store review text as product metafields.
// Checked in order; first matching namespace with usable text wins.
const REVIEW_NAMESPACES = new Set([
  'product_reviews', // Shopify native (current)
  'spr',             // Shopify Product Reviews (legacy)
  'reviews',         // generic
  'judge-me',        // Judge.me
  'judgeme',         // Judge.me (alternate slug)
  'loox',            // Loox
]);

// ---------------------------------------------------------------------------
// extractReviewTexts
// Pulls plain-text review bodies out of a raw metafield value string.
// Handles: JSON array of review objects, JSON object with reviews array,
// and plain text (treated as a single excerpt).
// ---------------------------------------------------------------------------
function extractReviewTexts(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') return [];

  const texts = [];

  try {
    const parsed = JSON.parse(rawValue);

    if (Array.isArray(parsed)) {
      for (const item of parsed.slice(0, MAX_CANDIDATES)) {
        if (typeof item === 'string') {
          texts.push(item);
        } else if (item && typeof item === 'object') {
          const body = item.body ?? item.text ?? item.content ?? item.review_text ?? item.message ?? null;
          if (body && typeof body === 'string') texts.push(body);
        }
      }
    } else if (parsed && typeof parsed === 'object') {
      const arr = parsed.reviews ?? parsed.data ?? parsed.items ?? null;
      if (Array.isArray(arr)) {
        for (const item of arr.slice(0, MAX_CANDIDATES)) {
          const body = item.body ?? item.text ?? item.content ?? item.review_text ?? null;
          if (body && typeof body === 'string') texts.push(body);
        }
      }
    }
  } catch (_) {
    // Not JSON — treat the raw value itself as candidate text.
    texts.push(rawValue);
  }

  return texts;
}

// ---------------------------------------------------------------------------
// truncateAtWord — trim to maxLen at the last space before the limit.
// ---------------------------------------------------------------------------
function truncateAtWord(text, maxLen) {
  if (text.length <= maxLen) return text;
  const cut       = text.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > 0 ? cut.slice(0, lastSpace).trim() : cut.trim();
}

// ---------------------------------------------------------------------------
// selectExcerpts
// Filters, deduplicates, ranks, and truncates raw candidate strings.
// Returns [] if fewer than MIN_EXCERPTS qualify — a single excerpt is not
// enough to ground the LLM in buyer language without over-anchoring.
// ---------------------------------------------------------------------------
function selectExcerpts(candidates) {
  const cleaned = candidates
    .filter(t => typeof t === 'string')
    .map(t => t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(t => {
      if (t.length < MIN_TEXT_LEN) return false;
      if (/^\d+(\.\d+)?$/.test(t)) return false; // pure numeric
      try { JSON.parse(t); return false; } catch (_) {}  // still-encoded JSON
      return true;
    });

  // Longer reviews contain more specific buyer language — sort descending.
  cleaned.sort((a, b) => b.length - a.length);

  // Dedup: skip if first 6 words match an already-selected excerpt.
  const seen    = new Set();
  const deduped = [];
  for (const t of cleaned) {
    const key = t.split(/\s+/).slice(0, 6).join(' ').toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(t);
    }
    if (deduped.length >= MAX_CANDIDATES) break;
  }

  const excerpts = deduped
    .slice(0, MAX_EXCERPTS)
    .map(t => truncateAtWord(t, EXCERPT_MAX_LEN));

  return excerpts.length >= MIN_EXCERPTS ? excerpts : [];
}

// ---------------------------------------------------------------------------
// fetchProductReviews — main export
// ---------------------------------------------------------------------------
async function fetchProductReviews(storeObj, product) {
  if (!storeObj?.shopDomain || !storeObj?.accessToken) return [];
  if (!product?.shopifyProductId)                       return [];

  const url        = `https://${storeObj.shopDomain}/admin/api/2024-01/products/${product.shopifyProductId}/metafields.json?limit=250`;
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'X-Shopify-Access-Token': storeObj.accessToken },
    });

    if (!res.ok) return [];

    const body = await res.json();
    if (!Array.isArray(body?.metafields)) return [];

    const candidates = [];
    for (const mf of body.metafields) {
      if (!REVIEW_NAMESPACES.has(mf.namespace)) continue;
      if (!mf.value)                            continue;
      candidates.push(...extractReviewTexts(String(mf.value)));
      if (candidates.length >= MAX_CANDIDATES) break;
    }

    return selectExcerpts(candidates);
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchProductReviews };
