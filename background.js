// KickSanitizer — service worker
// Handles install, storage migration, and cross-tab message relay.

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.log('[KickSanitizer] Installed. Defaults applied on first use.');
  }
  if (reason === 'update') {
    console.log('[KickSanitizer] Updated to', chrome.runtime.getManifest().version);
  }
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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
