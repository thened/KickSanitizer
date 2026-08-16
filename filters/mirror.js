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

  let _settings = null;
  let _host = null;              // our list
  let _origList = null;          // Kick's #chatroom-messages
  let _stick = true;             // autoscroll enabled (user is at the bottom)
  let _origins = new WeakMap();  // clone -> original row, for click forwarding
  let _bar = null;               // header bar (outside the scroll list)
  let _countEl = null;           // "N filtered" readout in the header
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
    const barH = (_bar && _bar.isConnected) ? HEADER_H : 0;
    const note = parent ? parent.querySelector('.ks-mirror-modnotice') : null;
    const noteH = note ? Math.ceil(note.getBoundingClientRect().height) : 0;

    if (note) note.style.top = barH + 'px';
    if (_host) _host.style.top = (barH + noteH) + 'px';

    // In Kick-chat mode the bar would sit on top of their list, so shrink the
    // container's content box instead of covering messages. Kick's list is
    // h-full, so padding on the parent gives it the right height for free.
    if (parent) parent.style.paddingTop = (!isOn() && barH) ? barH + 'px' : '';
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

    if (!_bar || !_bar.isConnected) {
      _bar = document.createElement('div');
      _bar.className = 'ks-mirror-header';
      list.parentElement.appendChild(_bar);
    }
    _bar.innerHTML = '';

    const on = isOn();

    const label = document.createElement('span');
    label.className = 'ks-mirror-label' + (on ? '' : ' ks-off');
    label.innerHTML = on
      ? '<span class="ks-mirror-dot">🧹</span> Clean chat'
      : '<span class="ks-mirror-dot">💬</span> Kick chat';

    _countEl = document.createElement('span');
    _countEl.className = 'ks-mirror-count';

    const btn = document.createElement('button');
    btn.className = 'ks-mirror-btn';
    btn.title = on ? "Switch to Kick's chat" : 'Switch to clean chat';
    btn.textContent = on ? '⇄ Kick chat' : '⇄ Clean chat';
    btn.addEventListener('click', () => _setMirror(!on));

    const hide = document.createElement('button');
    hide.className = 'ks-mirror-btn ks-mirror-hide';
    hide.title = 'Hide this bar (re-enable in settings)';
    hide.setAttribute('aria-label', 'Hide mode bar');
    hide.textContent = '×';
    hide.addEventListener('click', () => {
      if (KS.updateSettings) KS.updateSettings({ chat_showModeToggle: false });
      _removeBar();
    });

    _bar.appendChild(label);
    _bar.appendChild(_countEl);
    _bar.appendChild(btn);
    _bar.appendChild(hide);
    _updateCount();
    _layout();
    _hideNewMessagesIndicator();
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

    for (const el of col.querySelectorAll('div,button,span')) {
      if (el.dataset.ksHidden) continue;
      if (_host && _host.contains(el)) continue;          // never our own rows
      if (el.children.length > 3) continue;               // want the small node
      const t = (el.textContent || '').trim();
      if (!/^\d*\s*new messages?$/i.test(t)) continue;
      el.dataset.ksHidden = 'new-messages-indicator';
    }
  }

  function _showNewMessagesIndicator() {
    document.querySelectorAll('[data-ks-hidden="new-messages-indicator"]')
      .forEach(el => delete el.dataset.ksHidden);
  }

  function _removeBar() {
    if (_bar) { _bar.remove(); _bar = null; }
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
    try { n = (KS.Stats && KS.Stats.sessionTotal && KS.Stats.sessionTotal()) || 0; } catch (_) { }

    if (!n) { _countEl.innerHTML = ''; _countEl.title = ''; return; }
    _countEl.title = 'Messages and page clutter hidden since this tab loaded';

    if (!_odoEl || !_odoEl.isConnected) {
      _countEl.innerHTML = '';
      _odoEl = document.createElement('span');
      _odoEl.className = 'ks-odo';
      _countEl.appendChild(_odoEl);
      _countEl.appendChild(document.createTextNode(' filtered'));
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
      strip.style.transform = `translateY(${-d}em)`;
    }
  }

  function switchToKickChat() { _setMirror(false); }

  function isOn() {
    return !!(_settings && _settings.enabled && _settings.chat_mirrorMode);
  }

  function init(settings) {
    _settings = settings;
    if (isOn()) _mount(); else _unmount();
    renderModeBar();          // the bar exists in both modes
  }

  function update(settings) {
    const was = isOn();
    _settings = settings;
    const now = isOn();
    if (now && !was) _mount();
    else if (!now && was) _unmount();
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

  function _unmount() {
    if (KS.ChatSocket) KS.ChatSocket.disconnect();
    _showNewMessagesIndicator();
    _pendingIds.clear();
    _seenKeys.clear();
    _seenOrder.length = 0;
    _origins = new WeakMap();
    // Per-channel, not per-session: you are not a moderator everywhere, and the
    // notice should be re-offered on a channel where you are.
    _isMod = false;
    _noticeDismissed = false;
    document.body.classList.remove('ks-mirror-on');
    if (_host) {
      _host.removeEventListener('scroll', _onScroll);
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
      if (!hasText && hasIcon) {
        // Kick only renders these controls for users who can act on the
        // message, so seeing one means this viewer moderates the channel.
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        if (/delete|timeout|ban|pin|mute/.test(label)) _noteModerator();
        b.remove();
      }
    }

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
    if (!label) return;              // icon-only buttons are stripped from clones

    // Match by LABEL, never by position. Position matching was actively unsafe:
    // clones have their icon-only mod controls removed, so clone index 0 (the
    // username) lined up with original index 0 — a delete/timeout/ban button.
    // Only a text-equality guard stopped it firing, which is also why clicking
    // a username did nothing at all.
    let original = _origins.get(cloneRow);

    // The virtualiser may have recycled the original away. Fall back to finding
    // a live row with the same user and text.
    if (!original || !original.isConnected) {
      original = _findLiveRow(cloneRow);
      if (original) _origins.set(cloneRow, original);
    }
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

  return { init, update, destroy, ingest, isOn, renderModeBar, _scrollToBottom };
}());
