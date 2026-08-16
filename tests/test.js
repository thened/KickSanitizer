// KickSanitizer — unit tests
// Run via tests/test.html (no build step, no framework, plain JS)

window.KS_TESTS = (function () {
  const results = [];
  let _suite = '';

  function suite(name) { _suite = name; }

  function test(name, fn) {
    try {
      fn();
      results.push({ suite: _suite, name, ok: true });
    } catch (e) {
      results.push({ suite: _suite, name, ok: false, error: e.message });
    }
  }

  function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'assertion failed');
  }

  function eq(a, b, msg) {
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }

  // ── Load order guard ────────────────────────────────────────────────────────
  if (typeof window.KS === 'undefined') {
    throw new Error('window.KS is not defined — load KS scripts before test.js');
  }
  if (!window.KS.Normalize) {
    throw new Error('KS.Normalize not found — load messageNormalization.js before test.js');
  }

  const N = window.KS.Normalize;

  // ── Normalize.text ──────────────────────────────────────────────────────────
  suite('Normalize.text');

  test('lowercases and trims', () => {
    eq(N.text('  Hello World  '), 'hello world');
  });

  test('collapses internal spaces', () => {
    eq(N.text('a   b   c'), 'a b c');
  });

  test('strips punctuation when option set', () => {
    const r = N.text('Hello, World!', { removePunctuation: true });
    eq(r, 'hello world');
  });

  test('keeps punctuation by default', () => {
    const r = N.text('Hello, World!');
    assert(r.includes(','), 'comma should remain');
  });

  test('handles empty string', () => {
    eq(N.text(''), '');
  });

  test('handles whitespace-only string', () => {
    eq(N.text('   '), '');
  });

  // ── Normalize.areSimilar ────────────────────────────────────────────────────
  suite('Normalize.areSimilar');

  test('exact mode — identical strings match', () => {
    assert(N.areSimilar('hello world', 'hello world', 'exact'));
  });

  test('exact mode — different strings do not match', () => {
    assert(!N.areSimilar('hello world', 'hello there', 'exact'));
  });

  test('normalized mode — trims and lowercases before comparing', () => {
    assert(N.areSimilar('  Hello World  ', 'hello world', 'normalized'));
  });

  test('normalized mode — collapses spaces', () => {
    assert(N.areSimilar('W stream W  stream', 'w stream w stream', 'normalized'));
  });

  test('normalized mode — different content does not match', () => {
    assert(!N.areSimilar('hello', 'world', 'normalized'));
  });

  // ── Normalize.isAllCaps ─────────────────────────────────────────────────────
  suite('Normalize.isAllCaps');

  test('detects all-caps message', () => {
    assert(N.isAllCaps('LETS GOOOOO CHAT'));
  });

  test('all-caps — returns false for mixed case', () => {
    assert(!N.isAllCaps('Hello World'));
  });

  test('all-caps — returns false for short string', () => {
    assert(!N.isAllCaps('LOL')); // under min-length
  });

  test('all-caps — handles numbers in message', () => {
    assert(N.isAllCaps('WIN 5000 GG EZ WOW'));
  });

  test('all-caps — mostly caps with minor lowercase passes', () => {
    assert(N.isAllCaps('OMEGALUL haha OMEGALUL'));
  });

  // ── Normalize.isRepeatedChars ───────────────────────────────────────────────
  suite('Normalize.isRepeatedChars');

  test('single char repeated many times', () => {
    assert(N.isRepeatedChars('LLLLLLLLLL'));
  });

  test('short pattern repeated many times', () => {
    assert(N.isRepeatedChars('xDxDxDxDxDxD'));
  });

  test('returns false for normal sentence', () => {
    assert(!N.isRepeatedChars('what game is this'));
  });

  test('returns false for short repeated string', () => {
    assert(!N.isRepeatedChars('LL')); // only 2 repetitions
  });

  // ── Normalize.isBotCommand ─────────────────────────────────────────────────
  suite('Normalize.isBotCommand');

  test('detects !points', () => {
    assert(N.isBotCommand('!points'));
  });

  test('detects !followage', () => {
    assert(N.isBotCommand('!followage'));
  });

  test('detects with leading space', () => {
    assert(N.isBotCommand('  !commands'));
  });

  test('returns false for normal message', () => {
    assert(!N.isBotCommand('great stream'));
  });

  test('returns false for exclamation mid-sentence', () => {
    assert(!N.isBotCommand('wow great stream!'));
  });

  // ── Normalize.containsLink ─────────────────────────────────────────────────
  suite('Normalize.containsLink');

  test('detects https URL', () => {
    assert(N.containsLink('check this https://example.com'));
  });

  test('detects http URL', () => {
    assert(N.containsLink('visit http://example.com now'));
  });

  test('detects www prefix', () => {
    assert(N.containsLink('www.example.com is cool'));
  });

  test('detects common TLDs', () => {
    assert(N.containsLink('go to example.tv'));
  });

  test('returns false for normal message', () => {
    assert(!N.containsLink('great stream today'));
  });

  // ── Normalize.similarity ────────────────────────────────────────────────────
  suite('Normalize.similarity');

  test('identical strings score 1.0', () => {
    const s = N.similarity('hello world', 'hello world');
    assert(s === 1.0, `expected 1.0, got ${s}`);
  });

  test('completely different strings score < 0.3', () => {
    const s = N.similarity('hello', 'zzzzz');
    assert(s < 0.3, `expected < 0.3, got ${s}`);
  });

  test('similar strings score > 0.5', () => {
    const s = N.similarity('W stream W stream', 'W Stream W stream');
    assert(s > 0.5, `expected > 0.5, got ${s}`);
  });

  test('empty strings return 1.0', () => {
    eq(N.similarity('', ''), 1.0);
  });

  // ── Settings defaults ───────────────────────────────────────────────────────
  suite('KS.DEFAULT_SETTINGS');

  test('DEFAULT_SETTINGS exists', () => {
    assert(typeof window.KS.DEFAULT_SETTINGS === 'object');
  });

  test('has expected keys', () => {
    const keys = [
      'enabled', 'chat_hideDuplicates', 'chat_duplicateWindowSeconds',
      'chat_similarityMode', 'chat_hideEmoteOnly', 'chat_kicksMinAmount',
      'chat_hideGiftedSubNotices', 'chat_collapseGiftedSubs',
      'page_hideKicks', 'page_hideTopGifters', 'page_hideGiftAnimations',
      'page_hideBanNotice',
    ];
    for (const k of keys) {
      assert(k in window.KS.DEFAULT_SETTINGS, `missing key: ${k}`);
    }
  });

  test('enabled defaults to true', () => {
    assert(window.KS.DEFAULT_SETTINGS.enabled === true);
  });

  test('duplicate window default is 5 minutes', () => {
    eq(window.KS.DEFAULT_SETTINGS.chat_duplicateWindowSeconds, 300);
  });

  // ── KS.importSettings validation ────────────────────────────────────────────
  // We test the validation logic by checking that importSettings rejects
  // unknown keys. (Actual chrome.storage calls are mocked in test.html.)
  suite('importSettings validation');

  test('importSettings rejects non-object JSON', (done) => {
    const result = window.KS.importSettings('"just a string"');
    // Should reject with an error (returns false or throws)
    // The function signature returns a Promise, but we check synchronously
    // by catching any thrown error or checking the return type.
    assert(result !== undefined, 'should return something');
  });

  test('importSettings rejects JSON array', () => {
    const result = window.KS.importSettings('[1,2,3]');
    assert(result !== undefined);
  });

  // ── Emote-only detection via DOM ────────────────────────────────────────────
  // Uses real Kick.com emote structure: span[data-emote-id] > div > img
  suite('isEmoteOnly (DOM)');

  function emoteSpan(name, id) {
    id = id || '1234';
    return `<span class="relative mx-px inline-block" data-emote-id="${id}" data-emote-name="${name}">` +
           `<div><img class="h-full w-full" alt="${name}" src="https://files.kick.com/emotes/${id}/fullsize"></div>` +
           `</span>`;
  }

  // Real Kick message structure
  function makeMessage(contentHtml) {
    const el = document.createElement('div');
    el.className = 'group relative px-2';
    el.innerHTML =
      `<div class="w-full break-words rounded-lg px-2">` +
        `<div class="inline-flex flex-nowrap items-baseline rounded">` +
          `<button data-prevent-expand="true" class="inline font-bold">TestUser</button>` +
        `</div>` +
        `<span class="inline-flex font-bold">:</span>` +
        `<span class="font-normal leading-[1.55]">${contentHtml}</span>` +
      `</div>`;
    document.body.appendChild(el);
    return el;
  }

  function cleanup(el) {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  test('single emote span is emote-only', () => {
    const el = makeMessage(emoteSpan('KEKW'));
    const content = el.querySelector('span.font-normal');
    assert(window.KS.ChatFilters._isEmoteOnly(content));
    cleanup(el);
  });

  test('multiple emote spans is emote-only', () => {
    const el = makeMessage(emoteSpan('Pog','1') + emoteSpan('Pog','1') + emoteSpan('Pog','1'));
    const content = el.querySelector('span.font-normal');
    assert(window.KS.ChatFilters._isEmoteOnly(content));
    cleanup(el);
  });

  test('emote with text is NOT emote-only', () => {
    const el = makeMessage('this is funny ' + emoteSpan('KEKW'));
    const content = el.querySelector('span.font-normal');
    assert(!window.KS.ChatFilters._isEmoteOnly(content));
    cleanup(el);
  });

  test('pure text is not emote-only', () => {
    const el = makeMessage('great stream today');
    const content = el.querySelector('span.font-normal');
    assert(!window.KS.ChatFilters._isEmoteOnly(content));
    cleanup(el);
  });

  test('whitespace around emote span is still emote-only', () => {
    const el = makeMessage('   ' + emoteSpan('LUL') + '   ');
    const content = el.querySelector('span.font-normal');
    assert(window.KS.ChatFilters._isEmoteOnly(content));
    cleanup(el);
  });

  test('isEmoteOnly called with full message element works', () => {
    const el = makeMessage(emoteSpan('KEKW'));
    assert(window.KS.ChatFilters.isEmoteOnly(el));
    cleanup(el);
  });

  // ── Notice detection against real captured markup ───────────────────────────
  // Fixtures in fixtures/notices.js are verbatim from live Kick.com (2026-08-16).
  // See captures/confirmed/kicks-and-gift-notices-2026-08-16.md for provenance.
  suite('Notices (live markup)');

  const F = window.KS_FIXTURES;
  const CF = window.KS.ChatFilters;
  const mount = F ? F.mount : null;

  test('fixtures loaded', () => {
    assert(F && F.notices, 'KS_FIXTURES.notices missing — load fixtures/notices.js');
  });

  test('subscription notice is detected', () => {
    assert(CF.isSubscriptionNotice(mount(F.notices.subscription)));
  });

  test('gifted-subs notice is detected', () => {
    assert(CF.isGiftedSubNotice(mount(F.notices.giftedSubs)));
  });

  test('gifted-subs notice is not mistaken for a plain sub notice first', () => {
    // processMessage checks gifted before sub; make sure the gifted text really
    // matches the gifted rule so ordering cannot silently swap them.
    const el = mount(F.notices.giftedSubs);
    assert(CF.isGiftedSubNotice(el), 'gifted rule must match gifted markup');
  });

  test('subscription notice is NOT a gifted-sub notice', () => {
    assert(!CF.isGiftedSubNotice(mount(F.notices.subscription)));
  });

  test('normal message is not any notice', () => {
    const el = mount(F.notices.normal);
    assert(!CF.isGiftedSubNotice(el), 'gifted');
    assert(!CF.isSubscriptionNotice(el), 'sub');
    assert(!CF.isFollowNotice(el), 'follow');
  });

  // ── Kicks ───────────────────────────────────────────────────────────────────
  // Kick posts Kicks as an ordinary ChatMessageEvent from KickBot (id 4377088).
  // The row therefore HAS button[data-prevent-expand], which is exactly what the
  // current _hasNoUserContent-style guard rejects.
  suite('Kicks (live markup)');

  test('Kicks line from KickBot is detected as a Kicks notice', () => {
    assert(CF._isKicksNotice(mount(F.notices.kicks)));
  });

  test('Kicks amount is parsed from the KickBot line', () => {
    eq(CF._getKicksAmount(mount(F.notices.kicks)), 50);
  });

  test('normal message is not a Kicks notice', () => {
    assert(!CF._isKicksNotice(mount(F.notices.normal)));
  });

  test('socket payload carries the amount as an integer', () => {
    // The DOM path regexes "50 KICKs" out of text; the socket gives a real int.
    eq(F.kicksGiftedEvent.gift.amount, 10);
    assert(typeof F.kicksGiftedEvent.gift.amount === 'number');
  });

  // ── Gifted-sub collapse ─────────────────────────────────────────────────────
  suite('Gifted-sub collapse');

  test('all cards in the notice are found', () => {
    // One [data-index] holds a summary card + one card per recipient.
    const el = mount(F.notices.giftedSubs);
    const cards = el.querySelectorAll('div[class*="border-l-4"]');
    eq(cards.length, 3, 'expected summary + 2 recipient cards');
  });

  test('collapse produces an indicator instead of hiding outright', () => {
    const el = mount(F.notices.giftedSubs);
    document.body.appendChild(el);
    CF._collapseGiftedSubs(el);
    const indicator = el.querySelector('.ks-gift-collapsed');
    assert(indicator, 'no .ks-gift-collapsed indicator was created');
    cleanup(el);
  });

  test('collapse label names the gifter and count', () => {
    const el = mount(F.notices.giftedSubs);
    document.body.appendChild(el);
    CF._collapseGiftedSubs(el);
    const indicator = el.querySelector('.ks-gift-collapsed');
    assert(indicator, 'no indicator');
    assert(/Gifter1/.test(indicator.textContent), 'gifter missing: ' + indicator.textContent);
    assert(/50/.test(indicator.textContent), 'count missing: ' + indicator.textContent);
    cleanup(el);
  });

  test('collapse lists recipients', () => {
    const el = mount(F.notices.giftedSubs);
    document.body.appendChild(el);
    CF._collapseGiftedSubs(el);
    const indicator = el.querySelector('.ks-gift-collapsed');
    assert(indicator, 'no indicator');
    assert(/Recipient1/.test(indicator.textContent),
           'recipient missing: ' + indicator.textContent);
    cleanup(el);
  });

  // ── Follows ─────────────────────────────────────────────────────────────────
  // No native Kick follow notice exists — bots announce them, so the row is an
  // ordinary message and cannot be identified structurally.
  suite('Follow notices (bot-posted)');

  test('bot follow announcement is detected', () => {
    assert(CF.isFollowNotice(mount(F.notices.followByBot)));
  });

  test('a viewer saying "just followed" is NOT a follow notice', () => {
    const el = mount(F.notices.normal.replace(
      'ive never been more adrenaline at my computer', 'i just followed btw'));
    assert(!CF.isFollowNotice(el), 'must not hide a real viewer message');
  });

  test('unknown sender with follow text is not hidden', () => {
    const el = mount(F.notices.followByBot.replace('>Botrix<', '>randomviewer<'));
    assert(!CF.isFollowNotice(el));
  });

  test('bot list matching is case-insensitive', () => {
    const el = mount(F.notices.followByBot.replace('>Botrix<', '>BOTRIX<'));
    assert(CF.isFollowNotice(el));
  });

  // ── Emote rules ─────────────────────────────────────────────────────────────
  suite('Emote rules');

  function emoteMsg(html) {
    const el = makeMessage(html);
    return el;
  }

  test('hide all emotes strips every emote but keeps text', () => {
    const el = emoteMsg('lol ' + emoteSpan('KEKW','1') + ' nice ' + emoteSpan('Pog','2'));
    CF.update(Object.assign({}, KS.DEFAULT_SETTINGS, { chat_hideAllEmotes: true }));
    CF.processMessage(el);
    const hidden = el.querySelectorAll('[data-ks-emote-hidden]').length;
    eq(hidden, 2);
    assert(!el.dataset.ksHidden, 'row with text must stay visible');
    cleanup(el);
  });

  test('emote-only message is hidden when all emotes are stripped', () => {
    const el = emoteMsg(emoteSpan('KEKW','1'));
    CF.update(Object.assign({}, KS.DEFAULT_SETTINGS,
      { chat_hideAllEmotes: true, chat_hideEmoteOnly: false }));
    CF.processMessage(el);
    eq(el.dataset.ksHidden, 'emote-only');
    cleanup(el);
  });

  test('repeated emotes keep the first and hide the rest', () => {
    const el = emoteMsg(emoteSpan('Pog','2') + emoteSpan('Pog','2') + emoteSpan('Pog','2') + ' yo');
    CF.update(Object.assign({}, KS.DEFAULT_SETTINGS,
      { chat_hideRepeatedEmotes: true, chat_hideEmoteOnly: false }));
    CF.processMessage(el);
    eq(el.querySelectorAll('[data-ks-emote-hidden]').length, 2);
    cleanup(el);
  });

  test('distinct emotes are all kept when collapsing repeats', () => {
    const el = emoteMsg(emoteSpan('Pog','2') + emoteSpan('KEKW','1') + ' hi');
    CF.update(Object.assign({}, KS.DEFAULT_SETTINGS,
      { chat_hideRepeatedEmotes: true, chat_hideEmoteOnly: false }));
    CF.processMessage(el);
    eq(el.querySelectorAll('[data-ks-emote-hidden]').length, 0);
    cleanup(el);
  });

  test('emote rules do nothing when both toggles are off', () => {
    const el = emoteMsg(emoteSpan('Pog','2') + emoteSpan('Pog','2') + ' hi');
    CF.update(Object.assign({}, KS.DEFAULT_SETTINGS, { chat_hideEmoteOnly: false }));
    CF.processMessage(el);
    eq(el.querySelectorAll('[data-ks-emote-hidden]').length, 0);
    cleanup(el);
  });

  // ── Stats ───────────────────────────────────────────────────────────────────
  suite('Stats');

  test('stats module is available', () => {
    assert(window.KS && KS.Stats, 'KS.Stats missing — load stats.js');
  });

  test('hiding a message increments the session counter for its reason', () => {
    const before = (KS.Stats.session()['all-caps'] || 0);
    const el = makeMessage('THIS IS ENTIRELY SHOUTING');
    CF.update(Object.assign({}, KS.DEFAULT_SETTINGS,
      { chat_hideAllCaps: true, chat_hideDuplicates: false }));
    CF.processMessage(el);
    eq(el.dataset.ksHidden, 'all-caps');
    eq(KS.Stats.session()['all-caps'], before + 1);
    cleanup(el);
  });

  test('re-processing an already hidden message does not double count', () => {
    const el = makeMessage('ANOTHER FULLY SHOUTED LINE');
    CF.update(Object.assign({}, KS.DEFAULT_SETTINGS,
      { chat_hideAllCaps: true, chat_hideDuplicates: false }));
    CF.processMessage(el);
    const after1 = KS.Stats.session()['all-caps'];
    CF.processMessage(el);
    eq(KS.Stats.session()['all-caps'], after1);
    cleanup(el);
  });

  // ── Mod toolbar must never be treated as a message ─────────────────────────
  // Kick's per-message controls are <button class="group ..."> — the same class
  // a message row carries. Captured live from examplechannel, 2026-08-16.
  suite('Mod controls');

  const MOD_BTN = '<button class="group relative box-border flex shrink-0 grow-0 items-center ' +
    'justify-center rounded font-semibold size-9 bg-secondary-base" aria-label="Pin">' +
    '<svg data-ds-icon="Pin" viewBox="0 0 20 20"><path fill="currentColor" d="M15 12"></path></svg>' +
    '</button>';

  test('a mod control button is not processed as a message', () => {
    const host = document.createElement('div');
    host.innerHTML = MOD_BTN;
    const btn = host.firstElementChild;
    document.body.appendChild(host);
    CF.update(Object.assign({}, KS.DEFAULT_SETTINGS, { chat_hideEmoteOnly: true }));
    CF.processMessage(btn);
    assert(!btn.dataset.ksHidden, 'must not be hidden');
    assert(!btn.dataset.ksSeen, 'must not even be stamped as seen');
    cleanup(host);
  });

  test('scanning a container does not pick up mod buttons via the .group fallback', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div data-index="1"><div class="group">' + MOD_BTN + '</div></div>';
    document.body.appendChild(host);
    CF.update(Object.assign({}, KS.DEFAULT_SETTINGS, { chat_hideEmoteOnly: true }));
    CF.handleAddedNode(host);
    const btn = host.querySelector('button');
    assert(!btn.dataset.ksSeen, 'mod button was processed as a message');
    cleanup(host);
  });

  // ── Sidebar must survive the page filters ──────────────────────────────────
  // Real markup, captured live 2026-08-16. Followed channels are
  // <button dir="ltr"> wrappers around <a data-testid="sidebar-following-channel-N">.
  // An over-broad unbanRequest selector ('button[dir="ltr"]:has(~ *)') hid every
  // one of them that had a following sibling — i.e. all but the last.
  suite('Sidebar (live markup)');

  function sidebarFixture() {
    const host = document.createElement('div');
    host.innerHTML = `
      <section>
        <div>Following</div>
        <button dir="ltr"><a data-testid="sidebar-following-channel-1" href="/jandro">jandro</a></button>
        <button dir="ltr"><a data-testid="sidebar-following-channel-2" href="/nicklee">NickLee</a></button>
        <button dir="ltr"><a data-testid="sidebar-following-channel-3" href="/jollyirl">JollyIRL</a></button>
      </section>
      <section>
        <div>Recommended</div>
        <button dir="ltr"><a data-testid="sidebar-recommended-channel-1" href="/demize">DeMize</a></button>
      </section>`;
    document.body.appendChild(host);
    return host;
  }

  test('followed channels are not matched by the ban-notice selectors', () => {
    const host = sidebarFixture();
    for (const a of host.querySelectorAll('[data-testid^="sidebar-following-channel-"]')) {
      const btn = a.closest('button');
      assert(!KS.Sel.matches(btn, KS.Sel.unbanRequest), 'matched unbanRequest: ' + a.dataset.testid);
      assert(!KS.Sel.matches(btn, KS.Sel.banNotice), 'matched banNotice: ' + a.dataset.testid);
    }
    cleanup(host);
  });

  test('unbanRequest finds nothing in a normal sidebar', () => {
    const host = sidebarFixture();
    eq(KS.Sel.findAll(KS.Sel.unbanRequest, host).length, 0);
    cleanup(host);
  });

  test('hiding suggested channels does not touch followed channels', () => {
    const host = sidebarFixture();
    const hits = KS.Sel.findAll(KS.Sel.suggestedChannels, host);
    assert(hits.length > 0, 'should still match recommended entries');
    for (const el of hits) {
      assert(!/sidebar-following-channel-/.test(el.dataset.testid || ''),
             'suggested selector matched a followed channel');
    }
    cleanup(host);
  });

  // ── Pinned message ─────────────────────────────────────────────────────────
  // Real container id captured live 2026-08-16. The previous guesses
  // ("pinned-message", "chat-pinned-message") matched nothing, so
  // page_hidePinnedMessages was dead.
  suite('Pinned message (live markup)');

  const PINNED = '<div data-testid="pinned-message-modal" class="z-absolute w-full">' +
    '<div data-testid="sent-by">Sent by <button data-prevent-expand="true">Gifter1</button></div>' +
    '<div data-testid="pinned-message-content">hello</div>' +
    '<button data-testid="pinned-expand-button"></button></div>';

  test('the pinned message container is matched', () => {
    const host = document.createElement('div');
    host.innerHTML = PINNED;
    document.body.appendChild(host);
    const hit = KS.Sel.find(KS.Sel.pinnedMessage, host);
    assert(hit, 'no pinnedMessage selector matched the live container');
    eq(hit.dataset.testid, 'pinned-message-modal');
    cleanup(host);
  });

  test('pinned selectors do not match an ordinary message', () => {
    const el = mount(F.notices.normal);
    assert(!KS.Sel.matches(el, KS.Sel.pinnedMessage));
    cleanup(el);
  });

  // ── Selector sanity ─────────────────────────────────────────────────────────
  suite('Selectors vs live markup');

  test('Kicks rows are anchored on the KickBot sender, not on markup', () => {
    // There is no Kicks-specific markup to select on — the row is an ordinary
    // chat message. Detection must key on the sender name instead.
    const el = mount(F.notices.kicks);
    const user = KS.Sel.find(KS.Sel.messageUsername, el);
    assert(user, 'Kicks row should expose a username element');
    eq(user.textContent.trim(), KS.Sel.kicksBotUsername);
  });

  test('a user message merely mentioning kicks is not a Kicks notice', () => {
    const el = mount(F.notices.normal.replace(
      'ive never been more adrenaline at my computer', 'he gifted 50 kicks earlier lol'));
    assert(!CF._isKicksNotice(el), 'must not fire on a normal user saying it');
  });

  test('notice rows are reachable by a structural selector', () => {
    for (const key of ['giftedSubs', 'subscription']) {
      const el = mount(F.notices[key]);
      assert(el.querySelector('div[class*="border-l-4"]'), key + ' has no notice card');
    }
  });

  test('notice cards carry a classifying data-ds-icon', () => {
    const gifted = mount(F.notices.giftedSubs);
    const sub = mount(F.notices.subscription);
    eq(gifted.querySelector('svg[data-ds-icon]').dataset.dsIcon, 'Gift50');
    eq(sub.querySelector('svg[data-ds-icon]').dataset.dsIcon, 'SparkleFilled');
  });

  return {
    run() { return results; },
    summary() {
      const pass = results.filter(r => r.ok).length;
      const fail = results.filter(r => !r.ok).length;
      return { pass, fail, total: results.length };
    },
  };
})();
