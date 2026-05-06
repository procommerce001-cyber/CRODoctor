/* CRODoctor PDP tracker — v1
   Minimal first-party event capture. Silent on any error.
   No PII stored. Fire-and-forget only. */
(function () {
  'use strict';

  // ── 1. Resolve API base from this script's own URL ─────────────────────────
  // Works whether served directly or proxied — no hardcoded domain needed.
  var _currentSrc = (document.currentScript || {}).src || '';
  if (!_currentSrc) return;
  var _api = _currentSrc.replace(/\/cro-tracker\.js(\?.*)?$/, '') + '/events/pdp';

  // ── 2. Bail out if not a Shopify product page ──────────────────────────────
  var _shopify = window.Shopify || {};
  var _shop    = _shopify.shop;
  if (!_shop) return;

  // Product id — ShopifyAnalytics is available on Dawn and most modern themes.
  // window.meta.product is the older fallback.
  var _meta      = (window.ShopifyAnalytics || {}).meta || window.meta || {};
  var _productId = String((_meta.product || {}).id || '');
  if (!_productId) return;

  // ── 3. Session / visitor identity — opaque UUIDs, no PII ──────────────────
  function _uuid() {
    try {
      return crypto.randomUUID();
    } catch (_) {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
  }

  // Session id: new UUID each browser tab/session
  var _sid = (function () {
    try {
      var k = '_cro_sid', v = sessionStorage.getItem(k);
      if (!v) { v = _uuid(); sessionStorage.setItem(k, v); }
      return v;
    } catch (_) { return _uuid(); }
  })();

  // Visitor id: persisted across sessions via localStorage (no PII)
  var _vid = (function () {
    try {
      var k = '_cro_vid', v = localStorage.getItem(k);
      if (!v) { v = _uuid(); localStorage.setItem(k, v); }
      return v;
    } catch (_) { return _uuid(); }
  })();

  // ── 4. Fire-and-forget event sender ───────────────────────────────────────
  // fetch keepalive: survives page navigation without blocking.
  // sendBeacon Blob: fallback for browsers without keepalive support.
  var _t0 = Date.now();

  function _send(event, meta) {
    try {
      var body = JSON.stringify({
        shop:             _shop,
        shopifyProductId: _productId,
        sessionId:        _sid,
        visitorId:        _vid,
        event:            event,
        ts:               Date.now(),
        meta:             meta || {},
      });
      if (typeof fetch !== 'undefined') {
        fetch(_api, {
          method:    'POST',
          headers:   { 'Content-Type': 'application/json' },
          body:      body,
          keepalive: true,
        }).catch(function () {});
      } else if (navigator.sendBeacon) {
        navigator.sendBeacon(_api, new Blob([body], { type: 'application/json' }));
      }
    } catch (_) {}
  }

  // ── 5. pdp_view — once on load ────────────────────────────────────────────
  _send('pdp_view', {});

  // ── 6. scroll_depth — milestone-only (25 / 50 / 75 / 90), once each ──────
  var _milestones = [25, 50, 75, 90];
  var _depthFired = {};

  function _onScroll() {
    try {
      var scrolled = window.scrollY + window.innerHeight;
      var total    = Math.max(document.documentElement.scrollHeight, 1);
      var pct      = Math.floor((scrolled / total) * 100);
      for (var i = 0; i < _milestones.length; i++) {
        var m = _milestones[i];
        if (pct >= m && !_depthFired[m]) {
          _depthFired[m] = true;
          _send('scroll_depth', { depthPct: m });
        }
      }
    } catch (_) {}
  }
  window.addEventListener('scroll', _onScroll, { passive: true });

  // ── 7. block_viewed — IntersectionObserver on CRO-inserted blocks ─────────
  // Fires once per block per session when ≥ 50 % of the block is visible.
  // data-cro-block and data-cro-eid are injected by applyContentChange.
  if (typeof IntersectionObserver !== 'undefined') {
    var _io = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
          var el = entry.target;
          _send('block_viewed', {
            blockId:     el.getAttribute('data-cro-block') || '',
            executionId: el.getAttribute('data-cro-eid')   || '',
          });
          _io.unobserve(el); // each block fires once per session
        }
      }
    }, { threshold: 0.5 });

    document.querySelectorAll('[data-cro-block]').forEach(function (el) {
      _io.observe(el);
    });
  }

  // ── 8. atc_click — Add-to-Cart form submit ───────────────────────────────
  // Listens on the ATC form submit; passive so it never delays the ATC action.
  var _atcForm = document.querySelector('form[action*="/cart/add"]');
  if (_atcForm) {
    _atcForm.addEventListener('submit', function () {
      try {
        var variantEl = _atcForm.querySelector('[name="id"]');
        _send('atc_click', { variantId: variantEl ? String(variantEl.value) : '' });
      } catch (_) {}
    }, { passive: true });
  }

  // ── 9. checkout_click — Buy Now / direct checkout links ──────────────────
  // Delegated on document; walks up to 3 levels to handle wrapper elements.
  // Passive so it never blocks navigation or the click event chain.
  document.addEventListener('click', function (e) {
    try {
      var el = e.target;
      for (var i = 0; i < 3; i++) {
        if (!el) break;
        var tag      = (el.tagName || '').toLowerCase();
        var href     = (el.getAttribute('href') || '').toLowerCase();
        var name     = (el.getAttribute('name') || '').toLowerCase();
        var cls      = (el.className   || '').toLowerCase();
        var isLink   = tag === 'a' && (href.indexOf('/checkout') !== -1 || href.indexOf('shopify.com/') !== -1);
        var isBtn    = tag === 'button' && (name === 'checkout' || cls.indexOf('checkout') !== -1);
        if (isLink || isBtn) {
          _send('checkout_click', {});
          break;
        }
        el = el.parentElement;
      }
    } catch (_) {}
  }, { passive: true });

  // ── 10. pdp_exit — fires once on tab hide or page unload ─────────────────
  var _exitFired = false;
  function _onExit() {
    if (_exitFired) return;
    _exitFired = true;
    _send('pdp_exit', { timeOnPageMs: Date.now() - _t0 });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') _onExit();
  });
  window.addEventListener('beforeunload', _onExit);

})();
