// popup.js — KickSanitizer popup controller

(function () {
  'use strict';

  // Use the KS storage helpers if injected, otherwise fall back to chrome.storage directly
  const DEFAULT = {
    enabled: true,
    chat_hideDuplicates: true,
    chat_duplicateWindowSeconds: 300,
    chat_similarityMode: 'normalized',
    chat_hideEmoteOnly: true,
    chat_mizkifMode: false,
    chat_maxEmotes: 0,
    chat_collapseGlobalCopypasta: false,
    chat_copypastaThreshold: 5,
    chat_copypastaWindowSeconds: 60,
    chat_hideBotCommands: false,
    chat_hideLevelUps: false,
    chat_hideBurstSpam: false,
    chat_burstSpamThreshold: 6,
    chat_hideBotResponses: false,
    chat_hideAllCaps: false,
    chat_hideRepeatedChars: false,
    chat_hideLinks: false,
    chat_hideGiftedSubNotices: false,
    chat_collapseGiftedSubs: false,
    chat_hideSubscriptionNotices: false,
    chat_hideFollowNotices: false,
    chat_hideRedemptions: false,
    chat_keepDeletedMessages: false,
    chat_showTimestamps: false,
    chat_restoreFocusAfterCooldown: true,
    chat_neverFilterMentions: true,
    chat_chattersWindow: 15,
    chat_hideLevelBadges: true,
    chat_hideModBadges: false,
    chat_hideOtherBadges: false,
    chat_kicksMinAmount: 0,
    chat_kicksPills: 'show',
    // NOTE: this duplicates KS.DEFAULT_SETTINGS in storage.js, which popup.html
    // does not load. Keep the two in step — when they drifted, new settings
    // rendered with the wrong state (clean chat showed as off while defaulting
    // to on) until the user touched the control.
    chat_mirrorMode: true,
    chat_showModeToggle: true,
    chat_theme: 'normal',
    chat_hideAllEmotes: false,
    chat_hideRepeatedEmotes: false,
    chat_minMessageLength: 0,
    chat_hideBotGames: false,
    chat_botGameCommands: 'fish,hunt,duel,flag,country,guess,slots,cookie,mine,farm',
    page_autoAcceptChatRules: false,
    page_autoClaimRewards: false,
    page_hideKicks: true,
    page_hideChannelPoints: false,
    page_hideKicksBalance: false,
    page_hideTopGifters: true,
    page_hideGiftAnimations: true,
    page_hidePinnedMessages: false,
    page_hidePollsPredictions: false,
    page_hideGoals: false,
    page_hideBanNotice: false,
    page_hideSuggestedChannels: true,
    page_hideRecommendedStreams: false,
    page_hideNotifications: false,
    page_hideAutoplayOverlays: false,
    page_autoDismissGiftDialog: false,
    page_forceViewerCount: false,
    page_liveSaysLame: false,
    scope: 'all',
    developerMode: false,
  };

  let _settings = Object.assign({}, DEFAULT);
  // When opened as a standalone window from the in-page "Open full settings"
  // button, the active-tab lookup below cannot see the Kick tab (this window is
  // its own "current window"), so background.js passes the slug in the query
  // string. The tab lookup leaves this value alone when it finds no kick.com tab.
  let _channel = new URLSearchParams(location.search).get('channel') || null;
  let _blockedChannels = [];
  let _blockedChatters = [];
  let _recipes = [];

  // ── Storage helpers ────────────────────────────────────────────────────────

  function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.sync.get(null, (synced) => {
        chrome.storage.local.get(['channelOverrides', 'blockedChannels', 'blockedChatters', 'botRecipes'], (local) => {
          _blockedChannels = local.blockedChannels || [];
          _blockedChatters = local.blockedChatters || [];
          // Never saved means the shipped defaults, not an empty list.
          _recipes = Array.isArray(local.botRecipes)
            ? local.botRecipes.map(KS.BotRecipes.normalise).filter(Boolean)
            : KS.BotRecipes.defaults();
          _settings = Object.assign({}, DEFAULT, synced, local);
          resolve(_settings);
        });
      });
    });
  }

  // Keys that describe the extension itself rather than filtering behaviour.
  // These are always global — a per-channel "scope" or blocklist is nonsense.
  const GLOBAL_ONLY = new Set([
    'scope', 'channelOverrides', 'blockedChannels', 'developerMode', 'enabled',
  ]);

  function saveSetting(key, value) {
    // Honour the Scope tab. This previously wrote everything globally, so
    // "This channel only" silently did nothing and KS.setChannelOverride was
    // dead code — which is why the popup looked per-channel but never was.
    const scope = _settings.scope || 'all';

    if (scope === 'channel' && _channel && !GLOBAL_ONLY.has(key)) {
      const overrides = Object.assign({}, _settings.channelOverrides || {});
      overrides[_channel] = Object.assign({}, overrides[_channel] || {}, { [key]: value });
      _settings.channelOverrides = overrides;
      _settings[key] = value;
      chrome.storage.local.set({ channelOverrides: overrides });
      render();
      return;
    }

    const data = { [key]: value };
    // channelOverrides goes to local
    if (key === 'channelOverrides') {
      chrome.storage.local.set(data);
    } else {
      chrome.storage.sync.set(data);
    }
    _settings[key] = value;
  }

  // ── Tab handling ───────────────────────────────────────────────────────────

  document.querySelectorAll('.ks-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ks-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.ks-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
  });

  // ── Render settings into UI ────────────────────────────────────────────────

  function render() {
    // Master toggle
    const masterCb = document.getElementById('master-enabled');
    masterCb.checked = !!_settings.enabled;

    // All checkboxes with data-key
    document.querySelectorAll('input[type="checkbox"][data-key]').forEach(cb => {
      cb.checked = !!_settings[cb.dataset.key];
    });

    // All selects with data-key
    document.querySelectorAll('select[data-key]').forEach(sel => {
      sel.value = String(_settings[sel.dataset.key]);
    });
    // Number inputs
    document.querySelectorAll('input[type="number"][data-key]').forEach(inp => {
      inp.value = _settings[inp.dataset.key] ?? 0;
    });

    // Max emotes label
    const maxEv = document.getElementById('max-emotes-val');
    if (maxEv) maxEv.textContent = _settings.chat_maxEmotes > 0 ? _settings.chat_maxEmotes : 'disabled';

    // Kicks min label
    const kicksMinV = document.getElementById('kicks-min-val');
    if (kicksMinV) kicksMinV.textContent = _settings.chat_kicksMinAmount > 0 ? _settings.chat_kicksMinAmount : 'disabled';

    _renderBlocklist();
    _renderBotlist();
    _renderRecipes();
    _renderSources();

    // Scope radios
    document.querySelectorAll('input[name="scope"]').forEach(r => {
      r.checked = (r.value === (_settings.scope || 'all'));
    });

    // Sub-option visibility
    _toggleSub('dupe-options', _settings.chat_hideDuplicates);
    _toggleSub('copypasta-options', _settings.chat_collapseGlobalCopypasta);

    // Channel bar. Say plainly whether this channel actually differs from your
    // global settings — it used to appear on every channel page with a reset
    // button even when there was nothing to reset, which made the whole popup
    // read as if settings were per-channel.
    if (_channel) {
      const bar = document.getElementById('channel-bar');
      bar.hidden = false;
      document.getElementById('current-channel-name').textContent = _channel;

      const ov = (_settings.channelOverrides || {})[_channel] || {};
      const n = Object.keys(ov).length;
      const state = document.getElementById('channel-override-state');
      if (state) {
        state.textContent = n
          ? `${n} setting${n === 1 ? '' : 's'} overridden here`
          : 'using your settings for all channels';
      }
      const reset = document.getElementById('clear-channel-overrides');
      if (reset) reset.hidden = !n;
    }
  }

  function _renderBotlist() {
    const container = document.getElementById('botlist-container');
    if (!container) return;
    if (!_blockedChatters.length) {
      container.innerHTML = '<p class="ks-blocklist-empty">No accounts marked yet.</p>';
      return;
    }
    // textContent, never innerHTML, for the names: these are strings a stranger
    // chose, and building markup out of them would make chat an injection
    // surface into the extension's own UI.
    container.innerHTML = '';
    _blockedChatters.forEach((name, i) => {
      const row = document.createElement('div');
      row.className = 'ks-blocklist-item';
      const label = document.createElement('span');
      label.className = 'ks-blocklist-slug';
      label.textContent = name;
      const rm = document.createElement('button');
      rm.className = 'ks-blocklist-remove';
      rm.textContent = '✕';
      rm.title = 'Unmark ' + name;
      rm.addEventListener('click', () => {
        _blockedChatters = _blockedChatters.filter((_, j) => j !== i);
        chrome.storage.local.set({ blockedChatters: _blockedChatters }, _renderBotlist);
      });
      row.appendChild(label);
      row.appendChild(rm);
      container.appendChild(row);
    });
  }

  function _addMarkedBot() {
    const input = document.getElementById('botlist-add');
    if (!input) return;
    const name = String(input.value || '').trim().toLowerCase().replace(/^@/, '');
    if (!name || _blockedChatters.includes(name)) { input.value = ''; return; }

    _blockedChatters.push(name);
    chrome.storage.local.set({ blockedChatters: _blockedChatters }, _renderBotlist);
    input.value = '';

    // Reporting is a separate switch and happens only if it is on. Failures are
    // deliberately silent to the user's own list: the local mark has already
    // taken effect, and the report is a bonus rather than the point.
    // Reported only to sources with reporting switched on; if none are, this
    // resolves immediately having sent nothing.
    if (window.KS && KS.BotList) KS.BotList.submit(name, _settings).catch(() => {});
  }

  // ── Bot recipes ────────────────────────────────────────────────────────────
  //
  // Every field is rendered with textContent. A recipe can arrive pasted from a
  // stranger in chat, so none of it may ever become markup.

  // Which editor is open: { r, i } for a rule (i === -1 for a new one), or
  // { r, recipe: true } for a recipe's name and channels. One at a time.
  let _recipeEditing = null;

  function _el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function _saveRecipes() {
    chrome.storage.local.set({ botRecipes: _recipes }, _renderRecipes);
  }

  function _recipeMsg(text, isErr) {
    const m = document.getElementById('recipe-msg');
    if (!m) return;
    m.textContent = text || '';
    m.classList.toggle('ks-recipe-err', !!isErr);
  }

  function _ruleSummary(rule) {
    const parts = [rule.account];
    if (rule.start.length) parts.push('starts ' + rule.start.join(' '));
    if (rule.end.length) parts.push('ends ' + rule.end.join(' '));
    if (rule.contains.length) parts.push('contains "' + rule.contains.join('", "') + '"');
    return parts.join(' · ');
  }

  // A labelled input in the two-column editor grid.
  function _field(grid, label, value, placeholder) {
    grid.appendChild(_el('label', null, label));
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = value || '';
    if (placeholder) inp.placeholder = placeholder;
    grid.appendChild(inp);
    return inp;
  }

  function _ruleEditor(r, i) {
    const recipe = _recipes[r];
    const rule = i >= 0 ? recipe.rules[i]
      : { label: '', account: (recipe.rules[0] && recipe.rules[0].account) || '', start: [], end: [], contains: [], hide: false };
    const grid = _el('div', 'ks-recipe-edit');
    const fLabel = _field(grid, 'Label', rule.label, 'Raids');
    const fAcct = _field(grid, 'Account', rule.account, 'nedbot');
    const fStart = _field(grid, 'Starts with', rule.start.join(', '), '🚀, 📊');
    const fEnd = _field(grid, 'Ends with', rule.end.join(', '), '🃏');
    const fHas = _field(grid, 'Contains', rule.contains.join(', '), 'some text');

    const acts = _el('div', 'ks-recipe-actions');
    const save = _el('button', 'ks-link-btn', 'Save');
    const cancel = _el('button', 'ks-link-btn', 'Cancel');
    const err = _el('span', 'ks-hint ks-recipe-err');
    save.addEventListener('click', () => {
      // Through the same validation as a pasted recipe, so the editor cannot
      // store anything an import would refuse.
      const check = KS.BotRecipes.normalise({ name: 'x', rules: [{
        label: fLabel.value, account: fAcct.value,
        start: fStart.value, end: fEnd.value, contains: fHas.value,
        hide: rule.hide,
      }] });
      const clean = check && check.rules[0];
      if (!clean) {
        err.textContent = 'Needs an account name and at least one thing to match.';
        return;
      }
      if (i >= 0) recipe.rules[i] = clean;
      else recipe.rules.push(clean);
      _recipeEditing = null;
      _saveRecipes();
    });
    cancel.addEventListener('click', () => { _recipeEditing = null; _renderRecipes(); });
    acts.append(save, cancel);
    if (i >= 0) {
      const del = _el('button', 'ks-link-btn', 'Delete rule');
      del.addEventListener('click', () => {
        recipe.rules.splice(i, 1);
        _recipeEditing = null;
        _saveRecipes();
      });
      acts.appendChild(del);
    }
    acts.appendChild(err);
    grid.appendChild(acts);
    return grid;
  }

  function _recipeEditor(r) {
    const recipe = _recipes[r];
    const grid = _el('div', 'ks-recipe-edit');
    const fName = _field(grid, 'Name', recipe.name, 'NedBot');
    const fChan = _field(grid, 'Channels', recipe.channels.join(', '), 'blank = every channel');
    const acts = _el('div', 'ks-recipe-actions');
    const save = _el('button', 'ks-link-btn', 'Save');
    const cancel = _el('button', 'ks-link-btn', 'Cancel');
    const err = _el('span', 'ks-hint ks-recipe-err');
    save.addEventListener('click', () => {
      const clean = KS.BotRecipes.normalise({ name: fName.value, channels: fChan.value, rules: recipe.rules });
      if (!clean) { err.textContent = 'Needs a name.'; return; }
      _recipes[r] = clean;
      _recipeEditing = null;
      _saveRecipes();
    });
    cancel.addEventListener('click', () => { _recipeEditing = null; _renderRecipes(); });
    acts.append(save, cancel, err);
    grid.appendChild(acts);
    return grid;
  }

  function _renderRecipes() {
    const box = document.getElementById('recipes-container');
    if (!box) return;
    box.innerHTML = '';
    if (!_recipes.length) {
      box.appendChild(_el('p', 'ks-blocklist-empty', 'No recipes. Add one below, or restore NedBot\'s.'));
      return;
    }

    _recipes.forEach((recipe, r) => {
      const card = _el('div', 'ks-recipe');

      const head = _el('div', 'ks-recipe-head');
      head.appendChild(_el('span', 'ks-recipe-name', recipe.name));
      head.appendChild(_el('span', 'ks-recipe-where',
        recipe.channels.length ? 'only ' + recipe.channels.join(', ') : 'every channel'));
      const edit = _el('button', 'ks-recipe-icon', '✎');
      edit.title = 'Rename, or limit to channels';
      edit.addEventListener('click', () => { _recipeEditing = { r, recipe: true }; _renderRecipes(); });
      const share = _el('button', 'ks-recipe-icon', '⇪');
      share.title = 'Share this recipe';
      share.addEventListener('click', () => _shareRecipe(r));
      // Two clicks rather than confirm(): a native dialog can close the
      // extension popup when it takes focus.
      const del = _el('button', 'ks-blocklist-remove', '✕');
      del.title = 'Delete this recipe';
      del.addEventListener('click', () => {
        if (del.dataset.armed !== '1') {
          del.dataset.armed = '1';
          del.textContent = 'Delete?';
          del.style.fontSize = '11px';
          setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = '✕'; del.style.fontSize = ''; } }, 3000);
          return;
        }
        _recipes.splice(r, 1);
        _recipeEditing = null;
        _saveRecipes();
      });
      head.append(edit, share, del);
      card.appendChild(head);

      if (_recipeEditing && _recipeEditing.r === r && _recipeEditing.recipe) {
        card.appendChild(_recipeEditor(r));
      }

      recipe.rules.forEach((rule, i) => {
        const row = _el('div', 'ks-recipe-rule');
        const text = _el('div', 'ks-recipe-rule-text');
        text.appendChild(_el('div', null, rule.label));
        text.appendChild(_el('span', 'ks-hint', _ruleSummary(rule)));
        const pen = _el('button', 'ks-recipe-icon', '✎');
        pen.title = 'Change what this rule matches';
        pen.addEventListener('click', () => { _recipeEditing = { r, i }; _renderRecipes(); });
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!rule.hide;
        cb.title = 'Hide these messages';
        cb.addEventListener('change', () => { rule.hide = cb.checked; _saveRecipes(); });
        row.append(text, pen, cb);
        card.appendChild(row);
        if (_recipeEditing && _recipeEditing.r === r && _recipeEditing.i === i) {
          card.appendChild(_ruleEditor(r, i));
        }
      });

      if (_recipeEditing && _recipeEditing.r === r && _recipeEditing.i === -1) {
        card.appendChild(_ruleEditor(r, -1));
      } else {
        const add = _el('button', 'ks-link-btn', '+ Add rule');
        add.addEventListener('click', () => { _recipeEditing = { r, i: -1 }; _renderRecipes(); });
        card.appendChild(add);
      }
      box.appendChild(card);
    });
  }

  function _shareRecipe(r) {
    const text = KS.BotRecipes.serialise(_recipes[r]);
    const area = document.getElementById('recipe-text');
    const box = document.getElementById('recipe-share-box');
    if (!area || !text) return;
    area.value = text;
    if (box) box.open = true;
    area.select();
    // The text is in the box either way; the clipboard is a convenience.
    navigator.clipboard.writeText(text)
      .then(() => _recipeMsg('Copied — paste it to whoever you are sharing with.'))
      .catch(() => _recipeMsg('Copy the text above to share it.'));
  }

  function _importRecipe() {
    const area = document.getElementById('recipe-text');
    let recipe;
    try {
      recipe = KS.BotRecipes.parse(area ? area.value : '');
    } catch (e) {
      _recipeMsg(e.message, true);
      return;
    }
    // Never overwrite: the existing one may carry this user's own changes.
    let name = recipe.name;
    for (let n = 2; _recipes.some(x => x.name === name); n++) name = recipe.name + ' (' + n + ')';
    recipe.name = name;
    _recipes.push(recipe);
    if (area) area.value = '';
    _recipeMsg('Added "' + name + '" — ' + recipe.rules.length + ' rules. Check which ones are switched on.');
    _saveRecipes();
  }

  // Puts NedBot's shipped recipe back, keeping the user's switches on any rule
  // whose label still exists so restoring does not quietly undo their choices.
  function _restoreNedBot() {
    const fresh = KS.BotRecipes.defaults().find(x => x.name === 'NedBot');
    if (!fresh) return;
    const at = _recipes.findIndex(x => x.name === 'NedBot');
    if (at >= 0) {
      const had = new Map(_recipes[at].rules.map(rule => [rule.label, rule.hide]));
      fresh.rules.forEach(rule => { if (had.has(rule.label)) rule.hide = had.get(rule.label); });
      fresh.channels = _recipes[at].channels;
      _recipes[at] = fresh;
    } else {
      _recipes.unshift(fresh);
    }
    _recipeEditing = null;
    _recipeMsg('NedBot recipe restored.');
    _saveRecipes();
  }

  function _wireRecipes() {
    const on = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', fn); };
    on('recipe-import', _importRecipe);
    on('recipe-restore', _restoreNedBot);
    on('recipe-new', () => {
      let name = 'New recipe';
      for (let n = 2; _recipes.some(x => x.name === name); n++) name = 'New recipe ' + n;
      _recipes.push({ name, channels: [], rules: [] });
      _recipeEditing = { r: _recipes.length - 1, recipe: true };
      _saveRecipes();
    });
  }

  function _renderSources() {
    const box = document.getElementById('sources-container');
    if (!box) return;
    const list = Array.isArray(_settings.bots_sources) ? _settings.bots_sources : [];
    box.innerHTML = '';
    if (!list.length) {
      box.innerHTML = '<p class="ks-blocklist-empty">No shared lists.</p>';
      return;
    }
    list.forEach((src, i) => {
      const row = document.createElement('div');
      row.className = 'ks-blocklist-item';

      // textContent: a source URL is user input, and building markup from it
      // would make the settings page an injection surface.
      const url = document.createElement('span');
      url.className = 'ks-blocklist-slug';
      url.textContent = src.url;
      row.appendChild(url);

      for (const [flag, label] of [['pull', 'pull'], ['submit', 'report']]) {
        const wrap = document.createElement('label');
        wrap.style.cssText = 'display:flex;align-items:center;gap:3px;font-size:11px';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!src[flag];
        cb.addEventListener('change', () => {
          const next = list.slice();
          next[i] = Object.assign({}, next[i], { [flag]: cb.checked });
          // Turning either flag ON needs the host permission; without it the
          // fetch would fail silently and the switch would look broken.
          const need = cb.checked;
          const proceed = need && KS.BotList
            ? KS.BotList.requestPermission(src.url)
            : Promise.resolve(true);
          proceed.then((ok) => {
            if (need && !ok) { cb.checked = false; return; }
            saveSetting('bots_sources', next);
            _settings.bots_sources = next;
          });
        });
        wrap.appendChild(cb);
        wrap.appendChild(document.createTextNode(label));
        row.appendChild(wrap);
      }

      const rm = document.createElement('button');
      rm.className = 'ks-blocklist-remove';
      rm.textContent = '✕';
      rm.title = 'Remove ' + src.url;
      rm.addEventListener('click', () => {
        const next = list.filter((_, j) => j !== i);
        saveSetting('bots_sources', next);
        _settings.bots_sources = next;
        _renderSources();
      });
      row.appendChild(rm);
      box.appendChild(row);
    });
  }

  function _addSource() {
    const input = document.getElementById('source-add');
    if (!input || !window.KS || !KS.BotList) return;
    const base = KS.BotList.normaliseSource(input.value);
    if (!base) { input.value = ''; return; }

    const list = Array.isArray(_settings.bots_sources) ? _settings.bots_sources : [];
    if (list.some(s => s.url === base)) { input.value = ''; return; }

    const next = list.concat([{ url: base, pull: false, submit: false }]);
    saveSetting('bots_sources', next);
    _settings.bots_sources = next;
    input.value = '';
    _renderSources();
  }

  function _renderBlocklist() {
    const container = document.getElementById('blocklist-container');
    if (!container) return;
    if (!_blockedChannels.length) {
      container.innerHTML = '<p class="ks-blocklist-empty">No channels hidden yet.</p>';
      return;
    }
    container.innerHTML = _blockedChannels.map((slug, i) =>
      `<div class="ks-blocklist-item">
        <span class="ks-blocklist-slug">${slug}</span>
        <button class="ks-blocklist-remove" data-index="${i}" title="Remove ${slug} from blocklist">✕</button>
      </div>`
    ).join('');
    container.querySelectorAll('.ks-blocklist-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        _blockedChannels = _blockedChannels.filter((_, i) => i !== idx);
        chrome.storage.local.set({ blockedChannels: _blockedChannels }, _renderBlocklist);
      });
    });
  }

  function _toggleSub(id, visible) {
    const el = document.getElementById(id);
    if (el) el.style.opacity = visible ? '1' : '0.4';
  }

  // ── Wire up controls ───────────────────────────────────────────────────────

  function wireControls() {
    // Master toggle
    document.getElementById('master-enabled').addEventListener('change', e => {
      saveSetting('enabled', e.target.checked);
    });

    // Checkboxes
    document.querySelectorAll('input[type="checkbox"][data-key]').forEach(cb => {
      cb.addEventListener('change', () => {
        saveSetting(cb.dataset.key, cb.checked);
        if (cb.dataset.key === 'chat_hideDuplicates') _toggleSub('dupe-options', cb.checked);
        if (cb.dataset.key === 'chat_collapseGlobalCopypasta') _toggleSub('copypasta-options', cb.checked);
      });
    });

    _wireRecipes();

    // Selects
    document.querySelectorAll('select[data-key]').forEach(sel => {
      sel.addEventListener('change', () => {
        const val = isNaN(Number(sel.value)) ? sel.value : Number(sel.value);
        saveSetting(sel.dataset.key, val);
      });
    });

    // Number inputs
    document.querySelectorAll('input[type="number"][data-key]').forEach(inp => {
      inp.addEventListener('change', () => {
        const val = Math.max(0, parseInt(inp.value, 10) || 0);
        inp.value = val;
        saveSetting(inp.dataset.key, val);
        if (inp.dataset.key === 'chat_maxEmotes') {
          const lbl = document.getElementById('max-emotes-val');
          if (lbl) lbl.textContent = val > 0 ? val : 'disabled';
        }
        if (inp.dataset.key === 'chat_kicksMinAmount') {
          const lbl = document.getElementById('kicks-min-val');
          if (lbl) lbl.textContent = val > 0 ? val : 'disabled';
        }
      });
    });

    // Scope radios
    document.querySelectorAll('input[name="scope"]').forEach(r => {
      r.addEventListener('change', () => {
        if (r.checked) saveSetting('scope', r.value);
      });
    });

    // Mark a bot
    const addBtn = document.getElementById('botlist-add-btn');
    const addInput = document.getElementById('botlist-add');
    if (addBtn) addBtn.addEventListener('click', _addMarkedBot);
    const srcBtn = document.getElementById('source-add-btn');
    if (srcBtn) srcBtn.addEventListener('click', _addSource);
    if (addInput) addInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') _addMarkedBot();
    });

    // Reveal all
    document.getElementById('btn-reveal').addEventListener('click', () => {
      _sendToContent({ type: 'REVEAL_ALL' });
      _showStatus('All hidden content revealed.', 'ok');
    });

    // Reset
    document.getElementById('btn-reset').addEventListener('click', () => {
      if (!confirm('Reset all KickSanitizer settings to defaults?')) return;
      chrome.storage.sync.clear(() => {
        chrome.storage.local.clear(() => {
          _settings = Object.assign({}, DEFAULT);
          render();
          _showStatus('Settings reset to defaults.', 'ok');
        });
      });
    });

    // Export
    document.getElementById('btn-export').addEventListener('click', () => {
      loadSettings().then(s => {
        const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'kicksanitizer-settings.json';
        a.click();
        URL.revokeObjectURL(url);
        _showStatus('Settings exported.', 'ok');
      });
    });

    // Import
    document.getElementById('btn-import').addEventListener('click', () => {
      document.getElementById('import-file').click();
    });
    document.getElementById('import-file').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          const imported = JSON.parse(ev.target.result);
          const validKeys = Object.keys(DEFAULT).concat(['channelOverrides']);
          const filtered = {};
          for (const k of validKeys) {
            if (k in imported) filtered[k] = imported[k];
          }
          if (!Object.keys(filtered).length) throw new Error('No recognised settings found.');
          const syncKeys = {};
          const localKeys = {};
          for (const [k, v] of Object.entries(filtered)) {
            if (k === 'channelOverrides') localKeys[k] = v; else syncKeys[k] = v;
          }
          chrome.storage.sync.set(syncKeys, () => {
            chrome.storage.local.set(localKeys, () => {
              loadSettings().then(() => { render(); _showStatus('Settings imported.', 'ok'); });
            });
          });
        } catch (err) {
          _showStatus('Import failed: ' + err.message, 'err');
        }
        e.target.value = '';
      };
      reader.readAsText(file);
    });

    // Clear channel overrides
    const clearBtn = document.getElementById('clear-channel-overrides');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (!_channel) return;
        chrome.storage.local.get(['channelOverrides'], data => {
          const ov = Object.assign({}, data.channelOverrides || {});
          delete ov[_channel];
          chrome.storage.local.set({ channelOverrides: ov }, () => {
            _showStatus(`Overrides for #${_channel} cleared.`, 'ok');
          });
        });
      });
    }
  }

  // ── Status bar ─────────────────────────────────────────────────────────────

  function _showStatus(msg, type) {
    const el = document.getElementById('status-msg');
    el.textContent = msg;
    el.className = 'ks-status ' + (type === 'ok' ? 'ks-ok' : type === 'err' ? 'ks-err' : '');
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.hidden = true; }, 3000);
  }

  // ── Communicate with content script ───────────────────────────────────────

  function _sendToContent(msg) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]) return;
      chrome.tabs.sendMessage(tabs[0].id, msg, () => {
        if (chrome.runtime.lastError) { /* content script not on a Kick page */ }
      });
    });
  }

  function _getChannel() {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]) return;
      const url = tabs[0].url || '';
      if (!url.includes('kick.com')) return;
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_CHANNEL' }, resp => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.channel) {
          _channel = resp.channel;
          render();
          renderStats();   // per-channel group needs the slug
        }
      });
    });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  loadSettings().then(() => {
    render();
    wireControls();
    _getChannel();
    renderStats();
    const v = document.getElementById('about-version');
    if (v) v.textContent = 'v' + chrome.runtime.getManifest().version;
  });

  // ── Stats ──────────────────────────────────────────────────────────────────
  // Counts are written by stats.js from the content script into
  // chrome.storage.local; the popup only reads them.

  const STATS_KEY = 'ks_stats';
  const REASON_LABELS = {
    'duplicate': 'Duplicates', 'emote-only': 'Emote-only', 'max-emotes': 'Too many emotes',
    'emote-stripped': 'Emotes stripped', 'emote-repeat': 'Repeated emotes',
    'copypasta': 'Copypasta', 'bot-command': 'Bot commands', 'all-caps': 'All caps',
    'repeated-chars': 'Repeated characters', 'link': 'Links',
    'gifted-sub': 'Gifted-sub notices', 'sub-notice': 'Sub notices',
    'follow-notice': 'Follow notices', 'kicks-spam': 'Kicks below threshold',
    'kicks': 'Kicks UI', 'suggested-channels': 'Suggested channels',
    'top-gifters': 'Top gifters', 'gift-animations': 'Gift animations',
    'pinned': 'Pinned messages', 'polls': 'Polls & predictions', 'goals': 'Goals',
    'autoplay': 'Autoplay overlays', 'ban-notice': 'Ban notice',
    'bot-category': 'NedBot categories', 'kicks-pill': 'Kicks pills',
  };

  function _statsGroup(title, counts) {
    const entries = Object.entries(counts || {}).filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '';
    const total = entries.reduce((a, [, n]) => a + n, 0);
    let html = `<div class="ks-stats-scope">${title}</div>`;
    for (const [reason, n] of entries) {
      html += `<div class="ks-stats-row"><span>${REASON_LABELS[reason] || reason}</span><span>${n.toLocaleString()}</span></div>`;
    }
    html += `<div class="ks-stats-row ks-stats-total"><span>Total</span><span>${total.toLocaleString()}</span></div>`;
    return html;
  }

  function renderStats() {
    const body = document.getElementById('ks-stats-body');
    if (!body) return;
    chrome.storage.local.get([STATS_KEY], (data) => {
      const stats = (data && data[STATS_KEY]) || { site: {}, channels: {} };
      let html = '';
      const chan = (_channel || '').toLowerCase();
      if (chan && stats.channels && stats.channels[chan]) {
        html += _statsGroup(`This channel — ${chan}`, stats.channels[chan]);
      }
      html += _statsGroup('All channels', stats.site);
      body.innerHTML = html || '<div class="ks-stats-empty">Nothing hidden yet.</div>';
    });
  }

  const _statsResetBtn = document.getElementById('ks-stats-reset');
  if (_statsResetBtn) {
    _statsResetBtn.addEventListener('click', () => {
      chrome.storage.local.set(
        { [STATS_KEY]: { site: {}, channels: {}, updatedAt: Date.now() } },
        renderStats);
    });
  }

  // Counters tick while the popup is open — refresh on write.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STATS_KEY]) renderStats();
  });

  // Refresh if settings change in another tab/window (includes blockedChannels)
  chrome.storage.onChanged.addListener(() => {
    loadSettings().then(render);
  });
}());
