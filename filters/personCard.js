// personCard.js — Like / Dislike on Kick's user card.
//
// Clicking a name in chat opens Kick's card (#user-identity). That is where a
// decision about a PERSON belongs, beside Kick's own follow and gift actions —
// not as buttons on every message, where they covered the end of the text.
//
// Liked: highlighted and never filtered. Disliked: hidden, like Kick's mute,
// but carried by settings export/import where Kick's mute stays in one browser.
// See "Liked and disliked people" in DEVELOPMENT.md.
//
// Other tools inject into this card too (a nedbot overlay sits above Kick's
// part as #nb-card). Ours goes INSIDE Kick's part, under its action row, and
// never touches anything it did not create.

window.KS = window.KS || {};

KS.PersonCard = (function () {

  const ROW_CLASS = 'ks-card-people';
  let _observer = null;
  let _queued = false;
  let _enabled = true;

  // The profile link is the one stable identity on the card: <a title="name"
  // href="https://kick.com/name">. Taken from Kick's part only — another tool's
  // block may carry links of its own.
  function _findCard() {
    const root = document.getElementById('user-identity');
    if (!root) return null;
    for (const a of root.querySelectorAll('a[title][href]')) {
      if (a.closest('#nb-card') || a.closest('.' + ROW_CLASS)) continue;
      const m = /^https?:\/\/(?:www\.)?kick\.com\/([A-Za-z0-9_]{1,25})\/?$/.exec(a.getAttribute('href') || '');
      if (!m || m[1].toLowerCase() !== String(a.getAttribute('title') || '').toLowerCase()) continue;
      // name block -> Kick's card
      const card = a.parentElement && a.parentElement.parentElement;
      if (card) return { card, user: m[1].toLowerCase() };
    }
    return null;
  }

  function _button(text, title, on) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ks-card-btn' + (on ? ' ks-on' : '');
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    return b;
  }

  function _render(found) {
    const CF = KS.ChatFilters;
    if (!CF || !CF.personState) return;
    let row = found.card.querySelector(':scope > .' + ROW_CLASS);
    // The card is reused when you open someone else's, so the row is rebuilt
    // whenever it belongs to a different person or their state changed.
    const state = CF.personState(found.user) || 'none';
    if (row && row.dataset.ksFor === found.user && row.dataset.ksState === state) return;
    if (!row) {
      row = document.createElement('div');
      row.className = ROW_CLASS;
      found.card.appendChild(row);
    }
    row.dataset.ksFor = found.user;
    row.dataset.ksState = state;
    row.innerHTML = '';

    const liked = state === 'liked';
    const disliked = state === 'disliked';
    const like = _button(liked ? '👍 Liked' : '👍 Like',
      liked ? 'Stop liking ' + found.user : 'Highlight ' + found.user + ' and never filter them', liked);
    const dislike = _button(disliked ? '👎 Disliked' : '👎 Dislike',
      disliked ? 'Show ' + found.user + ' again' : 'Hide everything ' + found.user + ' says', disliked);

    like.addEventListener('click', (e) => {
      e.stopPropagation();
      if (liked) CF.unlikeUser(found.user); else CF.likeUser(found.user);
      _after(found);
    });
    dislike.addEventListener('click', (e) => {
      e.stopPropagation();
      if (disliked) CF.undislikeUser(found.user); else CF.dislikeUser(found.user);
      _after(found);
    });

    const label = document.createElement('span');
    label.className = 'ks-card-label';
    label.textContent = 'KickSanitizer';
    row.append(label, like, dislike);
  }

  // Apply to messages already on screen, then redraw the row. The lists are
  // updated in memory by ChatFilters at the click, so both read the new state.
  function _after(found) {
    if (KS.Mirror && KS.Mirror.applyPeople) KS.Mirror.applyPeople();
    _render(found);
  }

  // ── Our own card, when Kick's cannot be opened ─────────────────────────────
  //
  // Clean chat keeps far more history than Kick has rendered, so for an older
  // message there may be no Kick row of that person left to open their card
  // from. Rather than a dead click, this opens a small card in the same place:
  // their name, a link to their profile, and the same like/dislike row.
  let _fallback = null;

  function _closeFallback() {
    if (_fallback) _fallback.remove();
    _fallback = null;
    document.removeEventListener('keydown', _onFallbackKey, true);
    document.removeEventListener('mousedown', _onFallbackOutside, true);
  }
  function _onFallbackKey(e) { if (e.key === 'Escape') _closeFallback(); }
  function _onFallbackOutside(e) { if (_fallback && !_fallback.contains(e.target)) _closeFallback(); }

  function openFallback(name, anchorRect) {
    const user = String(name || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(user)) return;
    _closeFallback();

    const card = document.createElement('div');
    card.className = 'ks-fallback-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', name + ' — KickSanitizer');

    const head = document.createElement('div');
    head.className = 'ks-fb-head';
    const link = document.createElement('a');
    link.className = 'ks-fb-name';
    link.href = 'https://kick.com/' + encodeURIComponent(user);
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = name;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ks-fb-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', _closeFallback);
    head.append(link, close);

    const note = document.createElement('div');
    note.className = 'ks-fb-note';
    note.textContent = "Kick's card is only available for recent messages.";

    card.append(head, note);

    // Beside the chat column, level with the name that was clicked — where
    // Kick puts its own card.
    const chat = document.getElementById('channel-chatroom');
    const left = chat ? chat.getBoundingClientRect().left : window.innerWidth - 340;
    card.style.right = Math.max(8, window.innerWidth - left + 8) + 'px';
    const top = anchorRect ? anchorRect.top - 16 : 80;
    card.style.top = Math.max(8, Math.min(top, window.innerHeight - 160)) + 'px';

    document.body.appendChild(card);
    _fallback = card;
    _render({ card, user });
    // After this click has finished, or it would close the card it opened.
    setTimeout(() => {
      document.addEventListener('keydown', _onFallbackKey, true);
      document.addEventListener('mousedown', _onFallbackOutside, true);
    }, 0);
  }

  function _check() {
    _queued = false;
    if (!_enabled) {
      document.querySelectorAll('.' + ROW_CLASS).forEach(r => r.remove());
      _closeFallback();
      return;
    }
    const found = _findCard();
    if (found) _render(found);
  }

  // The card is a portal Kick adds and removes as you click names, so it has
  // to be noticed rather than looked for once. Batched to a frame: mutations
  // arrive in bursts, and the work is one getElementById when no card is open.
  function init(settings) {
    _enabled = !settings || settings.enabled !== false;
    if (!_observer) {
      _observer = new MutationObserver(() => {
        if (_queued) return;
        _queued = true;
        requestAnimationFrame(_check);
      });
      _observer.observe(document.body, { childList: true, subtree: true });
    }
    _check();
  }

  return { init, update: init, openFallback };
})();
