// content.js — KickSanitizer main content script entry point.
// Coordinates all filters, MutationObserver, SPA navigation, and the in-page button.

(function () {
  'use strict';

  // Top frame only.
  //
  // Everything this touches — chat, sidebar, player chrome — lives in the top
  // document, but Kick embeds iframes and a matching one gets its own copy of
  // the content scripts. Each copy would run its own observers, its own socket
  // tap and its own counter, all writing to the same chrome.storage: the counter
  // would advance more than once per message and nothing downstream could tell
  // why. __kickSanitizerLoaded does not help, since each frame is a separate
  // global.
  if (window.top !== window.self) return;

  // Guard against double-injection within this frame.
  if (window.__kickSanitizerLoaded) return;
  window.__kickSanitizerLoaded = true;

  let _settings = null;
  let _observer = null;
  let _mutationQueue = [];
  let _removedQueue = [];
  let _mutationFlushPending = false;
  let _currentChannel = null;
  let _observedChat = null;   // chat container the observer is attached to
  let _navCount = 0;          // teardowns run, for the debug attribute
  let _lastHref = location.href;   // shared by both navigation detectors
  const _watchErrors = {};    // step name -> last error, surfaced in ksDebug

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
        _identifyViewer();
      }, 800);

      _startObserver();
      _watchNavigation();
      _listenMessages();
      _listenStorage();
    });
  }

  // ── MutationObserver ───────────────────────────────────────────────────────

  // Two observers, deliberately.
  //
  // Chat filters only ever care about the chat list, but this watched the whole
  // document and pushed EVERY added node anywhere on the page into the queue —
  // player chrome, the viewer-count odometer, overlays — then ran chat and page
  // filters over each one. Scoping the chat observer to the chat container cuts
  // the volume enormously.
  //
  // Page furniture still needs watching, but not per node: it only has to know
  // that *something* changed, and PageFilters coalesces to one pass per 400ms.
  let _pageObserver = null;

  function _startObserver() {
    if (_observer) _observer.disconnect();
    if (_pageObserver) _pageObserver.disconnect();

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

    // The chat container is replaced on navigation and re-render, so fall back
    // to body until it exists and re-attach when it appears.
    const chat = KS.Sel.find(KS.Sel.chatContainer);
    _observer.observe(chat || document.body, { childList: true, subtree: true });
    _observedChat = chat || null;

    _pageObserver = new MutationObserver(() => {
      // No node inspection, no queue — just poke the debounced page pass.
      KS.PageFilters.handleAddedNode(document.body);
      // Not debounced, and not left to the 2s watchdog: a dialog that shows for
      // two seconds before vanishing is the popup this is meant to prevent. The
      // settings check comes first so this costs a property read when off, and
      // one cheap attribute-indexed query per mutation batch when on.
      if (_settings && _settings.page_autoDismissGiftDialog) _autoDismissGiftDialog();
    });
    _pageObserver.observe(document.body, { childList: true, subtree: true });
  }

  // Re-point the chat observer if Kick swaps the container out from under us.
  function _ensureChatObserved() {
    const chat = KS.Sel.find(KS.Sel.chatContainer);
    if (!chat || chat === _observedChat) return;
    _observedChat = chat;
    if (_observer) {
      _observer.disconnect();
      _observer.observe(chat, { childList: true, subtree: true });
      KS.ChatFilters.scanExisting();   // catch anything added while detached
    }
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
      // Chat only. Page filters are driven by their own observer and coalesce
      // to one pass per 400ms — calling them per node here as well was pure
      // duplicate work.
      KS.ChatFilters.handleAddedNode(node);
    }
    const removed = _removedQueue.splice(0);
    for (const { node, target, nextSibling } of removed) {
      KS.ChatFilters.handleRemovedNode(node, target, nextSibling);
    }
    if (_settings.developerMode) _debugOutlineAll();
  }

  // ── SPA navigation ─────────────────────────────────────────────────────────

  // Navigation is detected three ways, because no single one is reliable here.
  //
  // Wrapping history.pushState is the fast path, but it CANNOT be trusted: we
  // run at document_idle, by which point Kick's bundle has loaded and may hold
  // its own reference to the original function. Every call through that
  // reference bypasses the wrapper entirely, and the extension then never
  // learns the page changed — which is exactly how clean chat stopped surviving
  // internal navigation.
  //
  // So the URL itself is also polled on the watchdog. It is a second or two
  // slower, but it cannot be bypassed by anything.
  function _watchNavigation() {
    const wrap = (orig) => function (...args) {
      orig.apply(this, args);
      _checkHref();
    };
    try {
      history.pushState = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
    } catch (_) { /* the poll still covers us */ }

    window.addEventListener('popstate', _checkHref);

    // The Navigation API sees router-driven changes regardless of who holds a
    // reference to what. Present in Chrome; absent elsewhere, hence the guard.
    try {
      if (window.navigation && window.navigation.addEventListener) {
        window.navigation.addEventListener('navigate', () => setTimeout(_checkHref, 0));
      }
    } catch (_) { }
  }

  function _checkHref() {
    if (location.href === _lastHref) return;
    _lastHref = location.href;
    _onNavigate();
  }

  function _onNavigate() {
    const newChannel = KS.Sel.getCurrentChannel();
    const channelChanged = newChannel !== _currentChannel;

    // Two separate concerns, and conflating them broke this twice.
    //
    // RESETTING per-channel state must happen only on a real channel change.
    // Kick rewrites the URL for its own reasons — player state, query params,
    // several times during load — and running the teardown on each of those
    // wiped the filter state, mirror and counters, so the readout kept
    // restarting while you sat on one channel.
    //
    // RE-MOUNTING has to happen on EVERY navigation. Kick re-renders the page
    // and takes our injected UI with it, so guarding the whole function on a
    // channel change meant clean chat simply did not come back after moving
    // around within Kick.
    if (channelChanged) {
      _navCount++;
      _currentChannel = newChannel;
      KS.ChatFilters.destroy();
      // Stats are per-channel and the slug is resolved once at load, so counts
      // would otherwise keep accruing against the channel you started on.
      if (KS.Stats) { KS.Stats.flush(); KS.Stats.setChannel(newChannel); }
      // Chatters are per-channel by definition; carrying them across would
      // report the previous channel's crowd as this one's.
      if (KS.Chatters) KS.Chatters.reset();
      // Explicit, and only here: a different channel means a different count.
      if (KS.ChatFilters.resetCounts) KS.ChatFilters.resetCounts();
    }

    // Tear the UI down and rebuild it on EVERY navigation, not just a channel
    // change. Recovering piecemeal — is the bar still connected, is the readout
    // still inside it — kept missing cases, because React can replace any
    // subset of what we injected and each miss looked like a different bug.
    // Rebuilding is cheap and has one outcome instead of many.
    //
    // Safe for the session count: that lives in ChatFilters and is cleared only
    // by resetCounts() above. Mirror.destroy() also drops the socket, which
    // must happen on a channel change anyway — it would otherwise stay
    // subscribed to the chatroom you just left.
    if (KS.Mirror) KS.Mirror.destroy();

    KS.getEffectiveSettings(newChannel).then((settings) => {
      _settings = settings;
      KS.ChatFilters.init(_settings);
      KS.PageFilters.update(_settings);
      _applyTimestamps(_settings.chat_showTimestamps);
      setTimeout(() => {
        if (KS.Mirror) KS.Mirror.init(_settings);   // remount + resubscribe
        // The chat container is a new element after a re-render, so the
        // observer is pointing at a node that no longer receives messages.
        _startObserver();
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
  //
  // Restoring focus afterwards is only half of it. The damage happens WHILE the
  // field is dead: keys typed during the cooldown reach Kick's hotkeys, so a
  // space pauses the stream. Those keystrokes are swallowed and buffered, then
  // replayed into the input once it comes back.
  let _inputWatch = null;
  let _inputWasDisabled = false;
  let _chatFocusWanted = false;   // was the user actually typing in chat?
  let _keyBuffer = '';
  const KEY_BUFFER_MAX = 500;     // Kick's own limit is lower; this is a sanity cap

  function _inputIsDisabled() {
    const el = KS.Sel.find(KS.Sel.chatInputArea);
    return !!el && !el.isContentEditable;
  }

  // Capture phase on window: run before Kick's own document-level handlers.
  function _swallowKeysDuringCooldown(e) {
    if (!_settings || !_settings.enabled) return;
    if (!_settings.chat_restoreFocusAfterCooldown) return;
    if (!_chatFocusWanted) return;                 // user wasn't typing in chat
    if (e.ctrlKey || e.metaKey || e.altKey) return; // leave real shortcuts alone
    if (document.activeElement !== document.body) return;  // focus is somewhere real
    if (!_inputIsDisabled()) return;

    // Only printable characters and the edits that go with them. Tab, Escape,
    // F-keys and arrows stay functional.
    const printable = e.key && e.key.length === 1;
    const editing = e.key === 'Backspace' || e.key === 'Enter';
    if (!printable && !editing) return;

    e.preventDefault();
    e.stopImmediatePropagation();

    if (e.type !== 'keydown') return;
    if (e.key === 'Backspace') _keyBuffer = _keyBuffer.slice(0, -1);
    else if (e.key === 'Enter') { /* cannot send yet; keep the text */ }
    else if (_keyBuffer.length < KEY_BUFFER_MAX) _keyBuffer += e.key;
  }

  // Put what was typed during the lockout back into the editor. Lexical listens
  // for beforeinput, which execCommand('insertText') raises — so it goes through
  // Kick's own input pipeline rather than us writing to the DOM behind its back.
  function _flushKeyBuffer(el) {
    if (!_keyBuffer) return;
    const text = _keyBuffer;
    _keyBuffer = '';
    try {
      el.focus();
      document.execCommand('insertText', false, text);
    } catch (_) { /* characters are lost, same as without the extension */ }
  }

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
        _flushKeyBuffer(el);          // replay what was typed during the lockout
      } else {
        _keyBuffer = '';              // focus moved on; the text is not wanted
      }
    }, 250);

    // Capture phase, on window, so this runs before Kick's document handlers.
    window.addEventListener('keydown', _swallowKeysDuringCooldown, true);
    window.addEventListener('keypress', _swallowKeysDuringCooldown, true);
  }

  // ── Auto-claim the daily reward (collectible emotes) ───────────────────────
  //
  // Confirmed markup 2026-08-16:
  //   <button aria-label="Claim Your Daily Reward" aria-haspopup="dialog"
  //           aria-expanded="false">
  //     <video src="https://static.kick.com/rewards/reward-available-CTA.webm">
  //
  // aria-haspopup means claiming is two steps: open the dialog, then confirm
  // inside it. The confirm button's markup is unknown, so it is matched by
  // accessible name within a dialog that is actually about rewards — never by
  // guessing a class.
  //
  // Opt-in (page_autoClaimRewards, default off): this acts on the user's
  // account on their behalf, same reasoning as auto-accepting chat rules.
  // The whole exchange happens out of sight: the CTA is hidden, the dialog is
  // hidden the moment it opens, Claim is clicked, and the dialog is closed.
  // A programmatic .click() works on a hidden element, so nothing needs to be
  // visible for any of it.
  //
  // Closing is not optional. This is a Radix dialog: while open it puts
  // `pointer-events: none` on <body> and traps focus. Hiding it and walking
  // away would leave the page unclickable with nothing on screen to explain
  // why — far worse than the popup we were trying to avoid.
  let _claimStage = 0;            // 0 idle · 1 dialog opening · 2 claimed, closing
  let _claimAt = 0;
  let _claimDlg = null;
  let _claimCta = null;
  let _claimTimer = null;
  let _lastClaimAt = 0;   // survives CTA re-renders; element marks do not

  function _rewardDialog() {
    for (const dlg of document.querySelectorAll('[role="dialog"]')) {
      if (/daily reward/i.test(dlg.textContent || '')) return dlg;
    }
    return null;
  }

  function _namedButton(root, re) {
    for (const b of root.querySelectorAll('button')) {
      if (b.disabled) continue;
      const name = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim();
      if (re.test(name)) return b;
    }
    return null;
  }

  function _autoClaimReward() {
    if (!_settings || !_settings.enabled || !_settings.page_autoClaimRewards) {
      // Give the button back when the mode is turned off, otherwise disabling
      // the feature would leave the reward permanently invisible.
      document.querySelectorAll('[data-ks-offstage="reward-cta"]')
        .forEach(el => delete el.dataset.ksOffstage);
      return;
    }

    // Stage 2: claimed — close it and hand the page back.
    if (_claimStage === 2) {
      const dlg = _claimDlg && _claimDlg.isConnected ? _claimDlg : _rewardDialog();
      if (dlg) {
        const close = _namedButton(dlg, /\bclose\b/i);
        if (close) close.click();
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      // Claim went through — record it, then take the CTA off-stage.
      _lastClaimAt = Date.now();
      if (_claimCta && _claimCta.isConnected) _claimCta.dataset.ksOffstage = 'reward-cta';
      _endClaim();
      return;
    }

    // Stage 1: dialog should be up — hide it, then claim.
    if (_claimStage === 1) {
      if (Date.now() - _claimAt > 8000) { _endClaim(); return; }   // give the page back
      const dlg = _rewardDialog();
      if (!dlg) return;                      // still opening
      _claimDlg = dlg;
      dlg.dataset.ksOffstage = 'reward-dialog';  // rendered, but out of sight
      const claim = _namedButton(dlg, /\b(claim|collect)\b/i);
      if (!claim || claim.dataset.ksClaimed) return;
      claim.dataset.ksClaimed = '1';
      claim.click();
      _claimStage = 2;
      return;
    }

    // Stage 0.
    //
    // Hiding and claiming are separate concerns, and the element stays fully
    // readable either way — invisible to the eye, unchanged to querySelector.
    // That is what lets the availability check below work on a button nobody
    // can see.
    const ctas = [];
    for (const btn of document.querySelectorAll('button[aria-label]')) {
      if (!/claim.*reward/i.test(btn.getAttribute('aria-label') || '')) continue;
      // Out of sight whatever its state — claimed, unclaimed, mid-animation.
      // Unconditional, and before any early return: the cooldown below used to
      // skip this, so for an hour after each claim the button reappeared.
      btn.dataset.ksOffstage = 'reward-cta';
      ctas.push(btn);
    }

    // Backstop: React re-renders the CTA, and a fresh element carries none of
    // our marks — so an element-level guard alone re-opened the dialog for an
    // already-collected reward. Rewards are daily; an hour is plenty.
    if (Date.now() - _lastClaimAt < 60 * 60 * 1000) return;

    for (const btn of ctas) {
      if (btn.dataset.ksClaimed) return;

      // Kick states availability in the CTA's own artwork:
      //   .../rewards/reward-available-CTA.webm
      // Only act when the reward is actually there. Without this we clicked
      // whatever the button had become and reopened the dialog on a reward
      // already collected. Read from a hidden element — visibility and
      // readability are independent.
      const art = btn.querySelector('video[src]');
      if (!art || !/reward-available/i.test(art.getAttribute('src') || '')) continue;

      btn.dataset.ksClaimed = '1';
      _claimCta = btn;

      // Blind the dialog BEFORE it exists. Marking it off-stage after the fact
      // left it fully visible until the next watchdog tick — up to 2 seconds of
      // popup, which is the thing this was supposed to avoid. A body class
      // applies the moment Radix mounts the dialog, so there is no gap.
      document.body.classList.add('ks-claiming');

      btn.click();
      _claimStage = 1;
      _claimAt = Date.now();
      // Drive the rest at 100ms, not on the 2s watchdog: the sooner Claim is
      // clicked and the dialog closed, the shorter the page is held hostage by
      // Radix's focus trap.
      clearInterval(_claimTimer);
      _claimTimer = setInterval(_autoClaimReward, 100);
      return;
    }
  }

  // ── Gifted-sub "Congratulations!" dialog ───────────────────────────────────
  //
  // Kick opens a modal when someone gifts you a sub. It cannot simply be hidden:
  // it is a Radix dialog, so it traps focus and leaves pointer-events:none on
  // the body — blanking it visually would leave the page dead behind an
  // invisible modal. It has to be dismissed for real.
  //
  // Identified by its link to /transactions/subscriptions rather than by its
  // heading. "Congratulations!" and "has gifted you a subscription" are
  // translated strings; the href is not, and matching on the text would quietly
  // stop working for anyone not reading Kick in English.
  //
  // Dismissed via the Cross icon for the same reason — "Back to stream" is
  // translated, the icon name is not. Both only close the dialog; the sub was
  // already gifted, so nothing here accepts or declines anything.
  function _autoDismissGiftDialog() {
    if (!_settings || !_settings.enabled || !_settings.page_autoDismissGiftDialog) return;

    for (const dlg of document.querySelectorAll('[role="dialog"]')) {
      if (dlg.dataset.ksDismissed) continue;
      if (!dlg.querySelector('a[href*="/transactions/subscriptions"]')) continue;

      // Out of sight before the click, so it does not flash while Radix runs
      // its close animation.
      dlg.dataset.ksOffstage = 'gift-dialog';
      dlg.dataset.ksDismissed = '1';

      const close = dlg.querySelector('button:has(svg[data-ds-icon="Cross"])');
      if (close) close.click();
    }
  }

  function _endClaim() {
    clearInterval(_claimTimer);
    _claimTimer = null;
    document.body.classList.remove('ks-claiming');
    _claimStage = 0;
    _claimDlg = null;
    _claimCta = null;
  }

  // Who is watching. Needed so a message that @-mentions you is exempt from
  // every filter. Asked once per page; if it fails the name stays empty and the
  // exemption simply never triggers — better than guessing a name and exempting
  // a stranger.
  // /api/v1/user was tried first and returns {} — confirmed live, not a guess
  // worth repeating. The header avatar carries the name in its alt text, which
  // has the advantage of being user-visible: if Kick changes it, the breakage is
  // observable rather than silent.
  //
  // The header renders after our 800ms boot on a cold load, so this retries a
  // few times and then gives up. Failing means _mentionsMe stays false, which
  // costs an exemption; guessing a name would exempt a stranger from every
  // filter, which is worse.
  function _identifyViewer(attempt) {
    if (!KS.ChatFilters || !KS.ChatFilters.setViewer) return;
    attempt = attempt || 0;

    const imgs = document.querySelectorAll('header img[alt], nav img[alt]');
    for (const img of imgs) {
      const alt = (img.alt || '').trim();
      // The Kick wordmark sits in the same bar and also carries an alt.
      if (alt && !/kick\s*logo/i.test(alt)) { KS.ChatFilters.setViewer(alt); return; }
    }

    // Fallback: several localStorage entries embed the logged-in identity as
    // JSON. Read any "username":"..." rather than depending on one key name —
    // the one seen live is a fingerprinting cache key, which is not something to
    // rely on by name.
    for (let i = 0; i < localStorage.length; i++) {
      const v = localStorage.getItem(localStorage.key(i)) || '';
      const m = v.match(/"username"\s*:\s*"([^"]+)"/);
      if (m && m[1]) { KS.ChatFilters.setViewer(m[1]); return; }
    }

    if (attempt < 4) setTimeout(() => _identifyViewer(attempt + 1), 1500);
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

    // Each step is isolated. These ran as one block, so the first one to throw
    // silently skipped everything after it — including _publishDebugState, which
    // meant the debug attribute went stale and reported a healthy page that no
    // longer existed. A watchdog whose failures are invisible is worse than no
    // watchdog, because it is trusted.
    const steps = [
      ['button',   () => { const w = document.getElementById('ks-page-wrapper');
                           if (!w || !w.isConnected) _injectPageButton(); }],
      // The mode bar and mirror live in Kick's chat column and are destroyed by
      // the same React re-renders, so they need the same watchdog.
      ['mount',    () => { if (KS.Mirror && KS.Mirror.ensureMounted) KS.Mirror.ensureMounted(); }],
      ['bar',      () => { if (KS.Mirror && KS.Mirror.renderModeBar) KS.Mirror.renderModeBar(); }],
      ['nav',      _checkHref],          // backstop: navigation the wrapper missed
      ['observer', _ensureChatObserved],
      ['rules',    _autoAcceptChatRules],
      ['reward',   _autoClaimReward],
    ];

    _btnWatch = setInterval(() => {
      for (const [name, fn] of steps) {
        try { fn(); }
        catch (e) { _watchErrors[name] = String((e && e.message) || e); }
      }
      // Always last, and outside the loop's failure handling, so the state is
      // published even when several steps are failing.
      try { _publishDebugState(); } catch (_) { }
    }, 2000);
  }

  // Publish state to the page world.
  //
  // Content scripts live in an isolated world, so window.KS is invisible from
  // the page console — which makes the extension hard to diagnose from a real
  // browser session, and impossible for a tester to report on. This mirrors the
  // few numbers that matter onto an attribute anything can read:
  //
  //   document.documentElement.dataset.ksDebug
  //
  // One small attribute written every 2s. No PII: counts and flags only.
  function _publishDebugState() {
    try {
      const sock = (KS.ChatFilters && KS.ChatFilters.socketStats)
        ? KS.ChatFilters.socketStats() : null;
      const chat = (KS.Chatters && KS.Chatters.stats)
        ? KS.Chatters.stats((_settings && _settings.chat_chattersWindow) || 15) : null;

      document.documentElement.dataset.ksDebug = JSON.stringify({
        v: chrome.runtime.getManifest().version,
        topFrame: window.top === window.self,
        enabled: !!(_settings && _settings.enabled),
        cleanChat: !!(_settings && _settings.chat_mirrorMode),
        socketUp: !!(KS.ChatSocket && KS.ChatSocket.isConnected && KS.ChatSocket.isConnected()),
        socketMsgs: sock ? sock.seen : null,
        filtered: sock ? sock.filtered : null,
        chatters: chat ? chat.chatters : null,
        mirrorUp: !!document.getElementById('ks-mirror'),
        // Geometry, because "mounted" and "visible in the right place" are not
        // the same thing: the mirror can exist, be correctly populated, and
        // still be zero-height, pushed off, or sitting under Kick's own list.
        geom: (() => {
          const h = document.getElementById('ks-mirror');
          const b = document.querySelector('.ks-mirror-header');
          const k = document.querySelector('[data-testid="chatroom-messages"]');
          const box = el => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width) };
          };
          return {
            onClass: document.body.classList.contains('ks-mirror-on'),
            mirror: box(h),
            mirrorTopStyle: h ? h.style.top : null,
            bar: box(b),
            kick: box(k),
            kickOpacity: k ? getComputedStyle(k).opacity : null,
          };
        })(),
        barUp: !!document.querySelector('.ks-mirror-header'),
        mirrorRows: document.querySelectorAll('#ks-mirror .ks-mirror-row').length,
        channel: _currentChannel || null,
        navs: _navCount,
        at: new Date().toLocaleTimeString(),   // so a stale read is obvious
        errors: Object.keys(_watchErrors).length ? _watchErrors : null,
        sock: (KS.ChatSocket && KS.ChatSocket.stats) ? KS.ChatSocket.stats() : null,
      });
    } catch (_) { /* diagnostics must never break the page */ }
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
