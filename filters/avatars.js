// avatars.js — real profile pictures for chatters, for themes that draw one.
//
// The chat socket carries id, username, slug and identity{color,badges} — no
// image — and Kick's chat rows have no avatar either. The only source is a
// per-user lookup: /api/v2/channels/{channel}/users/{username}, which is the
// same call Kick's own UI makes when you click a name.
//
// That is one request per DISTINCT chatter, so the bounds matter more than the
// feature does:
//   - cached by username for the session, so repeat speakers cost nothing
//   - one request at a time, spaced out, never a burst
//   - a hard ceiling per channel; past it everyone keeps their initial
//   - only ever runs while a theme that shows avatars is active
//
// Nobody waits on it: the generated initial disc shows immediately and the
// photo replaces it when it arrives. A user with no picture simply keeps theirs.

window.KS = window.KS || {};

KS.Avatars = (function () {

  const MAX_LOOKUPS = 250;    // per channel, then stop asking
  const GAP_MS = 300;         // between requests

  const _cache = new Map();   // username(lower) -> url | null ("asked, none")
  const _queue = [];
  const _asked = new Set();
  let _busy = false;
  let _fetched = 0;
  let _channel = null;
  let _keys = null;           // response field names, for diagnostics

  function setChannel(slug) {
    if (slug === _channel) return;
    _channel = slug;
    _cache.clear();
    _asked.clear();
    _queue.length = 0;
    _fetched = 0;
  }

  function want(username) {
    const u = String(username || '').trim();
    if (!u || !_channel) return;
    const key = u.toLowerCase();
    if (_asked.has(key) || _fetched >= MAX_LOOKUPS) return;
    _asked.add(key);
    _queue.push(u);
    _pump();
  }

  // Applies whatever is already cached. Called per row, so a person's second
  // message shows their picture immediately rather than waiting for a lookup
  // that already happened.
  function decorate(row, username) {
    const url = _cache.get(String(username || '').trim().toLowerCase());
    if (url) _paint(row, url);
  }

  function _paint(row, url) {
    row.style.setProperty('--ks-avatar', 'url("' + url + '")');
    row.dataset.ksAvatar = '1';
  }

  // The URL goes into a CSS url() string, so it has to be safe to interpolate.
  // Anything containing a quote, parenthesis or backslash could close the
  // string early and inject a declaration — so rather than escaping, only a
  // strictly-shaped https URL is accepted at all.
  function _safeUrl(v) {
    if (typeof v !== 'string') return null;
    return /^https:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%-]+$/.test(v) ? v : null;
  }

  // Field name unconfirmed against a live response, so several plausible
  // shapes are tried and anything unrecognised yields null — the disc stays,
  // which is the current behaviour rather than a broken one.
  function _pickUrl(d) {
    if (!d || typeof d !== 'object') return null;
    const candidates = [
      d.profile_pic, d.profilePic, d.profile_picture, d.profile_image,
      d.user && d.user.profile_pic,
      d.user && d.user.profilePic,
    ];
    for (const c of candidates) {
      const url = _safeUrl(c);
      if (url) return url;
    }
    return null;
  }

  async function _pump() {
    if (_busy) return;
    _busy = true;
    try {
      while (_queue.length && _fetched < MAX_LOOKUPS && _channel) {
        const user = _queue.shift();
        const key = user.toLowerCase();
        let url = null;
        try {
          const r = await fetch(
            '/api/v2/channels/' + encodeURIComponent(_channel) +
            '/users/' + encodeURIComponent(user),
            { headers: { Accept: 'application/json' } });
          _fetched++;
          if (r.ok) {
            const d = await r.json();
            if (!_keys) _keys = Object.keys(d || {}).slice(0, 30);
            url = _pickUrl(d);
          }
        } catch (_) { /* one failure must not stall the queue */ }

        _cache.set(key, url);
        if (url) {
          // Every row from this person, not just the one that triggered it —
          // they have probably spoken several times while this was in flight.
          document.querySelectorAll('#ks-mirror .ks-mirror-row').forEach((row) => {
            if ((row.dataset.ksUser || '').toLowerCase() === key) _paint(row, url);
          });
        }
        await new Promise(res => setTimeout(res, GAP_MS));
      }
    } finally {
      _busy = false;
    }
  }

  function stats() {
    return {
      channel: _channel,
      fetched: _fetched,
      cached: _cache.size,
      withPic: [..._cache.values()].filter(Boolean).length,
      queued: _queue.length,
      capped: _fetched >= MAX_LOOKUPS,
      keys: _keys,
    };
  }

  return { setChannel, want, decorate, stats };
}());
