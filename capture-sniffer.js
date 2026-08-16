// KickSanitizer — DOM capture sniffer
// Paste into DevTools console on any kick.com channel page.
// Requires capture-server.py running on localhost:7799.
//
// Captures:
//   chat_message_sample  — first few normal messages (structure reference)
//   chat_event           — system notice (sub/gift/follow/raid) — no username button
//   chat_emote           — message containing emote <img> in content span
//   page_element         — any non-chat element with a new data-testid
//   virtualizer_recycle  — when a [data-index] node's content is replaced in-place
//   page_panel           — modal/overlay/panel appearing outside #chatroom-messages

(function () {
  if (window.__ksSniffer) { console.log('[KS] sniffer already running'); return; }
  window.__ksSniffer = true;

  const SERVER = 'http://localhost:7799';
  const seen = new Set();       // dedupe by first 200 chars of html
  const counts = {};            // per-type caps so we don't flood

  const MAX = {
    chat_message_sample: 5,
    chat_emote: 10,
    chat_event: 50,
    page_element: 30,
    page_panel: 20,
    virtualizer_recycle: 10,
  };

  function channel() {
    const m = location.pathname.match(/^\/([^\/\?#]+)/);
    return m ? m[1].toLowerCase() : 'unknown';
  }

  function send(type, html, note) {
    const key = type + html.slice(0, 200);
    if (seen.has(key)) return;
    seen.add(key);
    counts[type] = (counts[type] || 0) + 1;
    if (counts[type] > (MAX[type] || 20)) return;

    fetch(SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, channel: channel(), html, note }),
    }).catch(() => {});
    console.log(`[KS] captured ${type} — ${note}`);
  }

  // Known data-testid values we already know about — don't re-capture
  const KNOWN_TESTIDS = new Set([
    'chatroom-messages', 'chat-input', 'login', 'sign-up', 'search',
    'sidebar-expand', 'navbar-display-language', 'follow-button', 'sub-button',
    'viewer-count', 'livestream-title', 'video-player-pip', 'video-player-clip',
    'video-player-theatre-mode', 'video-player-fullscreen',
    'channel-about-description', 'channel-about-social-link-club',
    'channel-about-social-link-instagram', 'channel-about-social-link-x',
    'channel-about-social-link-youtube', 'channel-about-social-link-discord',
  ]);

  // ── Analyse a newly added DOM node ─────────────────────────────────────────
  function analyse(el) {
    if (!el || el.nodeType !== 1) return;

    const html = el.outerHTML || '';
    if (!html) return;

    const inChat = document.getElementById('chatroom-messages')?.contains(el);

    // ── Chat messages ─────────────────────────────────────────────────────
    if (inChat && el.classList.contains('group')) {
      const hasUsername = !!el.querySelector('button[data-prevent-expand]');
      const contentSpan = el.querySelector('span.font-normal');
      const hasEmote = contentSpan && !!contentSpan.querySelector('img');

      if (!hasUsername) {
        // System event notice (sub, gift, follow, raid, etc.)
        send('chat_event', html, 'no username button — event/notice row');
      } else if (hasEmote && contentSpan) {
        send('chat_emote', html, `emote in content: ${contentSpan.querySelector('img')?.alt || '?'}`);
        // Also capture just the content span for clarity
        send('chat_emote_span', contentSpan.outerHTML, 'content span with emote');
      } else {
        send('chat_message_sample', html, 'normal message structure');
      }
      return;
    }

    // ── data-testid elements outside what we already know ─────────────────
    const testid = el.dataset?.testid;
    if (testid && !KNOWN_TESTIDS.has(testid) && !testid.startsWith('sidebar-recommended-channel-') && !testid.startsWith('identity-badge-')) {
      send('page_element', html, `data-testid="${testid}"`);
    }

    // Scan descendants for unknown testids too
    el.querySelectorAll('[data-testid]').forEach(child => {
      const tid = child.dataset.testid;
      if (tid && !KNOWN_TESTIDS.has(tid) && !tid.startsWith('sidebar-recommended-channel-') && !tid.startsWith('identity-badge-')) {
        send('page_element', child.outerHTML, `data-testid="${tid}" (descendant)`);
      }
    });

    // ── Panel / overlay appearing outside chat ────────────────────────────
    if (!inChat) {
      const isPanel = el.tagName === 'DIALOG'
        || el.getAttribute('role') === 'dialog'
        || el.getAttribute('role') === 'alertdialog'
        || el.querySelectorAll('[data-testid]').length > 2;

      if (isPanel) {
        send('page_panel', html, `role=${el.getAttribute('role') || el.tagName}`);
      }
    }
  }

  // ── Main MutationObserver ───────────────────────────────────────────────────
  const mainObserver = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        analyse(node);
        // Also check direct children (virtualizer adds wrapper → message row)
        node.querySelectorAll && node.querySelectorAll('.group').forEach(analyse);
      }
    }
  });

  mainObserver.observe(document.body, { childList: true, subtree: true });

  // ── Virtualizer recycling detector ─────────────────────────────────────────
  // Watch individual [data-index] nodes. When their child content is replaced
  // (Kick swaps in a new message), we log before+after to understand the pattern.
  function watchVirtualizerNodes() {
    const chat = document.getElementById('chatroom-messages');
    if (!chat) return;

    const items = chat.querySelectorAll('[data-index]');
    items.forEach(item => {
      if (item.__ksWatching) return;
      item.__ksWatching = true;

      let prevHtml = item.innerHTML.slice(0, 400);
      let prevIndex = item.dataset.index;

      const obs = new MutationObserver(() => {
        const newHtml = item.innerHTML.slice(0, 400);
        const newIndex = item.dataset.index;
        if (newHtml !== prevHtml || newIndex !== prevIndex) {
          send('virtualizer_recycle',
            `<!-- BEFORE index=${prevIndex} -->\n${prevHtml}\n\n<!-- AFTER index=${newIndex} -->\n${newHtml}`,
            `data-index changed: ${prevIndex} → ${newIndex}`
          );
          prevHtml = newHtml;
          prevIndex = newIndex;
        }
      });

      obs.observe(item, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-index'] });
    });
  }

  // Watch for new [data-index] nodes to appear and attach observers to them
  const vitObserver = new MutationObserver(() => watchVirtualizerNodes());
  const chat = document.getElementById('chatroom-messages');
  if (chat) vitObserver.observe(chat, { childList: true, subtree: true });
  watchVirtualizerNodes(); // attach to currently rendered nodes

  // ── Capture current page panel state ───────────────────────────────────────
  // Run once on load to grab anything already on the page outside chat
  setTimeout(() => {
    document.querySelectorAll('[data-testid]').forEach(el => {
      const tid = el.dataset.testid;
      if (!KNOWN_TESTIDS.has(tid) && !tid.startsWith('sidebar-recommended-channel-') && !tid.startsWith('identity-badge-')) {
        send('page_element_initial', el.outerHTML, `data-testid="${tid}" (on load)`);
      }
    });
  }, 1500);

  console.log(`[KS] sniffer active on ${location.href}`);
  console.log(`[KS] sending to ${SERVER} — make sure capture-server.py is running`);
  console.log('[KS] watching for: chat events, emotes, page panels, virtualizer recycling');
})();
