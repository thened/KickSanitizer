// chatters.js — rolling count of who is actually talking.
//
// Fed from every message Kick renders, BEFORE our filters run: this answers
// "how many people are talking in this channel", which is a fact about the
// channel, not about what you chose to hide.
//
// The window is honest but limited: it can only count what it has seen, so a
// 30-minute window on a tab open for two minutes holds two minutes of data.
// firstSeen() exists so the UI can say that rather than implying otherwise.

window.KS = window.KS || {};

KS.Chatters = (function () {

  // username -> { last, msgs, plain }
  //   last  ms timestamp of their most recent message
  //   msgs  messages in the buffer
  //   plain messages that were NOT emote-only
  //
  // `plain` is what separates someone talking from someone spamming emotes:
  // a chatter with plain === 0 has said nothing but emotes the whole window.
  const _users = new Map();

  // Bounded independently of the window. A busy channel can produce tens of
  // thousands of distinct names over 30 minutes, and this is a chat filter, not
  // an analytics store — past this we drop the oldest rather than grow forever.
  const MAX_USERS = 20000;

  let _firstSeen = 0;

  function record(username, isEmoteOnly) {
    const name = String(username || '').trim().toLowerCase();
    if (!name) return;

    const now = Date.now();
    if (!_firstSeen) _firstSeen = now;

    let u = _users.get(name);
    if (!u) {
      u = { last: 0, msgs: 0, plain: 0 };
      _users.set(name, u);
    }
    u.last = now;
    u.msgs++;
    if (!isEmoteOnly) u.plain++;

    if (_users.size > MAX_USERS) {
      // Map preserves insertion order, so the first key is the least recently
      // ADDED — not the least recently active. Good enough as a safety valve:
      // it only fires in channels far busier than the window is meant for.
      const oldest = _users.keys().next().value;
      if (oldest !== undefined) _users.delete(oldest);
    }
  }

  // Drop anyone who has not spoken inside the window. Done on read rather than
  // on a timer: reads happen every few seconds at most, writes happen on every
  // message, and this is the expensive direction.
  function stats(windowMinutes) {
    const cutoff = Date.now() - (Number(windowMinutes) || 15) * 60000;
    let chatters = 0;
    let emoteOnly = 0;

    for (const [name, u] of _users) {
      if (u.last < cutoff) { _users.delete(name); continue; }
      chatters++;
      if (u.plain === 0) emoteOnly++;
    }
    return { chatters, emoteOnly };
  }

  // When counting started, so the UI can show a window it has not filled yet as
  // partial instead of quietly under-reporting.
  function firstSeen() { return _firstSeen; }

  function reset() { _users.clear(); _firstSeen = 0; }

  return { record, stats, firstSeen, reset };
}());
