// listSync.js — carries the local lists between the user's Chrome browsers.
//
// Settings already live in chrome.storage.sync and follow the user. The lists
// did not: liked/disliked people, recipes, marked bots and hidden channels are
// kept LOCAL, because sync storage allows only 8 KB per item and a list people
// keep adding to outgrows that. Kick's own mute has the same limitation — it
// stays in one browser — and portability is the point of these lists.
//
// Local stays the source of truth; nothing else in the extension changes. This
// runs in the service worker, which sees every storage change wherever it was
// made (popup, page, import), and copies each list into sync storage split into
// pieces under the per-item quota. Other browsers on the same Chrome profile
// receive the pieces, reassemble them, check them against a hash, and write the
// result locally.
//
// Rules worth knowing before changing this:
//   - A pulled list is never written back out: what was last synced is
//     remembered (ksSyncState, local) by hash, and a push whose content matches
//     it is skipped. Without that, two browsers would echo each other forever.
//   - The first time a browser meets a synced list it MERGES rather than
//     overwrites, so installing on a second machine cannot wipe either one.
//     After that, the newer copy wins.
//   - A list arrives from sync as several items that may land separately. If
//     the pieces do not hash to what the header says, the pull waits for the
//     next change instead of writing half a list.
//   - Synced data comes from the user's own browsers, but it is validated as if
//     it did not: names against the username pattern, recipes through the
//     recipe normaliser.

self.KS = self.KS || {};

KS.ListSync = (function () {

  // Lists carried between browsers. Add a key here to sync it, and give it a
  // cleaner and a merge below.
  const LISTS = ['likedChatters', 'ignoredChatters', 'botRecipes', 'blockedChatters', 'blockedChannels'];

  const PREFIX = 'ks.sync.';           // ks.sync.<key> = header; ks.sync.<key>.<i> = piece
  const PIECE_BYTES = 7000;            // under the 8192-byte item quota, with room for the key
  const MAX_PIECES = 8;                // 56 KB for one list; the whole sync area is 100 KB
  const STATE = 'ksSyncState';         // LOCAL: { key: { t, h } } — what was last synced
  const STATUS = 'ksSyncStatus';       // LOCAL: { key: { at, ok, error } } — for the popup
  const DEBOUNCE_MS = 1500;

  const NAME_RE = /^[a-z0-9_]{1,25}$/;
  const CHANNEL_RE = /^[a-z0-9_-]{1,30}$/;
  const _enc = new TextEncoder();

  // ── storage helpers ────────────────────────────────────────────────────────

  const _get = (area, keys) => new Promise(r => chrome.storage[area].get(keys, d => r(d || {})));
  const _set = (area, data) => new Promise((res, rej) => chrome.storage[area].set(data, () => {
    const e = chrome.runtime.lastError;
    if (e) rej(new Error(e.message)); else res();
  }));
  const _remove = (area, keys) => new Promise(r => chrome.storage[area].remove(keys, () => r()));

  async function _enabled() {
    const d = await _get('sync', ['sync_lists']);
    return d.sync_lists !== false;
  }

  async function _status(key, ok, error) {
    const cur = (await _get('local', [STATUS]))[STATUS] || {};
    cur[key] = { at: Date.now(), ok: !!ok, error: error || null };
    await _set('local', { [STATUS]: cur });
  }

  // ── encoding ───────────────────────────────────────────────────────────────

  // Short and stable; this detects change and truncation, it is not security.
  function _hash(str) {
    let h1 = 5381, h2 = 52711;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = (h1 * 33) ^ c;
      h2 = (h2 * 33) ^ c;
    }
    return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + ':' + str.length;
  }

  // Split into pieces whose STORED size fits the quota. Chrome counts an item
  // as its JSON, so a piece is measured after JSON.stringify — quotes in the
  // text are escaped and take two bytes, emoji take four.
  function _pieces(json) {
    const out = [];
    let i = 0;
    while (i < json.length) {
      let lo = 1, hi = json.length - i;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (_enc.encode(JSON.stringify(json.substr(i, mid))).length <= PIECE_BYTES) lo = mid;
        else hi = mid - 1;
      }
      let len = lo;
      // Never end a piece on the first half of a surrogate pair.
      const c = json.charCodeAt(i + len - 1);
      if (len > 1 && i + len < json.length && c >= 0xD800 && c <= 0xDBFF) len--;
      out.push(json.substr(i, len));
      i += len;
    }
    return out;
  }

  // ── cleaning and merging ───────────────────────────────────────────────────

  function _names(v) {
    return (Array.isArray(v) ? v : [])
      .map(n => String(n || '').trim().toLowerCase().replace(/^@/, ''))
      .filter((n, i, a) => NAME_RE.test(n) && a.indexOf(n) === i);
  }

  function _clean(key, v) {
    if (key === 'botRecipes') {
      return (Array.isArray(v) && KS.BotRecipes) ? v.map(KS.BotRecipes.normalise).filter(Boolean) : [];
    }
    if (key === 'blockedChannels') {
      return (Array.isArray(v) ? v : [])
        .map(c => String(c || '').trim().toLowerCase())
        .filter((c, i, a) => CHANNEL_RE.test(c) && a.indexOf(c) === i);
    }
    return _names(v);
  }

  function _hasData(v) { return Array.isArray(v) && v.length > 0; }

  // First contact only. Lists of names union. Recipes union by name, and where
  // both browsers have one of the same name THIS browser's copy is kept — it
  // carries this browser's own switches, and the other copy is not lost, it is
  // still on the other browser and in sync until this push replaces it.
  function _merge(key, local, incoming) {
    if (key === 'botRecipes') {
      const names = new Set(local.map(r => r.name));
      return local.concat(incoming.filter(r => !names.has(r.name)));
    }
    return local.concat(incoming.filter(x => !local.includes(x)));
  }

  // Liked and disliked are exclusive. Two browsers can disagree about someone;
  // the dislike wins, the same rule as import.
  async function _exclusive() {
    const d = await _get('local', ['likedChatters', 'ignoredChatters']);
    const liked = Array.isArray(d.likedChatters) ? d.likedChatters : [];
    const ignored = Array.isArray(d.ignoredChatters) ? d.ignoredChatters : [];
    const kept = liked.filter(n => !ignored.includes(n));
    if (kept.length !== liked.length) await _set('local', { likedChatters: kept });
  }

  // ── push: local -> sync ────────────────────────────────────────────────────

  async function push(key) {
    if (!LISTS.includes(key) || !(await _enabled())) return;
    const local = (await _get('local', [key]))[key];
    if (local === undefined) return;          // never set: defaults, nothing to carry
    const json = JSON.stringify(local);
    const h = _hash(json);
    const state = (await _get('local', [STATE]))[STATE] || {};
    if (state[key] && state[key].h === h) return;   // sync already has exactly this

    const pieces = _pieces(json);
    if (pieces.length > MAX_PIECES) {
      await _status(key, false, 'too large to sync');
      return;
    }
    const t = Date.now();
    const head = PREFIX + key;
    const data = { [head]: { n: pieces.length, t, h } };
    pieces.forEach((p, i) => { data[head + '.' + i] = p; });
    const old = (await _get('sync', [head]))[head];
    try {
      await _set('sync', data);
    } catch (e) {
      // Quota or rate limit. The list is still safe locally; the next change
      // tries again.
      await _status(key, false, e.message);
      return;
    }
    if (old && old.n > pieces.length) {
      const stale = [];
      for (let i = pieces.length; i < old.n; i++) stale.push(head + '.' + i);
      await _remove('sync', stale);
    }
    state[key] = { t, h };
    await _set('local', { [STATE]: state });
    await _status(key, true);
  }

  // ── pull: sync -> local ────────────────────────────────────────────────────

  async function pull(key) {
    if (!LISTS.includes(key) || !(await _enabled())) return;
    const head = PREFIX + key;
    const meta = (await _get('sync', [head]))[head];
    if (!meta || !meta.n || !meta.h) return;

    const names = [];
    for (let i = 0; i < meta.n; i++) names.push(head + '.' + i);
    const got = await _get('sync', names);
    if (names.some(k => typeof got[k] !== 'string')) return;   // not all here yet
    const json = names.map(k => got[k]).join('');
    if (_hash(json) !== meta.h) return;                         // pieces from different writes

    // A clock far ahead — or a corrupted header — would otherwise make every
    // later real update look older than this one and be ignored until then.
    const t = Math.min(Number(meta.t) || 0, Date.now() + 5 * 60 * 1000);

    const state = (await _get('local', [STATE]))[STATE] || {};
    const mine = state[key];
    if (mine && mine.h === meta.h) return;                      // already have it
    if (mine && mine.t > t) return;                             // ours is newer; push carries it

    let incoming;
    try { incoming = _clean(key, JSON.parse(json)); } catch (_) { return; }
    const local = (await _get('local', [key]))[key];

    let value = incoming;
    if (!mine && _hasData(local)) value = _merge(key, _clean(key, local), incoming);

    // State first, so the local write below is recognised as a pull and not
    // pushed straight back. After a merge the content differs from sync, and
    // that difference IS pushed — which is how the other browser gets the
    // union too.
    state[key] = { t, h: meta.h };
    await _set('local', { [STATE]: state });
    await _set('local', { [key]: value });
    if (key === 'likedChatters' || key === 'ignoredChatters') await _exclusive();
    await _status(key, true);
  }

  async function pullAll() { for (const k of LISTS) await pull(k); }
  async function pushAll() { for (const k of LISTS) await push(k); }

  // ── wiring ─────────────────────────────────────────────────────────────────

  const _timers = {};
  function _later(id, fn) {
    clearTimeout(_timers[id]);
    _timers[id] = setTimeout(() => { fn().catch(() => {}); }, DEBOUNCE_MS);
  }

  function onChanged(changes, area) {
    for (const k of Object.keys(changes)) {
      if (area === 'local' && LISTS.includes(k)) {
        _later('push:' + k, () => push(k));
      } else if (area === 'sync' && k.startsWith(PREFIX)) {
        const key = k.slice(PREFIX.length).replace(/\.\d+$/, '');
        _later('pull:' + key, () => pull(key));
      } else if (area === 'sync' && k === 'sync_lists' && changes[k].newValue !== false) {
        // Switched (back) on: catch up both ways.
        _later('all', async () => { await pullAll(); await pushAll(); });
      }
    }
  }

  return { LISTS, push, pull, pullAll, pushAll, onChanged,
           _pieces, _hash };   // the last two exported for tests
})();
