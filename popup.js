// popup.js — KickSanitizer popup controller

(function () {
  'use strict';

  // Use the KS storage helpers if injected, otherwise fall back to chrome.storage directly
  const DEFAULT = {
    enabled: true,
    chat_hideDuplicates: true,
    chat_duplicateWindowSeconds: 300,
    chat_similarityMode: 'normalized',
    chat_hideEmoteOnly: true,
    chat_maxEmotes: 0,
    chat_collapseGlobalCopypasta: false,
    chat_copypastaThreshold: 5,
    chat_copypastaWindowSeconds: 60,
    chat_hideBotCommands: false,
    chat_hideBotResponses: false,
    chat_hideAllCaps: false,
    chat_hideRepeatedChars: false,
    chat_hideLinks: false,
    chat_hideGiftedSubNotices: false,
    chat_collapseGiftedSubs: false,
    chat_hideSubscriptionNotices: false,
    chat_hideFollowNotices: false,
    chat_keepDeletedMessages: false,
    chat_showTimestamps: false,
    chat_restoreFocusAfterCooldown: true,
    chat_kicksMinAmount: 0,
    // NOTE: this duplicates KS.DEFAULT_SETTINGS in storage.js, which popup.html
    // does not load. Keep the two in step — when they drifted, new settings
    // rendered with the wrong state (clean chat showed as off while defaulting
    // to on) until the user touched the control.
    chat_mirrorMode: true,
    chat_showModeToggle: true,
    chat_theme: 'normal',
    chat_hideAllEmotes: false,
    chat_hideRepeatedEmotes: false,
    chat_minMessageLength: 0,
    chat_hideBotGames: false,
    chat_botGameCommands: 'fish,hunt,duel,flag,country,guess,slots,cookie,mine,farm',
    page_autoAcceptChatRules: false,
    page_autoClaimRewards: false,
    page_hideKicks: true,
    page_hideTopGifters: true,
    page_hideGiftAnimations: true,
    page_hidePinnedMessages: false,
    page_hidePollsPredictions: false,
    page_hideGoals: false,
    page_hideBanNotice: false,
    page_hideSuggestedChannels: true,
    page_hideRecommendedStreams: false,
    page_hideAutoplayOverlays: false,
    scope: 'all',
    developerMode: false,
  };

  let _settings = Object.assign({}, DEFAULT);
  // When opened as a standalone window from the in-page "Open full settings"
  // button, the active-tab lookup below cannot see the Kick tab (this window is
  // its own "current window"), so background.js passes the slug in the query
  // string. The tab lookup leaves this value alone when it finds no kick.com tab.
  let _channel = new URLSearchParams(location.search).get('channel') || null;
  let _blockedChannels = [];

  // ── Storage helpers ────────────────────────────────────────────────────────

  function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.sync.get(null, (synced) => {
        chrome.storage.local.get(['channelOverrides', 'blockedChannels'], (local) => {
          _blockedChannels = local.blockedChannels || [];
          _settings = Object.assign({}, DEFAULT, synced, local);
          resolve(_settings);
        });
      });
    });
  }

  // Keys that describe the extension itself rather than filtering behaviour.
  // These are always global — a per-channel "scope" or blocklist is nonsense.
  const GLOBAL_ONLY = new Set([
    'scope', 'channelOverrides', 'blockedChannels', 'developerMode', 'enabled',
  ]);

  function saveSetting(key, value) {
    // Honour the Scope tab. This previously wrote everything globally, so
    // "This channel only" silently did nothing and KS.setChannelOverride was
    // dead code — which is why the popup looked per-channel but never was.
    const scope = _settings.scope || 'all';

    if (scope === 'channel' && _channel && !GLOBAL_ONLY.has(key)) {
      const overrides = Object.assign({}, _settings.channelOverrides || {});
      overrides[_channel] = Object.assign({}, overrides[_channel] || {}, { [key]: value });
      _settings.channelOverrides = overrides;
      _settings[key] = value;
      chrome.storage.local.set({ channelOverrides: overrides });
      render();
      return;
    }

    const data = { [key]: value };
    // channelOverrides goes to local
    if (key === 'channelOverrides') {
      chrome.storage.local.set(data);
    } else {
      chrome.storage.sync.set(data);
    }
    _settings[key] = value;
  }

  // ── Tab handling ───────────────────────────────────────────────────────────

  document.querySelectorAll('.ks-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ks-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.ks-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // ── Render settings into UI ────────────────────────────────────────────────

  function render() {
    // Master toggle
    const masterCb = document.getElementById('master-enabled');
    masterCb.checked = !!_settings.enabled;

    // All checkboxes with data-key
    document.querySelectorAll('input[type="checkbox"][data-key]').forEach(cb => {
      cb.checked = !!_settings[cb.dataset.key];
    });

    // All selects with data-key
    document.querySelectorAll('select[data-key]').forEach(sel => {
      sel.value = String(_settings[sel.dataset.key]);
    });

    // Number inputs
    document.querySelectorAll('input[type="number"][data-key]').forEach(inp => {
      inp.value = _settings[inp.dataset.key] ?? 0;
    });

    // Max emotes label
    const maxEv = document.getElementById('max-emotes-val');
    if (maxEv) maxEv.textContent = _settings.chat_maxEmotes > 0 ? _settings.chat_maxEmotes : 'disabled';

    // Kicks min label
    const kicksMinV = document.getElementById('kicks-min-val');
    if (kicksMinV) kicksMinV.textContent = _settings.chat_kicksMinAmount > 0 ? _settings.chat_kicksMinAmount : 'disabled';

    _renderBlocklist();

    // Scope radios
    document.querySelectorAll('input[name="scope"]').forEach(r => {
      r.checked = (r.value === (_settings.scope || 'all'));
    });

    // Sub-option visibility
    _toggleSub('dupe-options', _settings.chat_hideDuplicates);
    _toggleSub('copypasta-options', _settings.chat_collapseGlobalCopypasta);

    // Channel bar. Say plainly whether this channel actually differs from your
    // global settings — it used to appear on every channel page with a reset
    // button even when there was nothing to reset, which made the whole popup
    // read as if settings were per-channel.
    if (_channel) {
      const bar = document.getElementById('channel-bar');
      bar.hidden = false;
      document.getElementById('current-channel-name').textContent = _channel;

      const ov = (_settings.channelOverrides || {})[_channel] || {};
      const n = Object.keys(ov).length;
      const state = document.getElementById('channel-override-state');
      if (state) {
        state.textContent = n
          ? `${n} setting${n === 1 ? '' : 's'} overridden here`
          : 'using your settings for all channels';
      }
      const reset = document.getElementById('clear-channel-overrides');
      if (reset) reset.hidden = !n;
    }
  }

  function _renderBlocklist() {
    const container = document.getElementById('blocklist-container');
    if (!container) return;
    if (!_blockedChannels.length) {
      container.innerHTML = '<p class="ks-blocklist-empty">No channels hidden yet.</p>';
      return;
    }
    container.innerHTML = _blockedChannels.map((slug, i) =>
      `<div class="ks-blocklist-item">
        <span class="ks-blocklist-slug">${slug}</span>
        <button class="ks-blocklist-remove" data-index="${i}" title="Remove ${slug} from blocklist">✕</button>
      </div>`
    ).join('');
    container.querySelectorAll('.ks-blocklist-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        _blockedChannels = _blockedChannels.filter((_, i) => i !== idx);
        chrome.storage.local.set({ blockedChannels: _blockedChannels }, _renderBlocklist);
      });
    });
  }

  function _toggleSub(id, visible) {
    const el = document.getElementById(id);
    if (el) el.style.opacity = visible ? '1' : '0.4';
  }

  // ── Wire up controls ───────────────────────────────────────────────────────

  function wireControls() {
    // Master toggle
    document.getElementById('master-enabled').addEventListener('change', e => {
      saveSetting('enabled', e.target.checked);
    });

    // Checkboxes
    document.querySelectorAll('input[type="checkbox"][data-key]').forEach(cb => {
      cb.addEventListener('change', () => {
        saveSetting(cb.dataset.key, cb.checked);
        if (cb.dataset.key === 'chat_hideDuplicates') _toggleSub('dupe-options', cb.checked);
        if (cb.dataset.key === 'chat_collapseGlobalCopypasta') _toggleSub('copypasta-options', cb.checked);
      });
    });

    // Selects
    document.querySelectorAll('select[data-key]').forEach(sel => {
      sel.addEventListener('change', () => {
        const val = isNaN(Number(sel.value)) ? sel.value : Number(sel.value);
        saveSetting(sel.dataset.key, val);
      });
    });

    // Number inputs
    document.querySelectorAll('input[type="number"][data-key]').forEach(inp => {
      inp.addEventListener('change', () => {
        const val = Math.max(0, parseInt(inp.value, 10) || 0);
        inp.value = val;
        saveSetting(inp.dataset.key, val);
        if (inp.dataset.key === 'chat_maxEmotes') {
          const lbl = document.getElementById('max-emotes-val');
          if (lbl) lbl.textContent = val > 0 ? val : 'disabled';
        }
        if (inp.dataset.key === 'chat_kicksMinAmount') {
          const lbl = document.getElementById('kicks-min-val');
          if (lbl) lbl.textContent = val > 0 ? val : 'disabled';
        }
      });
    });

    // Scope radios
    document.querySelectorAll('input[name="scope"]').forEach(r => {
      r.addEventListener('change', () => {
        if (r.checked) saveSetting('scope', r.value);
      });
    });

    // Reveal all
    document.getElementById('btn-reveal').addEventListener('click', () => {
      _sendToContent({ type: 'REVEAL_ALL' });
      _showStatus('All hidden content revealed.', 'ok');
    });

    // Reset
    document.getElementById('btn-reset').addEventListener('click', () => {
      if (!confirm('Reset all KickSanitizer settings to defaults?')) return;
      chrome.storage.sync.clear(() => {
        chrome.storage.local.clear(() => {
          _settings = Object.assign({}, DEFAULT);
          render();
          _showStatus('Settings reset to defaults.', 'ok');
        });
      });
    });

    // Export
    document.getElementById('btn-export').addEventListener('click', () => {
      loadSettings().then(s => {
        const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'kicksanitizer-settings.json';
        a.click();
        URL.revokeObjectURL(url);
        _showStatus('Settings exported.', 'ok');
      });
    });

    // Import
    document.getElementById('btn-import').addEventListener('click', () => {
      document.getElementById('import-file').click();
    });
    document.getElementById('import-file').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const imported = JSON.parse(ev.target.result);
          const validKeys = Object.keys(DEFAULT).concat(['channelOverrides']);
          const filtered = {};
          for (const k of validKeys) {
            if (k in imported) filtered[k] = imported[k];
          }
          if (!Object.keys(filtered).length) throw new Error('No recognised settings found.');
          const syncKeys = {};
          const localKeys = {};
          for (const [k, v] of Object.entries(filtered)) {
            if (k === 'channelOverrides') localKeys[k] = v; else syncKeys[k] = v;
          }
          chrome.storage.sync.set(syncKeys, () => {
            chrome.storage.local.set(localKeys, () => {
              loadSettings().then(() => { render(); _showStatus('Settings imported.', 'ok'); });
            });
          });
        } catch (err) {
          _showStatus('Import failed: ' + err.message, 'err');
        }
        e.target.value = '';
      };
      reader.readAsText(file);
    });

    // Clear channel overrides
    const clearBtn = document.getElementById('clear-channel-overrides');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (!_channel) return;
        chrome.storage.local.get(['channelOverrides'], data => {
          const ov = Object.assign({}, data.channelOverrides || {});
          delete ov[_channel];
          chrome.storage.local.set({ channelOverrides: ov }, () => {
            _showStatus(`Overrides for #${_channel} cleared.`, 'ok');
          });
        });
      });
    }
  }

  // ── Status bar ─────────────────────────────────────────────────────────────

  function _showStatus(msg, type) {
    const el = document.getElementById('status-msg');
    el.textContent = msg;
    el.className = 'ks-status ' + (type === 'ok' ? 'ks-ok' : type === 'err' ? 'ks-err' : '');
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.hidden = true; }, 3000);
  }

  // ── Communicate with content script ───────────────────────────────────────

  function _sendToContent(msg) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, msg, () => {
        if (chrome.runtime.lastError) { /* content script not on a Kick page */ }
      });
    });
  }

  function _getChannel() {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]) return;
      const url = tabs[0].url || '';
      if (!url.includes('kick.com')) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_CHANNEL' }, resp => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.channel) {
          _channel = resp.channel;
          render();
          renderStats();   // per-channel group needs the slug
        }
      });
    });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  loadSettings().then(() => {
    render();
    wireControls();
    _getChannel();
    renderStats();
    const v = document.getElementById('about-version');
    if (v) v.textContent = 'v' + chrome.runtime.getManifest().version;
  });

  // ── Stats ──────────────────────────────────────────────────────────────────
  // Counts are written by stats.js from the content script into
  // chrome.storage.local; the popup only reads them.

  const STATS_KEY = 'ks_stats';
  const REASON_LABELS = {
    'duplicate': 'Duplicates', 'emote-only': 'Emote-only', 'max-emotes': 'Too many emotes',
    'emote-stripped': 'Emotes stripped', 'emote-repeat': 'Repeated emotes',
    'copypasta': 'Copypasta', 'bot-command': 'Bot commands', 'all-caps': 'All caps',
    'repeated-chars': 'Repeated characters', 'link': 'Links',
    'gifted-sub': 'Gifted-sub notices', 'sub-notice': 'Sub notices',
    'follow-notice': 'Follow notices', 'kicks-spam': 'Kicks below threshold',
    'kicks': 'Kicks UI', 'suggested-channels': 'Suggested channels',
    'top-gifters': 'Top gifters', 'gift-animations': 'Gift animations',
    'pinned': 'Pinned messages', 'polls': 'Polls & predictions', 'goals': 'Goals',
    'autoplay': 'Autoplay overlays', 'ban-notice': 'Ban notice',
  };

  function _statsGroup(title, counts) {
    const entries = Object.entries(counts || {}).filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '';
    const total = entries.reduce((a, [, n]) => a + n, 0);
    let html = `<div class="ks-stats-scope">${title}</div>`;
    for (const [reason, n] of entries) {
      html += `<div class="ks-stats-row"><span>${REASON_LABELS[reason] || reason}</span><span>${n.toLocaleString()}</span></div>`;
    }
    html += `<div class="ks-stats-row ks-stats-total"><span>Total</span><span>${total.toLocaleString()}</span></div>`;
    return html;
  }

  function renderStats() {
    const body = document.getElementById('ks-stats-body');
    if (!body) return;
    chrome.storage.local.get([STATS_KEY], (data) => {
      const stats = (data && data[STATS_KEY]) || { site: {}, channels: {} };
      let html = '';
      const chan = (_channel || '').toLowerCase();
      if (chan && stats.channels && stats.channels[chan]) {
        html += _statsGroup(`This channel — ${chan}`, stats.channels[chan]);
      }
      html += _statsGroup('All channels', stats.site);
      body.innerHTML = html || '<div class="ks-stats-empty">Nothing hidden yet.</div>';
    });
  }

  const _statsResetBtn = document.getElementById('ks-stats-reset');
  if (_statsResetBtn) {
    _statsResetBtn.addEventListener('click', () => {
      chrome.storage.local.set(
        { [STATS_KEY]: { site: {}, channels: {}, updatedAt: Date.now() } },
        renderStats);
    });
  }

  // Counters tick while the popup is open — refresh on write.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATS_KEY]) renderStats();
  });

  // Refresh if settings change in another tab/window (includes blockedChannels)
  chrome.storage.onChanged.addListener(() => {
    loadSettings().then(render);
  });
}());
