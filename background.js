// KickSanitizer — service worker
// Handles install, storage migration, and cross-tab message relay.

// List sync (utils/listSync.js) validates recipes with the same code the page
// and popup use. That file attaches to `window`, which a service worker does
// not have, so point it at the worker's global before loading.
self.window = self;
importScripts('utils/botRecipes.js', 'utils/listSync.js');

// Listeners are registered at the top level, synchronously: a service worker
// that registers them later misses the event that woke it.
chrome.storage.onChanged.addListener((changes, area) => KS.ListSync.onChanged(changes, area));
chrome.runtime.onStartup.addListener(() => { KS.ListSync.pullAll().catch(() => {}); });

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.log('[KickSanitizer] Installed. Defaults applied on first use.');
  }
  if (reason === 'update') {
    console.log('[KickSanitizer] Updated to', chrome.runtime.getManifest().version);
  }
  // A new install picks up lists from the user's other browsers; an update
  // (or the first version with sync) sends this browser's lists out.
  KS.ListSync.pullAll().then(() => KS.ListSync.pushAll()).catch(() => {});
});

// Open the settings UI from the in-page panel's "Open full settings" button.
// The content script cannot open the action popup itself, and the message it
// sends had no handler here at all — the button silently did nothing.
//
// chrome.action.openPopup() exists from Chrome 127 but is picky: it can throw
// or reject when the calling context has no user gesture, which is the case
// here because the click happened in the page, not in the extension UI. So try
// it, and fall back to a standalone window.
//
// The fallback carries the channel slug in the query string: a detached popup
// window is its own "current window", so popup.js's active-tab lookup cannot
// find the Kick tab to ask which channel is in view.
// ── Bot list network, done HERE rather than in the content script ──────────
//
// Content-script fetches in MV3 are subject to CORS as the PAGE's origin, so a
// request to a list server from a kick.com page would need that server to send
// the right headers and handle a preflight. The service worker is not subject
// to page CORS and host permissions apply to it directly — so routing through
// here means a list server can be a plain static file plus a POST handler, with
// nothing extension-specific to configure and nothing that breaks when someone
// edits a header.
//
// The URL is re-validated here rather than trusted from the caller. The worker
// is what holds the permissions; it should not fetch an arbitrary address just
// because something asked it to.
function _validBase(url) {
  const raw = String(url || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(raw) ? raw : null;
}

function _pullList(url, since) {
  const base = _validBase(url);
  if (!base) return Promise.resolve({ ok: false, error: 'bad url' });
  // ISO date only, and built here rather than passed through: a caller-supplied
  // query string would let the rest of the URL be rewritten.
  const q = /^\d{4}-\d{2}-\d{2}$/.test(String(since || ''))
    ? '?since=' + encodeURIComponent(since) : '';
  return fetch(base + '/bots.json' + q, { headers: { Accept: 'application/json' } })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
    .then(data => ({ ok: true, data }))
    .catch(e => ({ ok: false, error: String(e.message || e) }));
}

function _report(url, username) {
  const base = _validBase(url);
  const user = String(username || '').trim().toLowerCase();
  if (!base || !user) return Promise.resolve({ ok: false, error: 'bad request' });
  return fetch(base + '/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user }),
  })
    .then(r => ({ ok: r.ok, status: r.status }))
    .catch(e => ({ ok: false, error: String(e.message || e) }));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'KS_BOTS_PULL') {
    _pullList(msg.url, msg.since).then(sendResponse);
    return true;              // async response
  }
  if (msg && msg.type === 'KS_BOTS_REPORT') {
    _report(msg.url, msg.username).then(sendResponse);
    return true;
  }
  if (msg && msg.type === 'OPEN_POPUP') {
    let slug = '';
    try {
      const u = new URL((sender && sender.tab && sender.tab.url) || '');
      const m = u.pathname.match(/^\/([^\/\?#]+)/);
      slug = m ? m[1].toLowerCase() : '';
    } catch (_) { }

    const openWindow = () => {
      const url = chrome.runtime.getURL('popup.html') +
                  (slug ? '?channel=' + encodeURIComponent(slug) : '');
      chrome.windows.create({ url, type: 'popup', width: 420, height: 680 });
    };

    try {
      const p = chrome.action && chrome.action.openPopup && chrome.action.openPopup();
      if (p && typeof p.catch === 'function') p.catch(openWindow);
      else if (!p) openWindow();
    } catch (_) {
      openWindow();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.target === 'content') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { sendResponse({ error: 'no active tab' }); return; }
      chrome.tabs.sendMessage(tabs[0].id, msg, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      });
    });
    return true; // keep channel open for async sendResponse
  }
});
