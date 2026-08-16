// stats.js — counts what KickSanitizer hides, per reason.
//
// Two scopes:
//   session  — since this tab loaded (live, in memory)
//   totals   — persisted in chrome.storage.local as { site, channels: { slug } }
//
// Writes are batched: hides arrive in bursts (a bulk re-scan can hide dozens in
// one tick) and chrome.storage.local has a write-rate limit, so counts are
// accumulated in memory and flushed on a timer.

window.KS = window.KS || {};

KS.Stats = (function () {
  const STORE_KEY = 'ks_stats';
  const FLUSH_MS = 4000;

  const _session = {};        // reason -> count, this page load
  let _pending = {};          // not yet written to storage
  let _flushTimer = null;
  // Latches once the extension context is gone. This script keeps running in an
  // orphaned tab until the page is reloaded, so stop retrying storage forever.
  let _dead = false;
  let _channel = _slugFromLocation();

  function _slugFromLocation() {
    try {
      const m = location.pathname.match(/^\/([^\/\?#]+)/);
      const slug = m ? m[1].toLowerCase() : '';
      // Not a channel page — /browse, /categories, /following etc.
      const nonChannel = new Set(['browse', 'categories', 'following', 'search',
                                  'clips', 'subscriptions', 'messages', '']);
      return nonChannel.has(slug) ? '' : slug;
    } catch (_) { return ''; }
  }

  // Call on SPA navigation — Kick swaps channels without a page load.
  function setChannel(slug) {
    _channel = (slug || _slugFromLocation() || '').toLowerCase();
  }

  function getChannel() { return _channel; }

  function count(reason, n) {
    if (!reason) return;
    n = n || 1;
    _session[reason] = (_session[reason] || 0) + n;
    if (_dead) return;                 // orphaned tab: keep session counts only
    _pending[reason] = (_pending[reason] || 0) + n;
    if (!_flushTimer) _flushTimer = setTimeout(flush, FLUSH_MS);
  }

  function session() {
    return Object.assign({}, _session);
  }

  function sessionTotal() {
    return Object.values(_session).reduce((a, b) => a + b, 0);
  }

  // After the extension is reloaded or updated, content scripts already running
  // in open tabs are orphaned: chrome.runtime.id goes undefined and any
  // chrome.* call throws "Extension context invalidated". That is expected on
  // every update, so check before touching storage and give up quietly.
  function _alive() {
    if (_dead) return false;
    try {
      return !!(window.chrome && chrome.runtime && chrome.runtime.id
                && chrome.storage && chrome.storage.local);
    } catch (_) { _dead = true; return false; }
  }

  function flush() {
    clearTimeout(_flushTimer);
    _flushTimer = null;
    const batch = _pending;
    _pending = {};
    if (!Object.keys(batch).length) return;
    if (!_alive()) return;

    try {
      chrome.storage.local.get([STORE_KEY], (data) => {
        // The callback runs later, OUTSIDE the try below — if the extension was
        // reloaded in between, touching chrome.runtime.lastError throws here and
        // nothing upstream can catch it. Guard the whole body.
        try {
          if (!_alive() || chrome.runtime.lastError) return;
          const stats = (data && data[STORE_KEY]) || { site: {}, channels: {} };
          stats.site = stats.site || {};
          stats.channels = stats.channels || {};
          for (const [reason, n] of Object.entries(batch)) {
            stats.site[reason] = (stats.site[reason] || 0) + n;
            if (_channel) {
              const c = stats.channels[_channel] = stats.channels[_channel] || {};
              c[reason] = (c[reason] || 0) + n;
            }
          }
          stats.updatedAt = Date.now();
          chrome.storage.local.set({ [STORE_KEY]: stats });
        } catch (_) { _dead = true; }
      });
    } catch (_) { _dead = true; }
  }

  // cb({ site, channels, updatedAt })
  function totals(cb) {
    if (!_alive()) { cb({ site: {}, channels: {} }); return; }
    try {
      chrome.storage.local.get([STORE_KEY], (data) => {
        try {
          if (!_alive() || chrome.runtime.lastError) { cb({ site: {}, channels: {} }); return; }
          cb((data && data[STORE_KEY]) || { site: {}, channels: {} });
        } catch (_) { _dead = true; cb({ site: {}, channels: {} }); }
      });
    } catch (_) { _dead = true; cb({ site: {}, channels: {} }); }
  }

  function reset(cb) {
    for (const k of Object.keys(_session)) delete _session[k];
    _pending = {};
    if (!_alive()) { if (cb) cb(); return; }
    try {
      chrome.storage.local.set({ [STORE_KEY]: { site: {}, channels: {}, updatedAt: Date.now() } },
        () => { if (cb) cb(); });
    } catch (_) { if (cb) cb(); }
  }

  // Write out whatever is buffered before the tab goes away.
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', flush);
  }

  return { count, session, sessionTotal, totals, flush, reset, setChannel, getChannel, STORE_KEY };
}());
