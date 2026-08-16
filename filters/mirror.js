// mirror.js — "Clean chat" mode.
//
// Kick's chat is a virtualised list: every row is
//   <div data-index="N" class="absolute inset-x-0 top-0" style="transform: translateY(9400px)">
// positioned absolutely at an offset the virtualiser computed once, and the
// container's height is set explicitly. Hiding a row therefore cannot close the
// space it occupied — verified 2026-08-16: display:none on the row, on its
// parent, and a zero-height collapsed box all leave following rows at dy = 0.
//
// So instead of subtracting from their list, we copy what survives filtering
// into a list of our own, in normal flow, and hide theirs. Nothing on Kick's
// side is mutated except the visibility of the original container.
//
// What clones keep (verified live): emotes, badges, timestamps, reply previews,
// notice cards, and CDN images.
// What clones lose: React event handlers — a cloned username does not open
// Kick's user modal. Clicks are forwarded to the original node to compensate;
// see _forwardClick for the limits of that.

window.KS = window.KS || {};

KS.Mirror = (function () {
  const MAX_ROWS = 200;          // prune beyond this; the mirror grows forever otherwise
  const HARD_MAX = 600;          // ceiling while scrolled up, when pruning is deferred
  const STICK_PX = 60;           // treat "within 60px of bottom" as pinned
  const HEADER_H = 24;           // must match .ks-mirror-header height in content.css
  const ODO_CELL_EM = 1.15;      // must match .ks-odo-strip > span height

  let _settings = null;
  let _host = null;              // our list
  let _origList = null;          // Kick's #chatroom-messages
  let _stick = true;             // autoscroll enabled (user is at the bottom)
  let _origins = new WeakMap();  // clone -> original row, for click forwarding
  let _bar = null;               // header bar (outside the scroll list)
  let _countEl = null;           // "N filtered" readout in the header
  let _barMode = null;           // 'clean' | 'kick' — bar is rebuilt only on change

  // Theme id → picker label. The id doubles as the body class suffix (ks-<id>),
  // so a new theme is one entry here plus one block in content.css — nothing
  // else in this file needs to know the list.
  const THEMES = [
    ['normal',     'Normal'],
    ['clown',      '🤡 Clown'],
    ['terminal',   '💻 Terminal'],
    ['amber',      '🟠 CRT Amber'],
    ['typewriter', '📄 Typewriter'],
    ['contrast',   '◐ High Contrast'],
    ['minimal',    '· Minimal'],
  ];
  let _odoEl = null;             // rolling-digit odometer inside it
  let _isMod = false;            // viewer can moderate (mod controls seen)
  let _noticeDismissed = false;  // moderator chose to stay on clean chat

  // Socket-supplied message ids, waiting to be attached to a cloned row.
  // Keyed by "username|text". The socket beats the rendered row by roughly
  // 440ms (measured), so the id is normally already here when we clone.
  const _pendingIds = new Map();
  const ID_TTL_MS = 30000;

  // Message-identity dedupe. The virtualiser destroys and re-creates rows, so a
  // per-element marker cannot tell "same message rendered again" from "new
  // message" — these keys can.
  const _seenKeys = new Set();
  const _seenOrder = [];

  // username + clock time + text. Enough to identify a message across
  // re-renders without needing an id Kick does not put in the DOM.
  function _msgKey(msgEl) {
    const cf = KS.ChatFilters;
    const user = (cf && cf.getUsername ? cf.getUsername(msgEl) : '') || '';
    const text = (cf && cf.getMessageText ? cf.getMessageText(msgEl) : '') || '';
    const time = (msgEl.querySelector('span.text-neutral')?.textContent || '').trim();
    if (!user && !text) return '';
    return user + '|' + time + '|' + text.slice(0, 160);
  }

  // The virtualiser's own sequence number. DOM order is meaningless here —
  // recycled rows are reinserted anywhere — so this is what orders the mirror.
  function _rowIndex(msgEl) {
    const wrap = msgEl.closest ? msgEl.closest('[data-index]') : null;
    const n = wrap ? parseInt(wrap.dataset.index, 10) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  // Insert keeping ascending data-index. New messages have the highest index,
  // so the backward walk exits immediately in the common case.
  function _insertOrdered(clone, idx) {
    if (idx === null) { _host.appendChild(clone); return; }
    clone.dataset.ksIdx = String(idx);
    const rows = _host.querySelectorAll('.ks-mirror-row');
    for (let i = rows.length - 1; i >= 0; i--) {
      const other = parseInt(rows[i].dataset.ksIdx, 10);
      if (!Number.isFinite(other) || other <= idx) {
        rows[i].after(clone);
        return;
      }
    }
    const first = _host.querySelector('.ks-mirror-row');
    if (first) first.before(clone); else _host.appendChild(clone);
  }

  function _key(username, text) {
    return (username || '').toLowerCase() + '|' + (text || '').trim().slice(0, 120);
  }

  function _rememberId(msg) {
    if (!msg || !msg.id) return;
    _pendingIds.set(_key(msg.username, msg.content), { id: msg.id, t: Date.now() });
    if (_pendingIds.size > 400) {
      const cutoff = Date.now() - ID_TTL_MS;
      for (const [k, v] of _pendingIds) if (v.t < cutoff) _pendingIds.delete(k);
    }
  }

  function _takeId(username, text) {
    const k = _key(username, text);
    const hit = _pendingIds.get(k);
    if (!hit) return null;
    _pendingIds.delete(k);
    return (Date.now() - hit.t <= ID_TTL_MS) ? hit.id : null;
  }


  // Kick labels its icons with data-ds-icon. The reply control uses the curved
  // back-arrow — the same icon that heads a rendered reply preview
  // ("ArrowCurveLeft", captured live 2026-08-16). Matched loosely, and by
  // aria-label too, because this is the one control we deliberately keep and
  // an icon rename should degrade to "no reply button" rather than "wrong
  // button forwarded".
  function _iconName(btn) {
    const svg = btn.querySelector('svg[data-ds-icon]');
    return svg ? (svg.dataset.dsIcon || '') : '';
  }

  function _isReplyControl(btn) {
    if (/reply/i.test(btn.getAttribute('aria-label') || '')) return true;
    return /arrowcurve|reply/i.test(_iconName(btn));
  }

  // The still-rendered original for a mirrored row, by element reference or,
  // once the virtualiser has recycled it, by identity.
  function _liveOriginal(cloneRow) {
    let src = _origins.get(cloneRow);
    if (!src || !src.isConnected) {
      src = _findLiveRow(cloneRow);
      if (src) _origins.set(cloneRow, src);
    }
    return src || null;
  }

  // ── Deletions Kick renders in place (moderator view) ───────────────────────
  //
  // For moderators Kick keeps a deleted message on screen, struck through and
  // suffixed "(Deleted)". Non-mods just lose the row. So a mod gets a DOM
  // signal for deletion without the socket — but it arrives as a re-rendered
  // element, which is why it slipped past dedupe and doubled up.

  function _isDeletedRender(msgEl) {
    if (msgEl.querySelector('s, del, [class*="line-through"]')) return true;
    return /\(\s*deleted\s*\)\s*$/i.test((msgEl.textContent || '').trim());
  }

  // Identity of the message BEFORE Kick appended its deleted marker, so it can
  // be matched against the row already in the mirror.
  function _deletedBaseKey(msgEl) {
    const cf = KS.ChatFilters;
    const user = (cf && cf.getUsername ? cf.getUsername(msgEl) : '') || '';
    const time = (msgEl.querySelector('span.text-neutral')?.textContent || '').trim();
    let text = ((cf && cf.getMessageText ? cf.getMessageText(msgEl) : '') || '').trim();
    text = text.replace(/\(\s*deleted\s*\)\s*$/i, '').trim();
    return user + '|' + time + '|' + text.slice(0, 160);
  }

  function _applyDeletion(msgEl) {
    if (!_host) return;
    const base = _deletedBaseKey(msgEl);
    const row = _host.querySelector(`.ks-mirror-row[data-ks-key="${CSS.escape(base)}"]`);
    if (!row) return;
    // Respect the existing preference: keep it visibly struck, or drop it.
    if (_settings && _settings.chat_keepDeletedMessages) row.dataset.ksDeleted = 'true';
    else row.remove();
    _updateCount();
  }

  // ── Moderation, driven by the socket ───────────────────────────────────────

  function _onDeleted(msgId) {
    if (!_host || !msgId) return;
    const row = _host.querySelector(`[data-ks-msg-id="${CSS.escape(msgId)}"]`);
    if (row) row.remove();
  }

  function _onBanned(username) {
    if (!_host || !username) return;
    const u = username.toLowerCase();
    _host.querySelectorAll('.ks-mirror-row').forEach((row) => {
      if ((row.dataset.ksUser || '').toLowerCase() === u) row.remove();
    });
  }

  function _onCleared() {
    if (!_host) return;
    // Keep the toolbar; only the messages are cleared.
    _host.querySelectorAll('.ks-mirror-row').forEach(r => r.remove());
  }

  // ── Moderator affordances ──────────────────────────────────────────────────
  //
  // Clones carry no React handlers, so per-message mod controls cannot work in
  // the mirror — they are stripped rather than shown dead. A moderator needs to
  // know that, and needs a one-click way back to Kick's own chat.

  function _noteModerator() {
    if (_isMod) return;
    _isMod = true;
    _renderModNotice();
  }

  function _renderModNotice() {
    if (!_origList || !_origList.parentElement) return;
    if (_origList.parentElement.querySelector('.ks-mirror-modnotice')) return;
    if (_noticeDismissed) return;

    const note = document.createElement('div');
    note.className = 'ks-mirror-modnotice';
    note.innerHTML =
      '<span>You moderate this channel. Delete, timeout, ban and pin are not ' +
      'available on clean chat messages.</span>';

    const useKick = document.createElement('button');
    useKick.className = 'ks-mirror-btn ks-primary';
    useKick.textContent = "Use Kick's chat";
    useKick.addEventListener('click', switchToKickChat);

    const dismiss = document.createElement('button');
    dismiss.className = 'ks-mirror-btn';
    dismiss.textContent = 'Keep clean chat';
    dismiss.addEventListener('click', () => {
      _noticeDismissed = true;
      note.remove();
      _layout();
    });

    note.appendChild(useKick);
    note.appendChild(dismiss);

    // Outside the scrolling list. As its first child it was pushed out of view
    // by autoscroll the moment a message arrived, so a moderator never saw it.
    _origList.parentElement.appendChild(note);
    _layout();
  }

  // The header and the notice are overlaid above the list, so the list has to
  // start below whatever is currently showing.
  function _layout() {
    const parent = _origList && _origList.parentElement;

    // Measured, never assumed. The bar is two rows, its height changes with the
    // theme row, and Kick's pinned message sits above the chat — an unhidden
    // pinned post overlapped our header and the top of the list.
    const barH = (_bar && _bar.isConnected)
      ? Math.ceil(_bar.getBoundingClientRect().height) : 0;

    const note = parent ? parent.querySelector('.ks-mirror-modnotice') : null;
    const noteH = note ? Math.ceil(note.getBoundingClientRect().height) : 0;

    // Anything Kick stacks above the list (pinned message) pushes us down with
    // it, rather than being covered by us or covering us.
    let pinnedH = 0;
    if (parent) {
      const pinned = parent.querySelector('[data-testid^="pinned-message"]');
      if (pinned && !pinned.dataset.ksHidden) {
        const pr = pinned.getBoundingClientRect();
        const cr = parent.getBoundingClientRect();
        if (pr.height && pr.bottom > cr.top) {
          pinnedH = Math.ceil(Math.min(pr.bottom - cr.top, cr.height * 0.6));
        }
      }
    }

    if (_bar) _bar.style.top = pinnedH + 'px';
    if (note) note.style.top = (pinnedH + barH) + 'px';
    if (_host) _host.style.top = (pinnedH + barH + noteH) + 'px';

    // In Kick-chat mode the bar would sit on top of their list, so shrink the
    // container's content box instead of covering messages. Kick's list is
    // h-full, so padding on the parent gives it the right height for free.
    if (parent) parent.style.paddingTop = (!isOn() && barH) ? (pinnedH + barH) + 'px' : '';
  }

  // Persistent mode bar. Present in BOTH modes so the switch is always one
  // click away — previously it lived with the mirror, so switching to Kick's
  // chat took the only way back with it. Lives OUTSIDE the scrolling list:
  // inside it, it would scroll away and be caught by the row pruner.
  // Hidden entirely when chat_showModeToggle is off.
  function renderModeBar() {
    if (!_settings || !_settings.enabled || _settings.chat_showModeToggle === false) {
      _removeBar();
      return;
    }
    const list = _origList && _origList.isConnected
      ? _origList : (_origList = KS.Sel.find(KS.Sel.chatContainer));
    if (!list || !list.parentElement) return;

    const on = isOn();

    if (!_bar || !_bar.isConnected) {
      _bar = document.createElement('div');
      _bar.className = 'ks-mirror-header';
      list.parentElement.appendChild(_bar);
      _barMode = null;                        // force a build
    }

    // Rebuilding wholesale on every watchdog tick tore out the <select> while
    // it was open, so the theme dropdown could never be used. Only rebuild when
    // the mode actually changes; otherwise just refresh the number.
    if (_barMode === (on ? 'clean' : 'kick')) {
      _updateCount();
      return;
    }
    _barMode = on ? 'clean' : 'kick';
    _bar.innerHTML = '';

    const label = document.createElement('span');
    label.className = 'ks-mirror-label' + (on ? '' : ' ks-off');
    label.innerHTML = on
      ? '<span class="ks-mirror-dot">🧹</span> Clean'
      : '<span class="ks-mirror-dot">💬</span> Kick';

    _countEl = document.createElement('span');
    _countEl.className = 'ks-mirror-count';

    const btn = document.createElement('button');
    btn.className = 'ks-mirror-btn';
    btn.title = on ? "Switch to Kick's chat" : 'Switch to clean chat';
    btn.textContent = on ? '⇄ Kick' : '⇄ Clean';
    btn.addEventListener('click', () => _setMirror(!on));

    // Theme picker. Lives in the bar rather than the popup because it is the
    // sort of thing you flip mid-stream for a laugh, not a setting you go and
    // configure.
    const theme = document.createElement('select');
    theme.className = 'ks-mirror-select';
    theme.title = 'Chat appearance';
    for (const [value, text] of THEMES) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      if ((_settings.chat_theme || 'normal') === value) o.selected = true;
      theme.appendChild(o);
    }
    theme.addEventListener('change', () => {
      if (KS.updateSettings) KS.updateSettings({ chat_theme: theme.value });
      applyTheme(Object.assign({}, _settings, { chat_theme: theme.value }));
    });

    const hide = document.createElement('button');
    hide.className = 'ks-mirror-btn ks-mirror-hide';
    hide.title = 'Hide this bar (re-enable in settings)';
    hide.setAttribute('aria-label', 'Hide mode bar');
    hide.textContent = '×';
    hide.addEventListener('click', () => {
      if (KS.updateSettings) KS.updateSettings({ chat_showModeToggle: false });
      _removeBar();
    });

    // Controls row, ABOVE the status row — appearance now, more later.
    const controls = document.createElement('div');
    controls.className = 'ks-mirror-controls';
    controls.appendChild(theme);

    // Status row: which mode you are in, how much has been filtered, the way out.
    const row1 = document.createElement('div');
    row1.className = 'ks-mirror-row1';
    row1.appendChild(label);
    row1.appendChild(_countEl);
    row1.appendChild(btn);
    row1.appendChild(hide);

    _bar.appendChild(controls);
    _bar.appendChild(row1);
    _updateCount();
    _layout();
    _hideNewMessagesIndicator();
    _layout();          // pinned messages appear and vanish on their own
  }

  // Kick shows an "N new messages" affordance whenever its list is not scrolled
  // to the bottom. In clean chat we never scroll their list, so it drifts and
  // counts everything as unseen — including messages already sitting in our own
  // list. The number is meaningless here, so hide it.
  //
  // Matched on text rather than a selector: the element's markup is unknown and
  // guessing Kick's class names has been wrong every time. Restricted to the
  // chat column, to leaf-ish nodes, and never inside our own list.
  function _hideNewMessagesIndicator() {
    if (!isOn()) return;
    const col = _origList && _origList.parentElement;
    if (!col) return;

    // The wrapper, which is the reliable target. Captured live 2026-08-16:
    //   <div class="absolute right-0 bottom-2 left-0 grid grid-cols-1
    //               items-center justify-items-center">
    // It sits in the DOM permanently and is EMPTY until hover — which is why
    // matching the pill's text could only ever react after it appeared, and why
    // it is impossible to inspect in DevTools (moving to the console drops the
    // hover and the contents vanish). Marking the container once ends the
    // flicker: there is nothing to reveal.
    for (const el of col.querySelectorAll('div[class*="bottom-2"]')) {
      if (el.dataset.ksHidden) continue;
      if (_host && _host.contains(el)) continue;
      const c = el.classList;
      if (!c.contains('absolute') || !c.contains('grid')) continue;
      el.dataset.ksHidden = 'new-messages-indicator';
    }

    // Text match kept as a fallback, in case Kick restyles that wrapper.
    for (const el of col.querySelectorAll('div,button,span')) {
      if (el.dataset.ksHidden) continue;
      if (_host && _host.contains(el)) continue;          // never our own rows
      if (el.children.length > 3) continue;               // want the small node
      const t = (el.textContent || '').trim();
      if (t.length > 32) continue;                        // not a message
      if (!/^\d*\s*new messages?$/i.test(t)) continue;
      el.dataset.ksHidden = 'new-messages-indicator';
    }
  }

  // Kick reveals the pill on hover, and our list sits inside their column, so
  // hovering a mirrored message puts the pointer over their container too. On
  // the 2s pass alone it flashed into view every time. Catch it on the hover
  // that summons it — throttled, since mouseover fires constantly.
  let _hoverThrottle = 0;
  function _onColumnHover() {
    const now = Date.now();
    if (now - _hoverThrottle < 150) return;
    _hoverThrottle = now;
    _hideNewMessagesIndicator();
  }

  function _showNewMessagesIndicator() {
    document.querySelectorAll('[data-ks-hidden="new-messages-indicator"]')
      .forEach(el => delete el.dataset.ksHidden);
  }

  // Only ever styles OUR list — Kick's chat stays untouched in every theme.
  function applyTheme(settings) {
    const t = (settings && settings.chat_theme) || 'normal';
    for (const [id] of THEMES) {
      if (id !== 'normal') document.body.classList.toggle('ks-' + id, t === id);
    }
    // Independent of theme, so it rides along here rather than in a filter:
    // this hides part of a message, not the message, and the mirror is styled
    // entirely from CSS.
    document.body.classList.toggle('ks-hide-level-badges',
      !settings || settings.chat_hideLevelBadges !== false);
    document.body.classList.toggle('ks-hide-mod-badges',
      !!(settings && settings.chat_hideModBadges));
    document.body.classList.toggle('ks-hide-other-badges',
      !!(settings && settings.chat_hideOtherBadges));
  }

  function _removeBar() {
    if (_bar) { _bar.remove(); _bar = null; }
    _barMode = null;
    _countEl = null;
    _odoEl = null;
    _odoEl = null;
    _layout();
  }

  function _setMirror(on) {
    if (KS.updateSettings) KS.updateSettings({ chat_mirrorMode: !!on });
    else update(Object.assign({}, _settings, { chat_mirrorMode: !!on }));
  }

  // Shows what clean chat is actually doing for you. Counts come from KS.Stats,
  // which is incremented at every hide, so this covers all filters rather than
  // just the ones the mirror sees.
  function _updateCount() {
    if (!_countEl) return;
    let n = 0;
    // Messages filtered, deduped by identity — not KS.Stats.sessionTotal(),
    // which also counts page furniture andeach emote strip.
    try { n = (KS.ChatFilters && KS.ChatFilters.filteredCount) ? KS.ChatFilters.filteredCount() : 0; } catch (_) { }

    if (!n) { _countEl.innerHTML = ''; _countEl.title = ''; return; }
    _countEl.title = 'Messages filtered out since this tab loaded';

    if (!_odoEl || !_odoEl.isConnected) {
      _countEl.innerHTML = '';
      _odoEl = document.createElement('span');
      _odoEl.className = 'ks-odo';
      _countEl.appendChild(_odoEl);
    }
    _setOdometer(_odoEl, n);
  }

  // Car-odometer readout: each digit is a window onto a 0-9 strip that slides.
  // Only the transform changes per update, so the browser animates it on the
  // compositor — this ticks on every message, so it must not cause layout.
  function _setOdometer(host, value) {
    const s = String(value);

    // Rebuild only when the number of digits changes (9 -> 10, 99 -> 100).
    if (host.childElementCount !== s.length) {
      host.innerHTML = '';
      for (let i = 0; i < s.length; i++) {
        const digit = document.createElement('span');
        digit.className = 'ks-odo-digit';
        const strip = document.createElement('span');
        strip.className = 'ks-odo-strip';
        for (let d = 0; d <= 9; d++) {
          const cell = document.createElement('span');
          cell.textContent = String(d);
          strip.appendChild(cell);
        }
        digit.appendChild(strip);
        host.appendChild(digit);
      }
    }

    for (let i = 0; i < s.length; i++) {
      const strip = host.children[i].firstElementChild;
      const d = Number(s[i]);
      if (strip.dataset.d === String(d)) continue;   // already showing it
      strip.dataset.d = String(d);
      // Must match .ks-odo-strip > span height in content.css, or the digits
      // drift out of register as the number climbs.
      strip.style.transform = `translateY(${-d * ODO_CELL_EM}em)`;
    }
  }

  function switchToKickChat() { _setMirror(false); }

  function isOn() {
    return !!(_settings && _settings.enabled && _settings.chat_mirrorMode);
  }

  function init(settings) {
    _settings = settings;
    if (isOn()) _mount(); else _unmount();
    applyTheme(settings);
    renderModeBar();          // the bar exists in both modes
  }

  function update(settings) {
    const was = isOn();
    _settings = settings;
    const now = isOn();
    if (now && !was) _mount();
    else if (!now && was) _unmount();
    applyTheme(settings);
    renderModeBar();          // re-label for the new mode, or drop if hidden
  }

  function destroy() { _unmount(); }

  // ── Mount / unmount ────────────────────────────────────────────────────────

  function _mount() {
    _origList = KS.Sel.find(KS.Sel.chatContainer);
    if (!_origList || !_origList.parentElement) return;   // chat not ready yet
    if (_host && _host.isConnected) return;

    _host = document.createElement('div');
    _host.id = 'ks-mirror';
    _host.setAttribute('role', 'log');
    _host.setAttribute('aria-live', 'polite');

    _origList.parentElement.insertBefore(_host, _origList.nextSibling);
    document.body.classList.add('ks-mirror-on');

    // Rows carry inline styles like `font-size: var(--chatroom-font-size)` and
    // `padding-block: var(--chatroom-message-spacing)`. If Kick defines those
    // custom properties on the chat container itself rather than an ancestor,
    // a clone outside it resolves them to nothing. Copy whatever is set.
    try {
      const cs = getComputedStyle(_origList);
      for (const v of ['--chatroom-font-size', '--chatroom-message-spacing',
                       '--chat-width']) {
        const val = cs.getPropertyValue(v);
        if (val && val.trim()) _host.style.setProperty(v, val.trim());
      }
      // NOT copied: --chatroom-timestamps-display. Kick sets it to `none` when
      // its own timestamp option is off, and the cloned span reads
      // `display: var(--chatroom-timestamps-display)` — inheriting that value
      // hides timestamps in our list too. The mirror is our surface and the
      // timestamp is worth keeping, so pin it visible here.
      _host.style.setProperty('--chatroom-timestamps-display', 'inline');
    } catch (_) { }

    _host.addEventListener('scroll', _onScroll, { passive: true });
    if (_origList.parentElement) {
      _origList.parentElement.addEventListener('mouseover', _onColumnHover, { passive: true });
    }
    _host.addEventListener('click', _forwardClick, true);

    // Deletions name a message id and nothing else, so the socket is the only
    // way to know which row to drop. Connected only while mirror mode is on.
    if (KS.ChatSocket && KS.Sel.getCurrentChannel) {
      const slug = KS.Sel.getCurrentChannel();
      if (slug) KS.ChatSocket.connect(slug, {
        message: _rememberId,
        deleted: _onDeleted,
        banned: _onBanned,
        cleared: _onCleared,
      });
    }

    renderModeBar();
    if (_isMod) _renderModNotice();   // re-show after a remount in the same tab

    // Seed from whatever is already rendered so the pane is not empty on enable.
    if (KS.ChatFilters && KS.ChatFilters.scanExisting) KS.ChatFilters.scanExisting();
    _scrollToBottom();
  }

  // Hand Kick's chat back exactly as we found it.
  //
  // Everything we write while clean chat is on lives on their rows, and a
  // half-cleaned list is what "the Kick chat is broken" looked like: messages
  // still hidden, emotes still stripped, gift blocks still collapsed. Do not
  // rely on the settings-change path to tidy up — clear it here, on the way
  // out, unconditionally.
  function _restoreKickChat() {
    const root = (_origList && _origList.isConnected)
      ? _origList : KS.Sel.find(KS.Sel.chatContainer);
    if (!root) return;

    root.querySelectorAll('[data-ks-hidden]').forEach(el => delete el.dataset.ksHidden);
    root.querySelectorAll('[data-ks-emote-hidden]').forEach(el => delete el.dataset.ksEmoteHidden);
    root.querySelectorAll('[data-ks-collapsed]').forEach(el => delete el.dataset.ksCollapsed);
    root.querySelectorAll('[data-ks-mirrored]').forEach(el => delete el.dataset.ksMirrored);
    root.querySelectorAll('[data-ks-seen]').forEach(el => delete el.dataset.ksSeen);
    // Anything we inserted into their list.
    root.querySelectorAll('.ks-gift-collapsed, .ks-copypasta-indicator').forEach(el => el.remove());
    root.querySelectorAll('[data-ks-deleted]').forEach(el => el.remove());
  }

  function _unmount() {
    if (KS.ChatSocket) KS.ChatSocket.disconnect();
    _showNewMessagesIndicator();
    _restoreKickChat();
    _pendingIds.clear();
    _seenKeys.clear();
    _seenOrder.length = 0;
    _origins = new WeakMap();
    // Per-channel, not per-session: you are not a moderator everywhere, and the
    // notice should be re-offered on a channel where you are.
    _isMod = false;
    _noticeDismissed = false;
    document.body.classList.remove('ks-mirror-on');
    for (const [id] of THEMES) document.body.classList.remove('ks-' + id);
    document.body.classList.remove('ks-hide-level-badges');
    document.body.classList.remove('ks-hide-mod-badges');
    document.body.classList.remove('ks-hide-other-badges');
    if (_host) {
      _host.removeEventListener('scroll', _onScroll);
      if (_origList && _origList.parentElement) {
        _origList.parentElement.removeEventListener('mouseover', _onColumnHover);
      }
      _host.removeEventListener('click', _forwardClick, true);
      _host.remove();
    }
    if (_origList && _origList.parentElement) {
      const n = _origList.parentElement.querySelector('.ks-mirror-modnotice');
      if (n) n.remove();
    }
    _countEl = null;
    _host = null;
    _origins = new WeakMap();
    // Clear the mirrored marks so re-enabling refills rather than skipping.
    document.querySelectorAll('[data-ks-mirrored]')
      .forEach(el => delete el.dataset.ksMirrored);
  }

  // ── Ingest ─────────────────────────────────────────────────────────────────

  // The row and its [data-index] wrapper only. Per-message suppression has to
  // live on one of those two; anything higher is the chat panel itself, and
  // walking further would cost a forced style recalc per ancestor per message —
  // ingest runs interleaved with our own writes into the mirror, so every
  // getComputedStyle here is a fresh recalc rather than a cached read.
  function _isSuppressedByKick(msgEl) {
    let el = msgEl;
    for (let depth = 0; el && depth < 2; el = el.parentElement, depth++) {
      if (el.dataset && el.dataset.ksHidden) return true;   // our own doing, not Kick's
      let cs;
      try { cs = getComputedStyle(el); } catch (_) { return false; }
      if (!cs) return false;
      if (cs.display === 'none') return true;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
      if (parseFloat(cs.opacity) === 0) return true;
    }
    return false;
  }

  // Tag badges on the clone so CSS can hide them by kind without encoding
  // Kick's nesting. A badge is img → tooltip div → sized div inside a shared
  // container, and EVERY level of that reserves space, so all of them need the
  // class — hiding the img alone leaves a full-width flex item behind.
  //
  // The climb stops at the first ancestor holding more than one badge: that is
  // the container, and tagging it would take every badge down together. When a
  // message has only one badge the container does get tagged, which is right —
  // it is empty at that point and still carries its own padding.
  function _tagBadges(clone) {
    const roots = new Set();
    clone.querySelectorAll('[data-testid^="identity-badge-"]').forEach(e => roots.add(e));
    clone.querySelectorAll('img[src*="/chat/badges/"], img[src*="subscriber_badges"]')
      .forEach(i => roots.add(i.closest('[data-testid^="identity-badge-"]') || i));

    const count = el => [...roots].filter(r => el === r || el.contains(r)).length;

    for (const root of roots) {
      const testid = root.getAttribute && (root.getAttribute('data-testid') || '');
      const alt = (root.querySelector && root.querySelector('img[alt]')
        ? root.querySelector('img[alt]').alt : root.alt) || '';
      const isMod = /moderator|broadcaster|host/i.test(testid + ' ' + alt);
      const isLevel = /^level\s/i.test(alt);

      for (let el = root; el && el !== clone; el = el.parentElement) {
        if (el !== root && count(el) > 1) break;
        el.classList.add('ks-badge', isMod ? 'ks-badge-mod' : 'ks-badge-other');
        if (isLevel) el.classList.add('ks-badge-level');
      }
    }
  }

  // Called by chatFilters for every message that survived every filter.
  // `msgEl` is the child of [data-index] — the element KS.Sel.chatMessage picks.
  function ingest(msgEl) {
    if (!isOn() || !msgEl) return;
    if (!_host || !_host.isConnected) { _mount(); if (!_host) return; }
    // Only real messages and notice cards. Kick also renders separators such as
    // the "New messages" divider as [data-index] rows, and those were being
    // copied in as if they were chat.
    const isMessage = !!msgEl.querySelector('button[data-prevent-expand]')
                   || !!msgEl.querySelector('div[class*="border-l-4"]');
    if (!isMessage) return;

    // Never surface what Kick has chosen not to show.
    //
    // Muting is a client-side feature: Kick decides per message whether you see
    // it. If it drops muted messages before render this is a no-op. If instead
    // it renders the row and hides it with CSS, the mirror would have cloned it
    // and put a muted user back on screen — the one thing a chat cleaner must
    // never do. Checking the rendered result rather than the mechanism covers
    // both, and any future client-side suppression we do not know about.
    //
    // Deliberate-hiding properties only. Size and scroll position are not
    // consulted: rows live in a virtualiser and are routinely off-screen or
    // mid-layout, and treating that as hidden would drop real messages.
    if (_isSuppressedByKick(msgEl)) return;

    // Element-identity marking is not enough: the virtualiser destroys and
    // RE-CREATES rows (observed live — reappearing rows gain a
    // --chatroom-mod-actions-display div the originals lack), so the same
    // message arrives as a brand new node with no marker and was mirrored
    // again. Key on the message itself instead.
    // Kick does not remove a deleted message for moderators — it re-renders the
    // row struck through with "(Deleted)". That is a NEW element whose text has
    // changed, so it does not match the dedupe key of the row already mirrored
    // and both ended up on screen. Treat it as an update to the existing row.
    if (_isDeletedRender(msgEl)) {
      _applyDeletion(msgEl);
      return;
    }

    const dupeKey = _msgKey(msgEl);
    if (dupeKey) {
      if (_seenKeys.has(dupeKey)) return;
      _seenKeys.add(dupeKey);
      _seenOrder.push(dupeKey);
      while (_seenOrder.length > 600) _seenKeys.delete(_seenOrder.shift());
    }
    msgEl.dataset.ksMirrored = '1';

    const clone = msgEl.cloneNode(true);
    // Strip our own bookkeeping so the clone cannot be re-processed as a message.
    delete clone.dataset.ksMirrored;
    delete clone.dataset.ksSeen;
    clone.classList.add('ks-mirror-row');

    // Strip Kick's per-message action controls (delete / timeout / ban / pin,
    // and the reply affordance). They are icon-only buttons; a username is a
    // button WITH text, so this keeps usernames while dropping the toolbar.
    // They have to go: cloned nodes carry no React handlers, so every one of
    // them is dead, and for moderators they otherwise render as the whole row.
    for (const b of clone.querySelectorAll('button')) {
      const hasText = !!(b.textContent || '').trim();
      const hasIcon = !!b.querySelector('svg');

      // Reply is the one per-message control worth keeping — it is not a
      // moderator action, and losing it made the mirror strictly worse than
      // Kick's chat. Clicks are forwarded to the original row (see
      // _forwardClick), which is why it can stay despite being inert itself.
      if (!hasText && hasIcon && _isReplyControl(b)) { b.classList.add('ks-reply'); continue; }

      if (!hasText && hasIcon) {
        // Kick only renders these controls for users who can act on the
        // message, so seeing one means this viewer moderates the channel.
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        if (/delete|timeout|ban|pin|mute/.test(label)) _noteModerator();
        b.remove();
      }
    }

    // Lift the reply control out of Kick's toolbar wrapper and hang it directly
    // off the row, so our CSS places it and none of the wrapper's own layout
    // (absolute offsets, flex sizing, a hover variable we never set) applies.
    // The now-empty wrapper goes too — it is a sized flex child, so leaving it
    // would keep a gap where the stripped mod buttons used to be.
    const reply = clone.querySelector('.ks-reply');
    if (reply && reply.parentElement !== clone) {
      const wrapper = reply.parentElement;
      clone.appendChild(reply);
      if (wrapper && !wrapper.children.length && !(wrapper.textContent || '').trim()) {
        wrapper.remove();
      }
    }

    // Drop the emptied mod-actions shells. Stripping the buttons leaves their
    // containers: one `div[style*="--chatroom-mod-actions-display"]`, and an
    // absolutely-positioned toolbar still holding its 1px divider bars. Now that
    // rows are position:relative those anchor to the message and render as stray
    // lines on hover. Scoped to those two shapes, and only when nothing of
    // substance is left inside, so no real content can be caught by this.
    for (const shell of clone.querySelectorAll(
      'div[style*="--chatroom-mod-actions-display"], div[class*="absolute"]')) {
      if (shell.querySelector('button, img, svg')) continue;
      if ((shell.textContent || '').trim()) continue;
      shell.remove();
    }

    _tagBadges(clone);

    _origins.set(clone, msgEl);

    // Attach identity so moderation events can find this row later. Username
    // covers bans; the socket-supplied message id covers deletions, which carry
    // no username at all.
    const cf = KS.ChatFilters;
    const username = cf && cf.getUsername ? (cf.getUsername(msgEl) || '') : '';
    const text = cf && cf.getMessageText ? (cf.getMessageText(msgEl) || '') : '';
    if (username) clone.dataset.ksUser = username;
    const id = _takeId(username, text);
    if (id) clone.dataset.ksMsgId = id;
    // Identity, so the original can be re-found after the virtualiser recycles
    // the element we hold a reference to (see _findLiveRow).
    if (dupeKey) clone.dataset.ksKey = dupeKey;

    const stick = _stick;
    _insertOrdered(clone, _rowIndex(msgEl));
    _prune();
    _updateCount();
    if (stick) _scrollToBottom();
  }

  function _prune() {
    // Only messages are prunable — the moderator notice also lives in here and
    // must not be swept away by a firstElementChild loop.
    const rows = _host.querySelectorAll('.ks-mirror-row');

    // Pruning removes rows from the TOP, which shifts scrollTop and yanks the
    // view while you are reading back. Hold off while scrolled up; catch up as
    // soon as the user returns to the bottom. HARD_MAX stops someone who parks
    // mid-scrollback on a fast channel from growing the list without bound.
    const limit = _stick ? MAX_ROWS : HARD_MAX;
    const excess = rows.length - limit;
    for (let i = 0; i < excess; i++) rows[i].remove();
  }

  // ── Scrolling ──────────────────────────────────────────────────────────────

  function _onScroll() {
    if (!_host) return;
    const wasStuck = _stick;
    const dist0 = _host.scrollHeight - _host.scrollTop - _host.clientHeight;
    // Returning to the bottom releases the deferred pruning above.
    if (!wasStuck && dist0 <= STICK_PX) { _stick = true; _prune(); }
    const dist = _host.scrollHeight - _host.scrollTop - _host.clientHeight;
    _stick = dist <= STICK_PX;
  }

  function _scrollToBottom() {
    if (!_host) return;
    _host.scrollTop = _host.scrollHeight;
  }

  // ── Click forwarding ───────────────────────────────────────────────────────
  //
  // A clone has no React handlers, so clicking a username in the mirror would do
  // nothing. Forward it to the original node, which is still in the (hidden)
  // list. Caveat: the virtualiser recycles rows, so an older clone's original
  // may since have been reused for a different message — in that case the wrong
  // user's modal would open. We detect the common form of this by comparing the
  // username text, and simply do nothing when they no longer agree, which is
  // better than opening the wrong profile.
  function _forwardClick(e) {
    const cloneBtn = e.target.closest && e.target.closest('button');
    if (!cloneBtn || !_host.contains(cloneBtn)) return;

    const cloneRow = cloneBtn.closest('.ks-mirror-row');
    if (!cloneRow) return;

    const label = cloneBtn.textContent.trim();

    // Icon-only controls that survive cloning (reply) carry no text, so they
    // are matched to the original by icon name instead.
    if (!label) {
      if (!_isReplyControl(cloneBtn)) return;
      const icon = _iconName(cloneBtn);
      const src = _liveOriginal(cloneRow);
      if (!src) return;
      // Icon-only, matching how the control was identified when cloning.
      // Matching on icon ALONE picked the wrong button on any message that is
      // itself a reply: the header of a rendered reply preview carries the same
      // curved-arrow icon and comes first in the DOM, so the click opened the
      // thread instead of starting a reply. The preview header has text (the
      // quoted user and message); the control does not.
      const target = [...src.querySelectorAll('button')]
        .find(b => !(b.textContent || '').trim() && _iconName(b) === icon);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      target.click();
      return;
    }

    // Match by LABEL, never by position. Position matching was actively unsafe:
    // clones have their icon-only mod controls removed, so clone index 0 (the
    // username) lined up with original index 0 — a delete/timeout/ban button.
    // Only a text-equality guard stopped it firing, which is also why clicking
    // a username did nothing at all.
    const original = _liveOriginal(cloneRow);
    if (!original) return;

    const target = [...original.querySelectorAll('button')]
      .find(b => b.textContent.trim() === label);
    if (!target) return;

    e.preventDefault();
    e.stopPropagation();
    target.click();
  }

  // Locate the still-rendered original for a mirrored row, by identity rather
  // than element reference.
  function _findLiveRow(cloneRow) {
    const list = _origList && _origList.isConnected
      ? _origList : KS.Sel.find(KS.Sel.chatContainer);
    if (!list) return null;
    const want = cloneRow.dataset.ksKey;
    if (!want) return null;
    for (const el of KS.Sel.findAll(KS.Sel.chatMessage, list)) {
      if (_msgKey(el) === want) return el;
    }
    return null;
  }

  return { init, update, destroy, ingest, isOn, renderModeBar, applyTheme, _scrollToBottom };
}());
