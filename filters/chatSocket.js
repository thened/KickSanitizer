// chatSocket.js — read-only tap on Kick's chat socket.
//
// Only used by mirror ("clean chat") mode, and only connected while that mode
// is on, so the default footprint is unchanged.
//
// Why a socket at all: the DOM carries no message id anywhere, and
// MessageDeletedEvent identifies its target by id ONLY — no username, no text.
// Captured live from nedx, 2026-08-16:
//   {"id":"ac7b0905-…","message":{"id":"e7887041-…"},
//    "aiModerated":false,"violatedRules":[]}
// So a mirror built purely from cloned DOM physically cannot tell which row a
// deletion refers to. Bans are different — they name the user, so those could
// be done from the DOM alone; they are handled here anyway since we are
// already listening.
//
// Kick publishes on Pusher. Chat + moderation live on chatrooms.{id}.v2.
// (Kicks events are on channel_{id} — underscore, not dot — but that is not
// needed here.)

window.KS = window.KS || {};

KS.ChatSocket = (function () {
  const APP_KEY = '32cbd69e4b950bf97679';
  const WS_URL = `wss://ws-us2.pusher.com/app/${APP_KEY}?protocol=7&client=js&version=8.5.0&flash=false`;
  const MAX_BACKOFF = 30000;

  let _ws = null;
  let _room = null;
  let _slug = null;
  let _backoff = 1000;
  let _opens = 0;
  let _closes = 0;
  let _closing = false;
  let _handlers = {};

  // handlers: { message({id,username,content}), deleted(id), banned(username),
  //             unbanned(username), cleared() }
  function connect(slug, handlers) {
    _handlers = handlers || {};
    if (_slug === slug && _ws && _ws.readyState <= 1) return;   // already on it
    disconnect();
    // AFTER disconnect(), not before. disconnect() sets _closing = true, and
    // the room lookup below bails on _closing — so clearing it first meant
    // disconnect() immediately re-armed the flag and the callback always
    // returned early. The socket never opened, on any channel, from the day
    // this was written: no message ids, no deletions, no bans, and once the
    // filtered count moved onto the socket, nothing to count.
    _closing = false;
    _slug = slug;
    _resolveRoom(slug).then((room) => {
      if (!room || _closing) return;
      _room = room;
      _open();
    });
  }

  function disconnect() {
    _closing = true;
    if (_ws) { try { _ws.close(); } catch (_) { } }
    _ws = null;
    _room = null;
  }

  function isConnected() { return !!_ws && _ws.readyState === 1; }

  async function _resolveRoom(slug) {
    try {
      // Same-origin from a kick.com page, so this passes Cloudflare where a
      // background fetch would not.
      const r = await fetch(`/api/v2/channels/${encodeURIComponent(slug)}`,
                            { headers: { Accept: 'application/json' } });
      if (!r.ok) return null;
      const d = await r.json();
      return (d && d.chatroom && d.chatroom.id) || null;
    } catch (_) { return null; }
  }

  function _open() {
    try { _ws = new WebSocket(WS_URL); } catch (_) { return; }

    _ws.onopen = () => { _backoff = 1000; _opens++; };

    _ws.onmessage = (m) => {
      let f;
      try { f = JSON.parse(m.data); } catch (_) { return; }
      const ev = (f.event || '').replace('App\\Events\\', '');

      if (ev === 'pusher:connection_established') {
        _send({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${_room}.v2` } });
        return;
      }
      if (ev === 'pusher:ping') { _send({ event: 'pusher:pong', data: {} }); return; }

      let d;
      try { d = typeof f.data === 'string' ? JSON.parse(f.data) : f.data; } catch (_) { return; }
      if (!d) return;

      switch (ev) {
        case 'ChatMessageEvent':
          if (_handlers.message) _handlers.message({
            id: d.id,
            username: (d.sender && d.sender.username) || '',
            content: d.content || '',
          });
          break;
        case 'MessageDeletedEvent':
          // The nested id is the message; d.id is the event's own id.
          if (_handlers.deleted && d.message && d.message.id) {
            _handlers.deleted(d.message.id, { aiModerated: !!d.aiModerated,
                                              violatedRules: d.violatedRules || [] });
          }
          break;
        case 'UserBannedEvent':
          if (_handlers.banned && d.user && d.user.username) {
            _handlers.banned(d.user.username, {
              permanent: !!d.permanent,
              expiresAt: d.expires_at || null,
              duration: d.duration || null,
            });
          }
          break;
        case 'UserUnbannedEvent':
          if (_handlers.unbanned && d.user && d.user.username) _handlers.unbanned(d.user.username);
          break;
        case 'ChatroomClearEvent':
          if (_handlers.cleared) _handlers.cleared();
          break;
      }
    };

    _ws.onclose = () => {
      _closes++;
      _ws = null;
      if (_closing) return;
      setTimeout(() => { if (!_closing && _room) _open(); }, _backoff);
      _backoff = Math.min(_backoff * 2, MAX_BACKOFF);
    };

    _ws.onerror = () => { /* onclose handles the retry */ };
  }

  function _send(obj) {
    try { if (_ws && _ws.readyState === 1) _ws.send(JSON.stringify(obj)); } catch (_) { }
  }

  function stats() { return { opens: _opens, closes: _closes, room: _room, slug: _slug }; }

  return { connect, disconnect, isConnected, stats };
}());
