// chatFilters.js — All chat-message filters.
// Adds KS.ChatFilters to the KS namespace.

window.KS = window.KS || {};

KS.ChatFilters = (function () {

  // ── State ──────────────────────────────────────────────────────────────────
  let _settings = null;
  let _cleanupInterval = null;

  // Map<username, [{text, timestamp}]>
  // True while scanExisting() is walking the whole rendered buffer.
  let _bulkScan = false;
  const _dupeHistory = new Map();

  // Map<normalizedText, [{username, timestamp, element}]>
  const _copypastaMap = new Map();

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  function init(settings) {
    _settings = settings;
    _startCleanup();
  }

  function update(settings) {
    _settings = settings;
  }

  function destroy() {
    _stopCleanup();
    _dupeHistory.clear();
    _copypastaMap.clear();
    document.querySelectorAll('[data-ks-deleted]').forEach(el => el.remove());
    document.querySelectorAll('.ks-gift-collapsed').forEach(el => el.remove());
    document.querySelectorAll('[data-ks-collapsed]').forEach(el => delete el.dataset.ksCollapsed);
  }

  function _startCleanup() {
    if (_cleanupInterval) return;
    _cleanupInterval = setInterval(_cleanExpired, 60_000);
  }

  function _stopCleanup() {
    clearInterval(_cleanupInterval);
    _cleanupInterval = null;
  }

  function _cleanExpired() {
    const now = Date.now();
    const dupeWin = ((_settings && _settings.chat_duplicateWindowSeconds) || 30) * 1000;
    for (const [user, entries] of _dupeHistory) {
      const fresh = entries.filter(e => now - e.timestamp < dupeWin);
      fresh.length ? _dupeHistory.set(user, fresh) : _dupeHistory.delete(user);
    }
    const cpWin = ((_settings && _settings.chat_copypastaWindowSeconds) || 60) * 1000;
    for (const [text, entries] of _copypastaMap) {
      const fresh = entries.filter(e => now - e.timestamp < cpWin);
      fresh.length ? _copypastaMap.set(text, fresh) : _copypastaMap.delete(text);
    }
  }

  // ── Who "me" is ────────────────────────────────────────────────────────────
  //
  // Set by content.js once Kick tells us. Until then it stays empty and
  // _mentionsMe is simply false — it never guesses, because a wrong name would
  // exempt a stranger's messages from every filter.
  let _me = '';

  function setViewer(username) {
    _me = String(username || '').trim().toLowerCase();
  }

  function _mentionsMe(text) {
    if (!_me || !text) return false;
    const escaped = _me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Trailing boundary so "@ned" does not match "@nedbot".
    return new RegExp('@' + escaped + '\\b', 'i').test(text);
  }

  // ── Main entry point ───────────────────────────────────────────────────────

  // Kick's own chat is READ-ONLY.
  //
  // Filtering in place was the original design, and it cannot work: Kick's list
  // is virtualised with absolutely-positioned rows, so a hidden message leaves
  // a hole that nothing can close. Clean chat exists precisely because of that.
  // Running the filters in Kick's chat as well left it full of gaps, stray
  // attributes and re-inserted clones — visibly broken, for no benefit.
  //
  // So: when clean chat is off we look but do not touch. The filters exist to
  // decide what gets copied into our list, nothing more.
  function _mayModifyKickChat() {
    return !!(_settings && _settings.enabled && _settings.chat_mirrorMode);
  }

  function processMessage(msgEl) {
    if (!msgEl || !_settings) return;
    if (!_settings.enabled) return;
    if (!_mayModifyKickChat()) return;
    // Kick's per-message mod controls (delete / timeout / ban / pin) are
    // <button class="group ..."> — the same class a message row uses. A message
    // is never a button, so this stops a control being filtered or mirrored as
    // if it were chat.
    if (msgEl.tagName === 'BUTTON') return;
    if (msgEl.dataset.ksHidden) return; // already processed
    // Stamp with seen-time so handleRemovedNode can preserve it if deleted.
    // Set it ONCE: re-stamping on every re-scan made all buffered messages look
    // simultaneous, collapsing the duplicate window so any repeat anywhere in
    // the backlog matched and the whole chat got hidden.
    const _firstSeen = !msgEl.dataset.ksSeen;
    if (_firstSeen) msgEl.dataset.ksSeen = Date.now();
    const _seenAt = Number(msgEl.dataset.ksSeen) || Date.now();

    const s = _settings;

    // Count who is talking BEFORE any filter runs, and only on a message's
    // first sighting so the virtualiser re-rendering a row cannot inflate it.
    // This is a fact about the channel, not about what you chose to hide, so it
    // deliberately counts messages that are about to be filtered away.
    if (_firstSeen && window.KS && KS.Chatters) {
      KS.Chatters.record(getUsername(msgEl), isEmoteOnly(msgEl));
    }

    // Nothing that mentions you is ever filtered.
    //
    // Someone replying to you is the single most important message in the
    // channel, and every filter here could swallow it — a short reply, a
    // repeated one, an all-caps one, a bot answering a command you ran. This
    // check runs before all of them and short-circuits to the mirror.
    if (s.chat_neverFilterMentions !== false && _mentionsMe(getMessageText(msgEl))) {
      if (!msgEl.dataset.ksHidden && window.KS && KS.Mirror) KS.Mirror.ingest(msgEl);
      return;
    }

    // Kicks notices (filter by amount before other checks)
    if (s.chat_kicksMinAmount > 0 && _isKicksNotice(msgEl)) {
      const amount = _getKicksAmount(msgEl);
      if (amount < s.chat_kicksMinAmount) return _hide(msgEl, 'kicks-spam');
    }

    // System notices (structural detection first)
    if (isGiftedSubNotice(msgEl)) {
      if (s.chat_hideGiftedSubNotices) return _hide(msgEl, 'gifted-sub');
      if (s.chat_collapseGiftedSubs && !msgEl.dataset.ksCollapsed) {
        _collapseGiftedSubs(msgEl);
        return;
      }
    }
    if (s.chat_hideSubscriptionNotices && isSubscriptionNotice(msgEl)) {
      return _hide(msgEl, 'sub-notice');
    }
    if (s.chat_hideFollowNotices && isFollowNotice(msgEl)) {
      return _hide(msgEl, 'follow-notice');
    }

    const text = getMessageText(msgEl);
    const username = getUsername(msgEl);

    // Emote-only
    if (s.chat_hideEmoteOnly && isEmoteOnly(msgEl)) {
      return _hide(msgEl, 'emote-only');
    }

    // Max emotes
    if (s.chat_maxEmotes > 0 && getEmoteCount(msgEl) > s.chat_maxEmotes) {
      return _hide(msgEl, 'max-emotes');
    }

    // Emote stripping / repeat collapsing. Runs AFTER the two checks above so
    // they still see the message's original emote content. Returns true when it
    // hid the whole row (nothing left but emotes that are now gone).
    if (_applyEmoteRules(msgEl, s)) return;

    // Bot commands (!command)
    if (s.chat_hideBotCommands && text && KS.Normalize.isBotCommand(text)) {
      return _hide(msgEl, 'bot-command');
    }

    // Minimum length. Emote-only rows normalise to '' and are handled by
    // chat_hideEmoteOnly, so don't double-judge them here.
    if (s.chat_minMessageLength > 0 && text
        && !isEmoteOnly(msgEl)
        && text.trim().length < s.chat_minMessageLength) {
      return _hide(msgEl, 'too-short');
    }

    // Chat-game spam: the !command itself and the bot's reply to it.
    if (s.chat_hideBotGames && text && _isBotGame(text, msgEl, s)) {
      return _hide(msgEl, 'bot-game');
    }

    // All caps
    if (s.chat_hideAllCaps && text && KS.Normalize.isAllCaps(text)) {
      return _hide(msgEl, 'all-caps');
    }

    // Repeated characters
    if (s.chat_hideRepeatedChars && text && KS.Normalize.isRepeatedChars(text)) {
      return _hide(msgEl, 'repeated-chars');
    }

    // Links
    if (s.chat_hideLinks && text && KS.Normalize.containsLink(text)) {
      return _hide(msgEl, 'link');
    }

    // Duplicate detection (per-user)
    if (s.chat_hideDuplicates && username && text) {
      // Never retro-hide backlog we are seeing for the first time during a bulk
      // scan: we don't know when those messages actually arrived, so treating
      // them as same-instant repeats wipes the visible chat. Record them so
      // genuinely new repeats are still caught, but don't hide them.
      const _retro = _bulkScan && _firstSeen;
      if (!_retro && _isDuplicate(username, text, s, _seenAt)) {
        return _hide(msgEl, 'duplicate');
      }
      _recordMessage(username, text, s, _seenAt);
    }

    // Global copypasta
    if (s.chat_collapseGlobalCopypasta && username && text) {
      _processCopypasta(msgEl, username, text, s, _seenAt);
    }

    // Survived every filter. In mirror mode this is the point where a message
    // earns its place in the clean list — copypasta above may still have hidden
    // it, so re-check rather than assuming we got here clean.
    if (!msgEl.dataset.ksHidden && window.KS && KS.Mirror) KS.Mirror.ingest(msgEl);
  }

  // ── Duplicate detection ────────────────────────────────────────────────────

  // `at` is the message's own first-seen time, not wall-clock now. Using
  // Date.now() here meant a re-scan compared every buffered message against a
  // window anchored at the scan moment, so the whole backlog counted as recent.
  function _isDuplicate(username, text, s, at) {
    // Emote-only and sticker rows normalize to '' — without this guard every
    // such message from a user is "identical" to the last one and gets hidden.
    // _processCopypasta already guards this way; this path did not.
    if (!KS.Normalize.text(text || '')) return false;
    const windowMs = (s.chat_duplicateWindowSeconds || 30) * 1000;
    const now = at || Date.now();
    const history = _dupeHistory.get(username) || [];
    const mode = s.chat_similarityMode || 'normalized';
    return history.some(e => (now - e.timestamp < windowMs) && KS.Normalize.areSimilar(e.text, text, mode));
  }

  function _recordMessage(username, text, s, at) {
    const windowMs = (s.chat_duplicateWindowSeconds || 30) * 1000;
    const now = at || Date.now();
    let history = (_dupeHistory.get(username) || []).filter(e => now - e.timestamp < windowMs);
    history.push({ text, timestamp: now });
    if (history.length > 100) history = history.slice(-100);
    _dupeHistory.set(username, history);
  }

  // ── Global copypasta ───────────────────────────────────────────────────────

  function _processCopypasta(msgEl, username, text, s, at) {
    const threshold = s.chat_copypastaThreshold || 5;
    const windowMs = (s.chat_copypastaWindowSeconds || 60) * 1000;
    const now = at || Date.now();
    const normalized = KS.Normalize.text(text);
    if (!normalized || normalized.length < 12) return;

    let entries = (_copypastaMap.get(normalized) || []).filter(e => now - e.timestamp < windowMs);
    // Avoid counting the same user repeatedly within the window
    const alreadyHasUser = entries.some(e => e.username === username);
    if (!alreadyHasUser) entries.push({ username, timestamp: now, element: msgEl });
    _copypastaMap.set(normalized, entries);

    if (entries.length >= threshold) {
      _hide(msgEl, 'copypasta');
      _updateCopypastaIndicator(normalized, entries);
    }
  }

  function _updateCopypastaIndicator(normalized, entries) {
    const firstEntry = entries[0];
    if (!firstEntry || !firstEntry.element || !firstEntry.element.parentElement) return;
    const parent = firstEntry.element.parentElement;
    const key = normalized.slice(0, 24);
    const existing = parent.querySelector('.ks-copypasta-indicator[data-ks-cp-key]');
    const hiddenCount = entries.filter(e => e.element && e.element.dataset.ksHidden === 'copypasta').length;
    const labelText = `${hiddenCount} similar message${hiddenCount !== 1 ? 's' : ''} hidden — click to reveal`;

    if (existing && existing.dataset.kscp === key) {
      existing.textContent = labelText;
    } else if (!existing) {
      const indicator = document.createElement('div');
      indicator.className = 'ks-copypasta-indicator';
      indicator.setAttribute('data-ks-cp-key', '1');
      indicator.dataset.kscp = key;
      indicator.textContent = labelText;
      indicator.addEventListener('click', () => {
        entries.forEach(e => { if (e.element) _show(e.element); });
        indicator.remove();
      });
      const anchor = firstEntry.element.nextSibling;
      anchor ? parent.insertBefore(indicator, anchor) : parent.appendChild(indicator);
    }
  }

  // ── Content extraction ─────────────────────────────────────────────────────

  function getUsername(msgEl) {
    // 1. data attribute
    const d = msgEl.dataset.username || msgEl.dataset.chatUsername;
    if (d) return d.toLowerCase();

    // 2. selector match
    const el = KS.Sel.find(KS.Sel.messageUsername, msgEl);
    if (el) return el.textContent.trim().toLowerCase();

    // 3. structural: first colored non-whitespace span that looks like a username
    const spans = msgEl.querySelectorAll('span');
    for (const sp of spans) {
      const t = sp.textContent.trim();
      if (t && t.length > 0 && t.length <= 25 && !/\s/.test(t)) {
        return t.toLowerCase();
      }
    }
    return null;
  }

  function getMessageText(msgEl) {
    const contentEl = KS.Sel.find(KS.Sel.messageContent, msgEl);
    if (contentEl) return contentEl.textContent.trim();
    // Fallback: full text minus username if detectable
    return msgEl.textContent.trim();
  }

  function isEmoteOnly(msgEl) {
    const contentEl = KS.Sel.find(KS.Sel.messageContent, msgEl) || msgEl;
    return _isEmoteOnly(contentEl);
  }

  // Walk the content span's direct children.
  // Confirmed Kick structure: emotes are span[data-emote-id] wrappers;
  // plain text and whitespace text nodes may also be present.
  // Badges live OUTSIDE the content span, so we never see them here.
  function _isEmoteOnly(contentEl) {
    const nodes = contentEl.childNodes;
    if (!nodes.length) return false;
    let hasEmote = false;
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (!t) continue;                       // whitespace between emotes
        // Unicode emoji are plain text to the DOM, so "🤣🤣🤣" reached here as
        // ordinary content and the message was never treated as emote-only.
        if (KS.Normalize.isEmojiOnly(t)) { hasEmote = true; continue; }
        return false;                           // real words — keep the message
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        // Confirmed emote wrapper: span[data-emote-id]
        if (node.dataset && node.dataset.emoteId !== undefined) {
          hasEmote = true;
        } else if (node.tagName === 'IMG') {
          // Fallback: bare img not inside an emote wrapper (older Kick layouts)
          if (!KS.Sel.matches(node, KS.Sel.messageBadge)) hasEmote = true;
        } else if (node.tagName === 'BR' || node.tagName === 'WBR') {
          // ignore
        } else {
          // Any other element (text formatting span, link, etc.) → not emote-only
          return false;
        }
      }
    }
    return hasEmote;
  }

  function getEmoteCount(msgEl) {
    const contentEl = KS.Sel.find(KS.Sel.messageContent, msgEl) || msgEl;
    // Confirmed: each emote is a span[data-emote-id]
    const confirmed = contentEl.querySelectorAll('span[data-emote-id]').length;
    if (confirmed > 0) return confirmed;
    // Fallback for older layouts: count non-badge imgs
    let count = 0;
    for (const img of contentEl.querySelectorAll('img')) {
      if (!KS.Sel.matches(img, KS.Sel.messageBadge)) count++;
    }
    return count;
  }

  // ── Kicks notice detection ─────────────────────────────────────────────────

  // Kicks has no native notice markup — verified live 2026-08-16 across
  // piaatty / jackdoherty. Kick announces it as an ordinary chat message from
  // the official KickBot account, e.g. "@Krauzen22 just gifted 50 KICKs!".
  //
  // The previous implementation required the row to have NO username element,
  // which the KickBot row always has (button[data-prevent-expand]) — so it
  // could never return true and chat_kicksMinAmount never fired.
  function _isKicksNotice(msgEl) {
    // Future-proofing: if Kick ever ships a real notice card, this catches it.
    if (KS.Sel.kicksChatNotice.length && KS.Sel.matches(msgEl, KS.Sel.kicksChatNotice)) return true;

    const text = msgEl.textContent || '';
    if (!/\bkicks?\b/i.test(text)) return false;

    // Native notice card carrying a Kicks amount (none observed yet, but the
    // card chrome is shared across notice types so this costs nothing).
    if (_isNoticeCard(msgEl) && /[\d,]+\s*kicks?/i.test(text)) return true;

    // The real case: a KickBot chat line announcing a gift.
    const userEl = KS.Sel.find(KS.Sel.messageUsername, msgEl);
    const user = userEl ? userEl.textContent.trim() : '';
    const isBot = user.toLowerCase() === String(KS.Sel.kicksBotUsername).toLowerCase();
    return isBot && /gifted\s+[\d,]+\s*kicks?/i.test(text);
  }

  // A native Kick notice card — coloured left accent bar, no data-testid.
  // Shared chrome across sub / gifted-sub / raid notices.
  function _isNoticeCard(msgEl) {
    return !!KS.Sel.find(KS.Sel.noticeCard, msgEl)
        || KS.Sel.matches(msgEl, KS.Sel.noticeCard);
  }

  // Classify a notice card by its icon. Returns the data-ds-icon value or ''.
  function _noticeIcon(msgEl) {
    const card = KS.Sel.find(KS.Sel.noticeCard, msgEl);
    const svg = (card || msgEl).querySelector('svg[data-ds-icon]');
    return svg ? (svg.dataset.dsIcon || '') : '';
  }

  function _getKicksAmount(msgEl) {
    const text = msgEl.textContent;
    // Match "123 Kicks" or "sent 123 Kicks" etc.
    const m = text.match(/(\d[\d,]*)\s*kicks?/i);
    if (m) return parseInt(m[1].replace(/,/g, ''), 10);
    return 0;
  }

  // ── Gifted sub collapse ────────────────────────────────────────────────────

  function _collapseGiftedSubs(msgEl) {
    // Cards were previously matched on inline colour rgb(192, 112, 255) — a
    // colour Kick does not use. Live capture 2026-08-16: gifted-sub cards are
    // amber rgb(255, 196, 102), subscription cards Kick-green rgb(83, 252, 24).
    // Match on the card's structural class instead, which is shared by all
    // notice types and survives palette changes.
    const cards = msgEl.querySelectorAll(KS.Sel.noticeCard.join(','));
    if (!cards.length) { _hide(msgEl, 'gifted-sub'); return; }

    // First card is the batch summary; the rest are individual recipient cards
    const firstCard = cards[0];
    const gifterBtn = firstCard.querySelector('button');
    const gifter = gifterBtn ? gifterBtn.textContent.trim() : '';
    if (!gifter) { _hide(msgEl, 'gifted-sub'); return; }

    const countSpan = firstCard.querySelector('span span');
    const count = countSpan ? (parseInt(countSpan.textContent.replace(/,/g, ''), 10) || 0) : 1;

    const recipients = [];
    for (let i = 1; i < cards.length; i++) {
      const btns = cards[i].querySelectorAll('button');
      if (btns.length >= 2) recipients.push(btns[1].textContent.trim());
      else if (btns.length === 1) recipients.push(btns[0].textContent.trim());
    }

    const shown = recipients.slice(0, 5).join(', ');
    const extra = recipients.length > 5 ? ` +${recipients.length - 5}` : '';
    const label = count > 1
      ? `🎁 ${gifter} gifted ${count} subs${shown ? ': ' + shown + extra : ''}`
      : `🎁 ${gifter} gifted a sub${recipients[0] ? ' to ' + recipients[0] : ''}`;

    // Hide all child cards
    for (const child of msgEl.children) child.dataset.ksHidden = 'gifted-sub-child';

    const indicator = document.createElement('div');
    indicator.className = 'ks-gift-collapsed';
    indicator.textContent = label;
    indicator.title = 'Click to expand';
    indicator.addEventListener('click', () => {
      indicator.remove();
      delete msgEl.dataset.ksCollapsed;
      for (const child of msgEl.children) {
        if (child.dataset.ksHidden === 'gifted-sub-child') delete child.dataset.ksHidden;
      }
    });
    msgEl.prepend(indicator);
    msgEl.dataset.ksCollapsed = 'true';
  }

  // ── Notice detection ───────────────────────────────────────────────────────

  function _hasNoUserContent(msgEl) {
    // System notices typically lack the usual username+content structure
    return !KS.Sel.find(KS.Sel.messageUsername, msgEl) || !KS.Sel.find(KS.Sel.messageContent, msgEl);
  }

  function isGiftedSubNotice(msgEl) {
    if (KS.Sel.matches(msgEl, KS.Sel.giftedSubNotice)) return true;
    // Icon-based classification first — language-independent, and immune to
    // Kick rewording the copy. Falls back to text for anything unrecognised.
    const icon = _noticeIcon(msgEl);
    if (icon === KS.Sel.noticeIcons.giftedSubSummary
     || icon === KS.Sel.noticeIcons.giftedSubSingle) return true;
    if (icon === KS.Sel.noticeIcons.subscription) return false;
    return /gifted\s+\d+?\s+sub|gifted\s+a\s+sub/i.test(msgEl.textContent) && _hasNoUserContent(msgEl);
  }

  function isSubscriptionNotice(msgEl) {
    if (KS.Sel.matches(msgEl, KS.Sel.subscriptionNotice)) return true;
    const icon = _noticeIcon(msgEl);
    if (icon === KS.Sel.noticeIcons.subscription) return true;
    if (icon === KS.Sel.noticeIcons.giftedSubSummary
     || icon === KS.Sel.noticeIcons.giftedSubSingle) return false;
    return /subscribed|re-subscribed|resubscribed/i.test(msgEl.textContent) && _hasNoUserContent(msgEl);
  }

  // Kick does not render follows natively — a chat bot announces them, so the
  // row is an ordinary message and _hasNoUserContent is always false here.
  // Requiring it (as this did) made chat_hideFollowNotices dead code.
  function isFollowNotice(msgEl) {
    if (KS.Sel.matches(msgEl, KS.Sel.followNotice)) return true;

    const text = msgEl.textContent || '';
    if (!/just followed|started following|thanks for (the )?follow/i.test(text)) return false;

    // A native card would be unambiguous; accept it if Kick ever ships one.
    if (_isNoticeCard(msgEl)) return true;

    // Otherwise the sender must be a bot — a viewer typing "x just followed"
    // is a real message and must not be hidden.
    return _isKnownBot(msgEl);
  }

  // Chat-game spam — !fish and friends, plus the bot replies they generate
  // (flag/country guessing games and similar). Two halves:
  //   • a viewer's "!fish" command
  //   • a bot's response, which mentions the game and is usually addressed @user
  // Only bot senders are matched on the reply side, so a viewer discussing
  // fishing or naming a country is left alone.
  function _isBotGame(text, msgEl, s) {
    const words = String(s.chat_botGameCommands || '')
      .split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
    if (!words.length) return false;

    const t = text.toLowerCase();

    // The command itself, from anyone.
    const cmd = t.match(/^\s*!(\w+)/);
    if (cmd && words.includes(cmd[1])) return true;

    // The reply, from a bot only.
    if (!_isKnownBot(msgEl)) return false;
    return words.some(w => new RegExp('\\b' + w + '\\b', 'i').test(t));
  }

  function _isKnownBot(msgEl) {
    const userEl = KS.Sel.find(KS.Sel.messageUsername, msgEl);
    if (!userEl) return false;
    const user = userEl.textContent.trim().toLowerCase();
    return (KS.Sel.knownChatBots || []).some(b => b.toLowerCase() === user);
  }

  // ── Hide / show ────────────────────────────────────────────────────────────

  // Distinct messages the filters rejected. Keyed by message identity, not by
  // element: the virtualiser re-creates rows, so an element-based tally counts
  // the same message repeatedly.
  //
  // This is deliberately NOT KS.Stats.sessionTotal(), which the header used to
  // show. That sums every reason including page furniture (Kicks widget,
  // suggested channels, top gifters) and counts emote strips individually, so
  // one message with five emotes added five. "N filtered" should mean
  // N messages you did not have to read.
  // ── Counting, from the socket ──────────────────────────────────────────────
  //
  // The DOM cannot answer "how many messages were filtered". Once the
  // virtualiser recreates a row, nothing in it distinguishes "this message
  // again" from "an identical message sent again" — so any DOM-side identity
  // either merges duplicates (under-counts) or recounts re-renders (climbs
  // without bound). Both were shipped and both were wrong.
  //
  // The socket has a real id per message, so counting there is exact and the
  // virtualiser becomes irrelevant. The DOM path still does the hiding; it just
  // stopped being what counts.
  //
  // Deliberately chat messages only. Notices arrive as their own event types and
  // are a rounding error next to duplicate and emote spam.
  const _sockCounted = new Set();     // message ids already counted
  const _sockDupe = new Map();        // user|text -> last seen ms, own state
  let _sockTotal = 0;
  let _sockSeen = 0;                  // messages observed, to detect a dead tap

  // Kick embeds emotes in the message text. The exact markup is NOT confirmed
  // against a live payload, so a non-match degrades to "this is ordinary text",
  // which under-counts rather than counting the wrong thing.
  const EMOTE_RE = /\[emote:\d+:[^\]]*\]/g;

  function _sockIsFiltered(username, content, s) {
    const raw = String(content || '');
    const emotes = (raw.match(EMOTE_RE) || []).length;
    const text = raw.replace(EMOTE_RE, ' ').replace(/\s+/g, ' ').trim();
    const user = String(username || '').toLowerCase();

    // A message that mentions you is never filtered, whatever else it trips —
    // must match the DOM path or the count would disagree with the screen.
    if (s.chat_neverFilterMentions !== false && _mentionsMe(raw)) return false;

    if (s.chat_hideEmoteOnly && ((emotes > 0 && !text) || KS.Normalize.isEmojiOnly(text))) return true;
    if (s.chat_maxEmotes > 0 && emotes > s.chat_maxEmotes) return true;
    if (s.chat_hideBotCommands && KS.Normalize.isBotCommand(text)) return true;
    if (s.chat_hideBotResponses && KS.Sel.knownChatBots
        && KS.Sel.knownChatBots.some(b => String(b).toLowerCase() === user)) return true;
    if (s.chat_hideAllCaps && KS.Normalize.isAllCaps(text)) return true;
    if (s.chat_hideRepeatedChars && KS.Normalize.isRepeatedChars(text)) return true;
    if (s.chat_hideLinks && KS.Normalize.containsLink(text)) return true;
    if (s.chat_minMessageLength > 0 && text.length > 0
        && text.length < s.chat_minMessageLength) return true;

    if (s.chat_hideDuplicates && text) {
      // Its own history, not _dupeHistory: sharing would have each path
      // recording the other's messages and shrinking the window for both.
      const key = user + '|' + KS.Normalize.text(text);
      const now = Date.now();
      const last = _sockDupe.get(key);
      const windowMs = (s.chat_duplicateWindowSeconds || 300) * 1000;
      _sockDupe.set(key, now);
      if (_sockDupe.size > 4000) {
        const cutoff = now - windowMs;
        for (const [k, t] of _sockDupe) if (t < cutoff) _sockDupe.delete(k);
      }
      if (last !== undefined && now - last <= windowMs) return true;
    }
    return false;
  }

  // Called for every chat message the socket delivers.
  function countSocketMessage(msg) {
    if (!msg || !msg.id || !_settings || !_settings.enabled) return;
    if (_sockCounted.has(msg.id)) return;      // the whole point: ids are unique
    _sockCounted.add(msg.id);
    _sockSeen++;
    if (_sockCounted.size > 20000) {
      const oldest = _sockCounted.values().next().value;
      if (oldest !== undefined) _sockCounted.delete(oldest);
    }
    try {
      if (_sockIsFiltered(msg.username, msg.content, _settings)) _sockTotal++;
    } catch (_) { /* never let counting break the message path */ }
  }

  // Prefer the socket, which is exact. Fall back to the DOM tally only when the
  // tap has produced nothing — a socket that failed to connect should not leave
  // the readout stuck at zero while messages visibly vanish.
  // ONE source, always. This used to fall back to a DOM tally until the socket
  // delivered its first message, which meant the readout climbed on DOM numbers
  // and then jumped DOWN to the socket's when the tap came up — observed live
  // going 79 -> 54. A count that can move backwards is worse than one that
  // starts late, so it now shows nothing until the socket is feeding.
  function filteredCount() { return _sockTotal; }

  function _hide(el, reason) {
    // Count only the not-hidden -> hidden transition; processMessage can be
    // called again for the same element and we do not want to double-count.
    if (!el.dataset.ksHidden) {
      if (window.KS && KS.Stats) KS.Stats.count(reason);
    }
    el.dataset.ksHidden = reason;
  }

  function _show(el) {
    delete el.dataset.ksHidden;
  }

  // ── Emote rules ────────────────────────────────────────────────────────────
  // Emotes are span[data-emote-id][data-emote-name] inside the content span.
  // Hidden via an attribute (not removal) so restoreAll can put them back.
  function _applyEmoteRules(msgEl, s) {
    if (!s.chat_hideAllEmotes && !s.chat_hideRepeatedEmotes) return false;

    const contentEl = KS.Sel.find(KS.Sel.messageContent, msgEl) || msgEl;
    const emotes = contentEl.querySelectorAll('span[data-emote-id]');
    if (!emotes.length) return false;

    if (s.chat_hideAllEmotes) {
      let n = 0;
      for (const e of emotes) { if (!e.dataset.ksEmoteHidden) { e.dataset.ksEmoteHidden = 'all'; n++; } }
      if (n && window.KS && KS.Stats) KS.Stats.count('emote-stripped', n);
    } else {
      // Keep the first of each distinct emote, hide later repeats.
      const seen = new Set();
      let n = 0;
      for (const e of emotes) {
        const key = e.dataset.emoteName || e.dataset.emoteId;
        if (seen.has(key)) {
          if (!e.dataset.ksEmoteHidden) { e.dataset.ksEmoteHidden = 'repeat'; n++; }
        } else {
          seen.add(key);
          delete e.dataset.ksEmoteHidden;
        }
      }
      if (n && window.KS && KS.Stats) KS.Stats.count('emote-repeat', n);
    }

    // If stripping left nothing readable, hide the row rather than leaving a
    // username with an empty message body.
    if (s.chat_hideAllEmotes && !(contentEl.textContent || '').trim()) {
      _hide(msgEl, 'emote-only');
      return true;
    }
    return false;
  }

  // ── Restore all hidden chat elements ───────────────────────────────────────

  function restoreAll() {
    // Scope to the chat container. Page filters mark their elements with the
    // same data-ks-hidden attribute, so an unscoped query here un-hid the
    // leaderboard, suggested channels and Kicks UI on every settings change —
    // PageFilters.update() runs before this and does not re-hide them.
    const root = KS.Sel.find(KS.Sel.chatContainer) || document;
    root.querySelectorAll('[data-ks-hidden]').forEach(_show);
    root.querySelectorAll('[data-ks-emote-hidden]')
      .forEach(el => delete el.dataset.ksEmoteHidden);
    document.querySelectorAll('[data-ks-deleted]').forEach(el => el.remove());
    document.querySelectorAll('.ks-copypasta-indicator').forEach(el => el.remove());
    document.querySelectorAll('.ks-gift-collapsed').forEach(el => el.remove());
    document.querySelectorAll('[data-ks-collapsed]').forEach(el => delete el.dataset.ksCollapsed);
    _dupeHistory.clear();
    _copypastaMap.clear();
    _sockCounted.clear();
    _sockDupe.clear();
    _sockTotal = 0;
    _sockSeen = 0;
  }

  // ── Scan existing DOM ──────────────────────────────────────────────────────

  function scanExisting() {
    const container = KS.Sel.find(KS.Sel.chatContainer);
    if (!container) return;
    // Mark this as a bulk pass so processMessage does not retro-hide backlog
    // it has never seen before as "duplicates" (see the _retro guard).
    _bulkScan = true;
    try {
      for (const msg of KS.Sel.findAll(KS.Sel.chatMessage, container)) {
        processMessage(msg);
      }
    } finally {
      _bulkScan = false;
    }
  }

  function handleAddedNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.dataset.ksDeleted) return; // skip our own re-inserted clones
    if (KS.Sel.matches(node, KS.Sel.chatMessage)) {
      processMessage(node);
      return;
    }
    // KS.Sel.chatMessage is an ordered fallback chain, most specific first.
    // Joining it with commas turns that into a UNION, which matched Kick's mod
    // toolbar buttons — they carry class "group", same as a message row — so
    // delete/timeout/ban/pin buttons were processed as if they were messages.
    // Take the first selector that matches anything, exactly like KS.Sel.findAll.
    for (const sel of KS.Sel.chatMessage) {
      let found;
      try { found = node.querySelectorAll(sel); } catch (_) { continue; }
      if (found && found.length) { found.forEach(processMessage); return; }
    }
  }

  // Called by content.js MutationObserver for removed nodes.
  // Re-inserts messages that were deleted by bans/mod actions.
  function handleRemovedNode(node, target, nextSibling) {
    if (!_settings || !_settings.enabled || !_settings.chat_keepDeletedMessages) return;
    if (!_mayModifyKickChat()) return;   // Kick's chat is read-only
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.dataset.ksDeleted) return; // already a clone — prevent loops

    // Only preserve nodes we stamped as seen (real chat messages we processed)
    const seenAt = parseInt(node.dataset.ksSeen || '0', 10);
    if (!seenAt) return;
    // Skip if older than 5 min — likely a virtualizer scroll-off, not a deletion
    if (Date.now() - seenAt > 5 * 60 * 1000) return;

    const clone = node.cloneNode(true);
    clone.dataset.ksDeleted = 'true';
    clone.removeAttribute('data-index'); // detach from virtualizer

    // Prepend a small "[deleted]" label before the username
    const usernameEl = clone.querySelector('button[data-prevent-expand="true"]');
    if (usernameEl) {
      const label = document.createElement('span');
      label.className = 'ks-deleted-label';
      label.textContent = '[deleted] ';
      usernameEl.before(label);
    }

    try {
      if (target && target.isConnected) {
        target.insertBefore(clone, nextSibling || null);
      }
    } catch (_) { }
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    init,
    update,
    destroy,
    processMessage,
    handleAddedNode,
    handleRemovedNode,
    scanExisting,
    restoreAll,
    getUsername,
    getMessageText,
    isEmoteOnly,
    isGiftedSubNotice,
    isSubscriptionNotice,
    isFollowNotice,
    // Exposed for unit tests
    _isEmoteOnly,
    filteredCount,
    setViewer,
    countSocketMessage,
    _mentionsMe,
    _isKicksNotice,
    _getKicksAmount,
    _hasNoUserContent,
    _collapseGiftedSubs,
  };
}());
