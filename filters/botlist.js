// botlist.js — the bot list: local marks, shared lists pulled from one or more
// servers, and reports submitted back to them.
//
// Sources are merged at filter time, in this order of trust:
//   1. knownChatBots   — bundled in kickSelectors.js, always present
//   2. blockedChatters — accounts THIS user marked, local, never transmitted
//   3. every enabled source's list, unioned
//
// Local marking works with every source switched off, and is the default. It
// has no privacy story to speak of: nothing leaves the browser, and marking
// someone affects only the person who marked them.
//
// Each source carries its own pull and submit flags, both off until set,
// because they are different acts:
//
//   PULLING contacts a server other than kick.com. One more host that can see
//   you run this.
//
//   SUBMITTING sends a username to that server. It is the only thing this
//   extension ever transmits, it always follows an explicit click, and the
//   payload is the username and nothing else — no message text, no channel, no
//   identity of the reporter.
//
// A submitted report is a REPORT, not an entry. Whether it reaches a published
// list is the server's decision. A list that publishes reports directly is a
// harassment tool: anyone could make anyone invisible to every install.
//
// Host permission is requested PER SOURCE, at the moment one is added, from
// the click that adds it. The extension ships able to reach kick.com and
// nothing else; every additional host is a decision the user makes and can
// revoke.

window.KS = window.KS || {};

KS.BotList = (function () {

  const PULL_INTERVAL_MS = 24 * 60 * 60 * 1000;   // once a day is plenty
  const MAX_PER_SOURCE = 5000;                    // sanity bound on a fetched list
  const MAX_SOURCES = 10;

  let _names = new Set();    // union of every pulled list, lowercase
  let _perSource = {};       // url -> { count, at, error }
  let _pulling = false;
  let _submitted = 0;

  // https only, host only. No path, query or fragment in the base: those get
  // appended here, and a base carrying its own would let a source point the
  // report POST somewhere other than where the list came from.
  function normaliseSource(url) {
    const raw = String(url || '').trim().replace(/\/+$/, '');
    return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(raw) ? raw : null;
  }

  function sources(settings) {
    const list = (settings && settings.bots_sources) || [];
    return Array.isArray(list) ? list.slice(0, MAX_SOURCES) : [];
  }

  // Chrome grants host permissions only from a user gesture, so this must be
  // called straight out of the click that adds a source — not later, and not
  // from a timer.
  function requestPermission(url) {
    const base = normaliseSource(url);
    if (!base) return Promise.resolve(false);
    if (!chrome.permissions || !chrome.permissions.request) return Promise.resolve(false);
    return new Promise((resolve) => {
      chrome.permissions.request({ origins: [base + '/*'] }, (granted) => resolve(!!granted));
    });
  }

  function hasPermission(url) {
    const base = normaliseSource(url);
    if (!base) return Promise.resolve(false);
    if (!chrome.permissions || !chrome.permissions.contains) return Promise.resolve(false);
    return new Promise((resolve) => {
      chrome.permissions.contains({ origins: [base + '/*'] }, (has) => resolve(!!has));
    });
  }

  // ── Pulling ────────────────────────────────────────────────────────────────

  function load(settings) {
    chrome.storage.local.get(['remoteBots', 'remoteBotsMeta'], (d) => {
      _names = new Set(Array.isArray(d.remoteBots) ? d.remoteBots : []);
      _perSource = (d.remoteBotsMeta && typeof d.remoteBotsMeta === 'object')
        ? d.remoteBotsMeta : {};
      maybePull(settings);
    });
  }

  function maybePull(settings) {
    if (_pulling) return;
    const due = sources(settings).filter((src) => {
      if (!src || !src.pull) return false;
      const base = normaliseSource(src.url);
      if (!base) return false;
      const meta = _perSource[base];
      return !meta || (Date.now() - (meta.at || 0)) >= PULL_INTERVAL_MS;
    });
    if (!due.length) return;

    _pulling = true;
    Promise.all(due.map(src => _pullOne(normaliseSource(src.url))))
      .then(() => _persist())
      .finally(() => { _pulling = false; });
  }

  // Asks the service worker to do it. See background.js for why.
  function _ask(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: 'no response' });
        });
      } catch (e) { resolve({ ok: false, error: String(e.message || e) }); }
    });
  }

  // An entry may be a bare string or { username, added }. Both are accepted so
  // a source can serve a flat list without dates and still work.
  function _name(entry) {
    if (typeof entry === 'string') return entry.trim().toLowerCase();
    if (entry && typeof entry.username === 'string') return entry.username.trim().toLowerCase();
    return '';
  }

  function _pullOne(base) {
    const since = (_perSource[base] || {}).through || null;

    return _ask({ type: 'KS_BOTS_PULL', url: base, since })
      .then(res => (res.ok ? res.data : Promise.reject(new Error(res.error || 'failed'))))
      .then((data) => {
        // A bare array is the whole list. An object may be incremental, and
        // then `removed` is the only way a name ever comes back off — without
        // it an incremental feed could add for ever and never retract.
        const isArray = Array.isArray(data);
        const raw = isArray ? data : (data && data.bots);
        if (!Array.isArray(raw)) throw new Error('unexpected shape');

        const added = raw.map(_name).filter(Boolean).slice(0, MAX_PER_SOURCE);
        const removed = (!isArray && Array.isArray(data.removed))
          ? data.removed.map(_name).filter(Boolean) : [];

        // A full response replaces this source's contribution; an incremental
        // one is layered on. Without that distinction a source that dropped a
        // name in a full refresh could never actually lose it.
        if (!since) {
          for (const n of (_perSource[base] || {}).names || []) _names.delete(n);
        }
        for (const n of removed) _names.delete(n);
        for (const n of added) _names.add(n);

        // `through` is the date the source says it is current TO. Sending back
        // its own value avoids clock skew: our idea of today may not be the
        // server's.
        const through = (!isArray && typeof data.through === 'string'
          && /^\d{4}-\d{2}-\d{2}$/.test(data.through)) ? data.through : null;

        const keep = since
          ? ((_perSource[base] || {}).names || []).filter(n => !removed.includes(n)).concat(added)
          : added;

        _perSource[base] = {
          count: keep.length,
          names: [...new Set(keep)].slice(0, MAX_PER_SOURCE),
          through,
          at: Date.now(),
          error: null,
        };
      })
      .catch((e) => {
        // Keep whatever this source gave us last time; a server being down
        // should not empty the list.
        _perSource[base] = Object.assign({}, _perSource[base], {
          at: Date.now(), error: String(e.message || e),
        });
      });
  }

  function _persist() {
    chrome.storage.local.set({
      remoteBots: [..._names],
      remoteBotsMeta: _perSource,
    });
  }

  // ── Reporting ──────────────────────────────────────────────────────────────

  // Sent to every source with submit enabled. Resolves with how many accepted,
  // so the caller can say what happened rather than failing silently.
  function submit(username, settings) {
    const user = String(username || '').trim().toLowerCase();
    if (!user) return Promise.resolve({ sent: 0, failed: 0 });

    const targets = sources(settings)
      .filter(src => src && src.submit)
      .map(src => normaliseSource(src.url))
      .filter(Boolean);
    if (!targets.length) return Promise.resolve({ sent: 0, failed: 0 });

    let sent = 0, failed = 0;
    return Promise.all(targets.map(base =>
      // The entire payload. Deliberately not the message, the channel, or
      // anything identifying who reported it.
      _ask({ type: 'KS_BOTS_REPORT', url: base, username: user })
        .then(res => { if (res && res.ok) { sent++; _submitted++; } else failed++; })
        .catch(() => { failed++; })
    )).then(() => ({ sent, failed }));
  }

  // ── Lookup ─────────────────────────────────────────────────────────────────

  function isBot(username, settings) {
    const u = String(username || '').trim().toLowerCase();
    if (!u) return false;

    const marked = (settings && settings.blockedChatters) || [];
    if (marked.includes(u)) return true;

    // Only consult pulled names while at least one source is set to pull —
    // switching sources off should take effect immediately, not after the
    // cache expires.
    const pulling = sources(settings).some(src => src && src.pull);
    return pulling && _names.has(u);
  }

  function stats() {
    return {
      names: _names.size,
      submitted: _submitted,
      sources: Object.keys(_perSource).map(base => ({
        url: base,
        count: _perSource[base].count || 0,
        at: _perSource[base].at ? new Date(_perSource[base].at).toLocaleString() : null,
        error: _perSource[base].error || null,
      })),
    };
  }

  return {
    load, maybePull, submit, isBot, stats,
    normaliseSource, requestPermission, hasPermission,
  };
}());
