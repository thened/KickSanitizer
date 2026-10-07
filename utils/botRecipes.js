// botRecipes.js — user-editable rules that hide or highlight chat messages.
//
// A bot that does many jobs is all-or-nothing to block, and people usually
// object to one job rather than the bot. A recipe is a named set of rules, each
// matching one account's messages — or anyone's, with account "*" — by what
// they start with, end with, or contain, and then hiding or highlighting them.
// Recipes can be limited to channels, edited freely, and shared as plain text.
//
// Shared as READABLE JSON rather than an encoded blob, on purpose: someone
// pasting a recipe from chat can see exactly what it hides before they add it.
// Rules are data only — nothing in a recipe is ever executed, and the popup
// renders every field as text.
//
// Loaded by both the content scripts and the popup, so the defaults and the
// validation live in one place.

window.KS = window.KS || {};

KS.BotRecipes = (function () {

  const FORMAT = 1;

  // Limits for anything pasted in. Generous for real use, small enough that a
  // hostile paste cannot balloon storage or the popup.
  const MAX_INPUT = 20000;
  const MAX_RULES = 40;
  const MAX_CHANNELS = 20;
  const MAX_MARKERS = 12;
  const MAX_TEXT = 40;

  // "*" is anyone: a word or spoiler mute rather than a per-bot rule.
  const ACCOUNT_RE = /^(\*|[a-z0-9_]{1,25})$/;
  const ACTIONS = ['hide', 'highlight'];
  const CHANNEL_RE = /^[a-z0-9_-]{1,30}$/;

  // NedBot's categories, measured from its own output (400 messages,
  // 2026-10-06/07): leading 🚀 109, 📊 95, 🔨 93, 🗳️ 18, racing/betting ~10.
  //
  // Pokémon messages are marked at the END with 🃏 or 📿 — all 8 that did were
  // Pokémon, and nothing else nedbot posted ends with either. Trailing emoji are
  // otherwise decoration (the racing promos end in 👑 🏆 🎰), so `end` is only
  // used where the data shows it is exclusive. Lookups carry no emoji at all;
  // that rule waits on nedbot leading them with 🔎.
  const DEFAULTS = [
    {
      name: 'NedBot',
      channels: [],
      rules: [
        { label: 'Raids',                            account: 'nedbot', start: ['🚀'] },
        { label: 'Raid follow-ups',                  account: 'nedbot', start: ['📊'] },
        { label: 'Bans & timeouts in other channels', account: 'nedbot', start: ['🔨'] },
        { label: 'Polls in other channels',          account: 'nedbot', start: ['🗳'] },
        { label: 'Horse racing & betting',           account: 'nedbot', start: ['🏇', '📅', '💥', '💸', '🏆'] },
        { label: 'Daily points',                     account: 'nedbot', start: ['✨'] },
        { label: 'Pokémon cards',                    account: 'nedbot', start: ['🃏'], end: ['🃏', '📿'] },
        { label: 'Lookups',                          account: 'nedbot', start: ['🔎'] },
      ],
    },
  ];

  // ── Normalising ────────────────────────────────────────────────────────────

  function _list(v) {
    if (typeof v === 'string') v = v.split(',');
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const item of v) {
      if (typeof item !== 'string') continue;
      const t = item.trim().slice(0, MAX_TEXT);
      if (t && !out.includes(t)) out.push(t);
      if (out.length >= MAX_MARKERS) break;
    }
    return out;
  }

  function _rule(r) {
    if (!r || typeof r !== 'object') return null;
    const account = String(r.account || '').trim().toLowerCase().replace(/^@/, '');
    if (!ACCOUNT_RE.test(account)) return null;
    const rule = {
      label: String(r.label || '').trim().slice(0, MAX_TEXT) || account,
      account,
      start: _list(r.start),
      end: _list(r.end),
      contains: _list(r.contains),
      action: ACTIONS.includes(r.action) ? r.action : 'hide',
      // The switch was called `hide` while hiding was the only action. Read
      // either, write `on`: recipes shared before the rename still load.
      on: r.on === true || r.hide === true,
    };
    // A rule with nothing to match would either do nothing or, worse, read as
    // "everything" to someone skimming it.
    if (!rule.start.length && !rule.end.length && !rule.contains.length) return null;
    return rule;
  }

  function normalise(recipe) {
    if (!recipe || typeof recipe !== 'object') return null;
    const name = String(recipe.name || '').trim().slice(0, MAX_TEXT);
    if (!name) return null;
    const channels = [];
    for (const c of Array.isArray(recipe.channels) ? recipe.channels : _list(recipe.channels)) {
      const slug = String(c || '').trim().toLowerCase();
      if (CHANNEL_RE.test(slug) && !channels.includes(slug)) channels.push(slug);
      if (channels.length >= MAX_CHANNELS) break;
    }
    const rules = [];
    for (const r of Array.isArray(recipe.rules) ? recipe.rules : []) {
      const rule = _rule(r);
      if (rule) rules.push(rule);
      if (rules.length >= MAX_RULES) break;
    }
    return { name, channels, rules };
  }

  function defaults() {
    return DEFAULTS.map(normalise);
  }

  // ── Matching ───────────────────────────────────────────────────────────────

  // U+FE0F only asks for emoji presentation; 🗳 and 🗳️ are the same marker.
  // Stripped from both sides so a recipe matches whichever form a bot sends.
  const _plain = s => String(s || '').replace(/️/g, '');

  // Defensive about shape even though stored recipes are normalised: this runs
  // on every chat message, and a malformed rule must fail to match, not throw.
  function ruleMatches(rule, text) {
    const t = _plain(text);
    const lead = t.trimStart();
    const tail = t.trimEnd();
    // An empty marker would match every message — every string starts with "".
    const marks = a => (Array.isArray(a) ? a : []).map(_plain).filter(Boolean);
    if (marks(rule.start).some(m => lead.startsWith(m))) return true;
    if (marks(rule.end).some(m => tail.endsWith(m))) return true;
    const contains = marks(rule.contains);
    if (contains.length) {
      const low = t.toLowerCase();
      if (contains.some(m => low.includes(m.toLowerCase()))) return true;
    }
    return false;
  }

  // The first switched-on rule with `action` that matches, as
  // { recipe, rule, label } (indices into `recipes`), or null. `channel` is the
  // current channel slug, or null off a channel page. A rule from before
  // actions existed has no `action` and is a hide rule.
  function find(username, text, recipes, channel, action) {
    if (!username || !text || !Array.isArray(recipes) || !recipes.length) return null;
    const user = String(username).toLowerCase();
    const here = channel ? String(channel).toLowerCase() : null;
    for (let ri = 0; ri < recipes.length; ri++) {
      const recipe = recipes[ri];
      if (!recipe || !Array.isArray(recipe.rules)) continue;
      if (recipe.channels && recipe.channels.length && !(here && recipe.channels.includes(here))) continue;
      for (let i = 0; i < recipe.rules.length; i++) {
        const rule = recipe.rules[i];
        if (!rule || !(rule.on || rule.hide)) continue;
        if ((rule.action || 'hide') !== action) continue;
        if (rule.account !== '*' && rule.account !== user) continue;
        if (ruleMatches(rule, text)) return { recipe: ri, rule: i, label: rule.label };
      }
    }
    return null;
  }

  function isHidden(username, text, recipes, channel) {
    return !!find(username, text, recipes, channel, 'hide');
  }

  function highlightOf(username, text, recipes, channel) {
    return find(username, text, recipes, channel, 'highlight');
  }

  // ── Sharing ────────────────────────────────────────────────────────────────

  // The sharer's hide switches travel with the recipe as a suggestion; the
  // person adding it can change any of them.
  function serialise(recipe) {
    const r = normalise(recipe);
    if (!r) return '';
    const rules = r.rules.map((rule) => {
      const out = { label: rule.label, account: rule.account };
      if (rule.start.length) out.start = rule.start;
      if (rule.end.length) out.end = rule.end;
      if (rule.contains.length) out.contains = rule.contains;
      if (rule.action !== 'hide') out.action = rule.action;
      if (rule.on) out.on = true;
      return out;
    });
    return JSON.stringify({ kickSanitizerRecipe: FORMAT, name: r.name, channels: r.channels, rules });
  }

  // Throws with a message fit to show the user.
  function parse(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('Paste a recipe first.');
    if (raw.length > MAX_INPUT) throw new Error('That is too long to be a recipe.');
    let data;
    try { data = JSON.parse(raw); } catch (_) { throw new Error('That is not a recipe — it is not valid JSON.'); }
    if (!data || data.kickSanitizerRecipe !== FORMAT) throw new Error('That is not a KickSanitizer recipe.');
    const recipe = normalise(data);
    if (!recipe) throw new Error('The recipe has no name.');
    if (!recipe.rules.length) throw new Error('The recipe has no usable rules.');
    return recipe;
  }

  return { defaults, normalise, find, isHidden, highlightOf, ruleMatches, serialise, parse };
})();
