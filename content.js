// content.js — KickSanitizer main content script entry point.
// Coordinates all filters, MutationObserver, SPA navigation, and the in-page button.

(function () {
  'use strict';

  // Guard against double-injection
  if (window.__kickSanitizerLoaded) return;
  window.__kickSanitizerLoaded = true;

  let _settings = null;
  let _observer = null;
  let _mutationQueue = [];
  let _removedQueue = [];
  let _mutationFlushPending = false;
  let _currentChannel = null;

  // ── Boot ───────────────────────────────────────────────────────────────────

  function boot() {
    KS.getEffectiveSettings(KS.Sel.getCurrentChannel()).then((settings) => {
      _settings = settings;
      _currentChannel = KS.Sel.getCurrentChannel();

      KS.ChatFilters.init(_settings);
      KS.PageFilters.init(_settings);

      _applyTimestamps(_settings.chat_showTimestamps);

      // Initial scan after DOM has settled
      setTimeout(() => {
        // Mirror mounts before the scan so the first pass fills the clean list
        // rather than being dropped on the floor.
        if (KS.Mirror) KS.Mirror.init(_settings);
        KS.ChatFilters.scanExisting();
        KS.PageFilters.scan(document.body);
        _injectPageButton();
        _startButtonWatch();
        _startInputFocusWatch();
      }, 800);

      _startObserver();
      _watchNavigation();
      _listenMessages();
      _listenStorage();
    });
  }

  // ── MutationObserver ───────────────────────────────────────────────────────

  function _startObserver() {
    if (_observer) _observer.disconnect();
    _observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && !node.dataset.ksDeleted) {
            _mutationQueue.push(node);
          }
        }
        if (_settings && _settings.chat_keepDeletedMessages) {
          for (const node of m.removedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && !node.dataset.ksDeleted) {
              _removedQueue.push({ node, target: m.target, nextSibling: m.nextSibling });
            }
          }
        }
      }
      if (!_mutationFlushPending) {
        _mutationFlushPending = true;
        requestAnimationFrame(_flushMutations);
      }
    });
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  function _flushMutations() {
    _mutationFlushPending = false;
    if (!_settings || !_settings.enabled) {
      _mutationQueue = [];
      _removedQueue = [];
      return;
    }
    const batch = _mutationQueue.splice(0);
    for (const node of batch) {
      KS.ChatFilters.handleAddedNode(node);
      KS.PageFilters.handleAddedNode(node);
    }
    const removed = _removedQueue.splice(0);
    for (const { node, target, nextSibling } of removed) {
      KS.ChatFilters.handleRemovedNode(node, target, nextSibling);
    }
    if (_settings.developerMode) _debugOutlineAll();
  }

  // ── SPA navigation ─────────────────────────────────────────────────────────

  function _watchNavigation() {
    let lastHref = location.href;

    // Intercept pushState / replaceState
    const wrap = (orig) => function (...args) {
      orig.apply(this, args);
      if (location.href !== lastHref) {
        lastHref = location.href;
        _onNavigate();
      }
    };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', () => {
      if (location.href !== lastHref) { lastHref = location.href; _onNavigate(); }
    });
  }

  function _onNavigate() {
    const newChannel = KS.Sel.getCurrentChannel();
    _currentChannel = newChannel;
    // Destroy filter state accumulated for previous page
    KS.ChatFilters.destroy();
    // Kick is a SPA: without this the mirror kept the previous channel's
    // messages, its dedupe keys and message-id buffer, and — worst — the chat
    // socket stayed subscribed to the OLD chatroom, so deletions and bans from
    // a channel you had left were applied to the one you were reading.
    if (KS.Mirror) KS.Mirror.destroy();
    // Stats are per-channel and the slug is resolved once at load, so counts
    // would otherwise keep accruing against the channel you started on.
    if (KS.Stats) { KS.Stats.flush(); KS.Stats.setChannel(newChannel); }

    // Re-load effective settings for the new channel
    KS.getEffectiveSettings(newChannel).then((settings) => {
      _settings = settings;
      KS.ChatFilters.init(_settings);
      KS.PageFilters.update(_settings);
      _applyTimestamps(_settings.chat_showTimestamps);
      setTimeout(() => {
        if (KS.Mirror) KS.Mirror.init(_settings);   // remount + resubscribe
        KS.ChatFilters.scanExisting();
        KS.PageFilters.scan(document.body);
        _injectPageButton();
      }, 1000);
    });
  }

  // ── Settings change listener ───────────────────────────────────────────────

  function _listenStorage() {
    KS.onSettingsChanged((settings) => {
      _settings = settings;
      KS.ChatFilters.update(_settings);

      if (!_settings.enabled) {
        KS.ChatFilters.restoreAll();
        KS.PageFilters.restoreAll();
        if (KS.Mirror) KS.Mirror.update(_settings);   // tears down mirror + bar
      } else {
        KS.PageFilters.update(_settings);
        if (KS.Mirror) KS.Mirror.update(_settings);
        // Reset before re-scanning. Without this, scanExisting() re-checks every
        // already-processed message against a _dupeHistory that still contains
        // that same message — so each one matches itself and gets hidden as a
        // duplicate, wiping the chat on any settings change. Clearing also lets
        // messages hidden by a filter you just turned OFF come back, which
        // processMessage's `if (msgEl.dataset.ksHidden) return` would otherwise
        // prevent forever.
        KS.ChatFilters.restoreAll();
        KS.ChatFilters.scanExisting();
      }

      _applyTimestamps(_settings.chat_showTimestamps);
      _updatePageButtonState();
    });
  }

  // Kick gates chat behind a per-channel rules panel with an "I agree" button.
  // Confirmed markup 2026-08-16: a card headed "Chat Rules" whose last child is
  // <button …>I agree</button>.
  //
  // Opt-in only (page_autoAcceptChatRules, default off) — this accepts a
  // channel's rules on the user's behalf, which is their decision to make.
  // Scoped to a container that actually says "chat rules" so we cannot click
  // some other confirmation button on the page.
  function _autoAcceptChatRules() {
    if (!_settings || !_settings.enabled || !_settings.page_autoAcceptChatRules) return;

    for (const btn of document.querySelectorAll('button')) {
      if (!/^\s*i\s+agree\s*$/i.test(btn.textContent || '')) continue;
      if (btn.dataset.ksAgreed) continue;

      let scope = btn, found = false;
      for (let i = 0; i < 4 && scope; i++) {
        if (/chat rules/i.test(scope.textContent || '')) { found = true; break; }
        scope = scope.parentElement;
      }
      if (!found) continue;

      btn.dataset.ksAgreed = '1';   // never click the same button twice
      btn.click();
      return;
    }
  }

  // ── Restore focus after Kick disables the chat input ───────────────────────
  //
  // In slow mode (and after some other posting restrictions) Kick disables the
  // input for a cooldown once you send. Focus falls to the document, so the
  // next keys you type hit Kick's global player hotkeys — space pauses the
  // stream instead of typing a space. Kick's doing, not ours; this just puts
  // focus back when the field comes alive again.
  //
  // Driven by the DOM rather than the chatroom's `message_interval`: config
  // says what the cooldown is *meant* to be, the DOM says when you can actually
  // type. Latency, followers-mode and rejected messages all break the timer.
  //
  // isContentEditable is read from a freshly queried element each tick, so it
  // holds whether Kick flips the attribute, swaps the node, or disables it some
  // other way — none of which I have been able to observe directly.
  let _inputWatch = null;
  let _inputWasDisabled = false;
  let _chatFocusWanted = false;   // was the user actually typing in chat?

  function _startInputFocusWatch() {
    document.addEventListener('focusin', (e) => {
      const input = KS.Sel.find(KS.Sel.chatInputArea);
      if (input && (e.target === input || input.contains(e.target))) {
        _chatFocusWanted = true;
      } else if (e.target !== document.body) {
        // Focus moved somewhere deliberately — do not fight the user for it.
        _chatFocusWanted = false;
      }
    }, true);

    clearInterval(_inputWatch);
    _inputWatch = setInterval(() => {
      if (!_settings || !_settings.enabled) return;
      if (!_settings.chat_restoreFocusAfterCooldown) return;

      const el = KS.Sel.find(KS.Sel.chatInputArea);
      if (!el) return;

      if (!el.isContentEditable) { _inputWasDisabled = true; return; }
      if (!_inputWasDisabled) return;

      _inputWasDisabled = false;
      // Only reclaim focus that was LOST. If it sits on another control the
      // user put it there.
      if (_chatFocusWanted && document.activeElement === document.body) {
        try { el.focus(); } catch (_) { }
      }
    }, 250);
  }

  function _applyTimestamps(show) {
    document.body.classList.toggle('ks-timestamps', !!show);
  }

  // ── Message listener (from popup or background) ────────────────────────────

  function _listenMessages() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'REVEAL_ALL') {
        KS.ChatFilters.restoreAll();
        KS.PageFilters.restoreAll();
        sendResponse({ ok: true });
      } else if (msg.type === 'GET_CHANNEL') {
        sendResponse({ channel: KS.Sel.getCurrentChannel() });
      } else if (msg.type === 'TOGGLE_DEBUG') {
        _settings.developerMode = msg.value;
        if (!msg.value) _clearDebugOutlines();
        sendResponse({ ok: true });
      }
    });
  }

  // ── In-page button & panel ─────────────────────────────────────────────────

  // The broom is injected into Kick's own chat footer, which React re-renders
  // (on stream state changes, chat mode switches, SPA navigation…). Any such
  // re-render destroys our node, and injection only ran once at boot — so the
  // button vanished for the rest of the session. Re-inject when it goes away.
  let _btnWatch = null;
  function _startButtonWatch() {
    clearInterval(_btnWatch);
    _btnWatch = setInterval(() => {
      const w = document.getElementById('ks-page-wrapper');
      if (!w || !w.isConnected) _injectPageButton();
      // The mode bar lives in Kick's chat column and is destroyed by the same
      // React re-renders, so it needs the same watchdog.
      if (KS.Mirror && KS.Mirror.renderModeBar) KS.Mirror.renderModeBar();
      _autoAcceptChatRules();
    }, 2000);
  }

  function _injectPageButton() {
    const existing = document.getElementById('ks-page-wrapper');
    if (existing && existing.isConnected) return;
    if (existing) existing.remove();   // detached leftover from a re-render

    const wrapper = document.createElement('div');
    wrapper.id = 'ks-page-wrapper';

    const btn = document.createElement('button');
    btn.id = 'ks-page-btn';
    btn.title = 'KickSanitizer';
    btn.innerHTML = '🧹';
    btn.setAttribute('aria-label', 'KickSanitizer settings');

    const panel = document.createElement('div');
    panel.id = 'ks-page-panel';
    panel.innerHTML = _buildPanelHTML();

    wrapper.appendChild(btn);
    wrapper.appendChild(panel);

    // Attempt to inject near the chat input area
    const chatInput = KS.Sel.find(KS.Sel.chatInputArea);
    const injected = chatInput ? _tryInjectNear(wrapper, chatInput) : false;
    if (!injected) {
      // Fallback: fixed position bottom-right
      wrapper.style.cssText = 'position:fixed;bottom:70px;right:16px;z-index:2147483646;';
      document.body.appendChild(wrapper);
    }

    // Wire up the toggle button
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = !panel.classList.contains('ks-open');
      panel.classList.toggle('ks-open');
      if (opening) _positionPanel(btn, panel);
    });
    window.addEventListener('resize', () => {
      if (panel.classList.contains('ks-open')) _positionPanel(btn, panel);
    });
    document.addEventListener('click', (e) => {
      if (!wrapper.contains(e.target)) panel.classList.remove('ks-open');
    });

    _wirePanelControls(panel);
    _updatePageButtonState();
  }

  function _tryInjectNear(wrapper, anchor) {
    // anchor.parentElement is NOT the chat controls row — verified live
    // 2026-08-16 on kick.com: it is <div class="relative w-full"> (display:block,
    // 222x42), the Lexical editor's own positioning wrapper. Inserting there put
    // the broom *inside* the message box.
    //
    // The real controls row is two levels up:
    //   <div class="flex w-full items-center rounded border-2 …">  (flex row,
    //   300x46) — it holds the editor plus the existing chat control buttons.
    // Walk up to the nearest flex ROW that already contains buttons and append,
    // so the broom lands beside those controls instead of before the input.
    // Preferred home: the control row *below* the input — div.ml-auto.flex
    // .items-center.gap-x-2, which holds Kick's chat Settings gear and the Chat
    // button — sitting immediately left of the gear. Confirmed live 2026-08-16.
    //
    // Scope the search to the chat column: svg[data-ds-icon="Settings"] also
    // matches the video player's settings control, which is nowhere near chat.
    let scope = anchor;
    for (let i = 0; i < 6 && scope.parentElement; i++) scope = scope.parentElement;
    const gear = [...scope.querySelectorAll('svg[data-ds-icon="Settings"]')]
      .map(s => s.closest('button')).find(Boolean);
    if (gear && gear.parentElement) {
      // The gear lives in div.ml-auto.flex.items-center.gap-x-2 — a ~100px
      // right-aligned group already holding Settings and Chat. Inserting a third
      // child there clips it. Go one level out and sit immediately before that
      // group, inside the ~300px footer row, which has free space to the left.
      const group = gear.parentElement;
      const row = group.parentElement;
      const groupTight = group.getBoundingClientRect().width < 160;
      if (row && groupTight) {
        try { row.insertBefore(wrapper, group); return true; } catch (_) { }
      }
      try { group.insertBefore(wrapper, gear); return true; } catch (_) { }
    }

    // Fallback: the input's own control row.
    let n = anchor.parentElement;
    for (let i = 0; i < 4 && n; i++) {
      const cs = getComputedStyle(n);
      if (cs.display === 'flex' && cs.flexDirection === 'row' && n.querySelector('button')) {
        try { n.appendChild(wrapper); return true; } catch (_) { return false; }
      }
      n = n.parentElement;
    }
    return false;
  }

  // The panel sits inside Kick's chat footer, which is overflow:hidden — an
  // absolutely positioned panel is clipped by it. It is position:fixed instead,
  // so place it from the button's rect and clamp it to the viewport.
  function _positionPanel(btn, panel) {
    const r = btn.getBoundingClientRect();
    const pw = panel.offsetWidth || 230;
    const ph = panel.offsetHeight || 260;
    const M = 8;

    let left = r.right - pw;                       // right-aligned to the broom
    left = Math.max(M, Math.min(left, window.innerWidth - pw - M));

    let top = r.top - ph - 6;                      // preferred: above the button
    if (top < M) top = Math.min(r.bottom + 6, window.innerHeight - ph - M);

    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }

  function _buildPanelHTML() {
    return `
      <div class="ks-panel-header">🧹 KickSanitizer <span>v${_getVersion()}</span></div>
      <div class="ks-panel-row">
        <label for="ks-p-enabled">Sanitize this stream</label>
        <button class="ks-toggle" id="ks-p-enabled" data-key="enabled"></button>
      </div>
      <div class="ks-panel-row">
        <label for="ks-p-dupes">Hide duplicate messages</label>
        <button class="ks-toggle" id="ks-p-dupes" data-key="chat_hideDuplicates"></button>
      </div>
      <div class="ks-panel-row">
        <label for="ks-p-emote">Hide emote-only messages</label>
        <button class="ks-toggle" id="ks-p-emote" data-key="chat_hideEmoteOnly"></button>
      </div>
      <div class="ks-panel-row">
        <label for="ks-p-kicks">Hide Kicks</label>
        <button class="ks-toggle" id="ks-p-kicks" data-key="page_hideKicks"></button>
      </div>
      <div class="ks-panel-row">
        <label for="ks-p-gifters">Hide Top Gifters</label>
        <button class="ks-toggle" id="ks-p-gifters" data-key="page_hideTopGifters"></button>
      </div>
      <div class="ks-panel-row">
        <label for="ks-p-mirror">Clean chat mode</label>
        <button class="ks-toggle" id="ks-p-mirror" data-key="chat_mirrorMode"></button>
      </div>
      <div class="ks-panel-actions">
        <button class="ks-action-btn" id="ks-p-reveal">Temporarily reveal all hidden</button>
        <button class="ks-action-btn ks-primary" id="ks-p-open-popup">Open full settings ↗</button>
      </div>
    `;
  }

  function _wirePanelControls(panel) {
    // Toggle buttons
    panel.querySelectorAll('.ks-toggle[data-key]').forEach((btn) => {
      const key = btn.dataset.key;
      _refreshToggle(btn, _settings && _settings[key]);
      btn.addEventListener('click', () => {
        const newVal = !(_settings && _settings[key]);
        KS.updateSettings({ [key]: newVal }).then(() => {
          if (!_settings) _settings = {};
          _settings[key] = newVal;
          _refreshToggle(btn, newVal);
        });
      });
    });

    // Reveal all
    panel.querySelector('#ks-p-reveal').addEventListener('click', () => {
      KS.ChatFilters.restoreAll();
      KS.PageFilters.restoreAll();
    });

    // Open popup
    panel.querySelector('#ks-p-open-popup').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
    });
  }

  function _refreshToggle(btn, value) {
    btn.classList.toggle('ks-on', !!value);
    btn.setAttribute('aria-pressed', !!value);
  }

  function _updatePageButtonState() {
    const btn = document.getElementById('ks-page-btn');
    if (!btn) return;
    btn.classList.toggle('ks-disabled', !(_settings && _settings.enabled));
    // Sync all panel toggles
    const panel = document.getElementById('ks-page-panel');
    if (!panel || !_settings) return;
    panel.querySelectorAll('.ks-toggle[data-key]').forEach((t) => {
      _refreshToggle(t, _settings[t.dataset.key]);
    });
  }

  function _getVersion() {
    try { return chrome.runtime.getManifest().version; } catch (_) { return ''; }
  }

  // ── Developer debug mode ───────────────────────────────────────────────────

  function _debugOutlineAll() {
    const targets = [
      ['chatContainer', KS.Sel.chatContainer],
      ['chatMessage', KS.Sel.chatMessage],
      ['kicksWidget', KS.Sel.kicksWidget],
      ['topGiftersPanel', KS.Sel.topGiftersPanel],
      ['giftAnimation', KS.Sel.giftAnimation],
      ['pinnedMessage', KS.Sel.pinnedMessage],
      ['pollWidget', KS.Sel.pollWidget],
      ['suggestedChannels', KS.Sel.suggestedChannels],
    ];
    for (const [name, selList] of targets) {
      for (const el of KS.Sel.findAll(selList)) {
        if (!el.querySelector('.ks-debug-label')) {
          el.classList.add('ks-debug-outline');
          const lbl = document.createElement('span');
          lbl.className = 'ks-debug-label';
          lbl.textContent = name;
          el.style.position = el.style.position || 'relative';
          el.insertBefore(lbl, el.firstChild);
        }
      }
    }
  }

  function _clearDebugOutlines() {
    document.querySelectorAll('.ks-debug-outline').forEach(el => el.classList.remove('ks-debug-outline'));
    document.querySelectorAll('.ks-debug-label').forEach(el => el.remove());
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}());
