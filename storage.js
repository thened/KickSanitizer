// storage.js — KickSanitizer settings management
// All scripts share the window.KS namespace (content script isolated world).

window.KS = window.KS || {};

KS.DEFAULT_SETTINGS = {
  enabled: true,

  // ── Chat ────────────────────────────────────────────────────────────────────
  chat_hideDuplicates: true,
  chat_duplicateWindowSeconds: 300,   // 10 | 30 | 60 | 300 | 900 | 1800 | 3600
  chat_similarityMode: 'normalized',  // 'exact' | 'normalized'
  chat_hideEmoteOnly: true,
  chat_maxEmotes: 0,                  // 0 = disabled; N = hide if more than N emotes
  // Clean chat is the default: filtering in place leaves unclosable gaps in
  // Kick's virtualised list, so the mirror is the mode the extension is for.
  // Users switch to Kick's own chat from the mode bar (e.g. to moderate).
  chat_mirrorMode: true,              // render surviving messages in our own list
  chat_showModeToggle: true,          // persistent clean-chat/Kick-chat switch above chat
  chat_hideAllEmotes: false,          // strip every emote, keep the text
  chat_hideRepeatedEmotes: false,     // keep the first of each emote, drop repeats
  chat_collapseGlobalCopypasta: false,
  chat_copypastaThreshold: 5,         // number of different users sending the same msg
  chat_copypastaWindowSeconds: 60,
  chat_hideBotCommands: false,        // messages starting with !
  chat_minMessageLength: 0,           // 0 = off; hide messages shorter than N chars
  chat_hideBotGames: false,           // !fish etc. and the bot replies to them
  chat_botGameCommands: 'fish,hunt,duel,flag,country,guess,slots,cookie,mine,farm',
  chat_hideBotResponses: false,
  chat_hideAllCaps: false,
  chat_hideRepeatedChars: false,
  chat_hideLinks: false,
  chat_hideGiftedSubNotices: false,
  chat_collapseGiftedSubs: false,    // collapse to one-line summary instead of hiding
  chat_hideSubscriptionNotices: false,
  chat_hideFollowNotices: false,
  chat_kicksMinAmount: 0,             // 0 = show all; N = hide Kicks notices where amount < N
  chat_keepDeletedMessages: false,    // re-show messages removed by bans/mod deletions
  chat_showTimestamps: false,         // force Kick's built-in timestamp spans to always show
  // Kick disables the chat input for a cooldown in slow mode; focus falls to
  // the page and typing then triggers the player hotkeys. Put focus back.
  chat_restoreFocusAfterCooldown: true,

  // ── Page ────────────────────────────────────────────────────────────────────
  // Off by default on purpose: this clicks "I agree" on a channel's chat rules
  // for you. Agreeing to someone's rules is the user's call, not ours.
  page_autoAcceptChatRules: false,
  // Clicks Kick's daily-reward CTA and confirms it, for collectible emotes.
  // Off by default: it acts on the user's account for them.
  page_autoClaimRewards: false,
  page_hideKicks: true,
  page_hideTopGifters: true,
  page_hideGiftAnimations: true,
  page_hidePinnedMessages: false,
  page_hidePollsPredictions: false,
  page_hideGoals: false,
  page_hideSuggestedChannels: true,
  page_hideRecommendedStreams: false,
  page_hideAutoplayOverlays: false,
  page_hideSidebar: false,
  page_hideBanNotice: false,     // hides "you are banned" box and unban-request button

  // ── Scope ───────────────────────────────────────────────────────────────────
  scope: 'all',           // 'all' | 'channel' | 'session'

  // ── Developer ───────────────────────────────────────────────────────────────
  developerMode: false,
};

// Keys stored in chrome.storage.local instead of sync (objects, device-specific)
const LOCAL_KEYS = ['channelOverrides', 'blockedChannels'];

KS.getSettings = function () {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (synced) => {
      chrome.storage.local.get(LOCAL_KEYS, (local) => {
        const settings = Object.assign({}, KS.DEFAULT_SETTINGS, synced, local);
        resolve(settings);
      });
    });
  });
};

KS.updateSettings = function (changes) {
  const syncChanges = {};
  const localChanges = {};

  for (const [k, v] of Object.entries(changes)) {
    if (LOCAL_KEYS.includes(k)) {
      localChanges[k] = v;
    } else {
      syncChanges[k] = v;
    }
  }

  const p = [];
  if (Object.keys(syncChanges).length) p.push(new Promise(r => chrome.storage.sync.set(syncChanges, r)));
  if (Object.keys(localChanges).length) p.push(new Promise(r => chrome.storage.local.set(localChanges, r)));
  return Promise.all(p);
};

// Returns merged settings: global + channel override
KS.getEffectiveSettings = function (channel) {
  return KS.getSettings().then((settings) => {
    if (!channel) return settings;
    const overrides = (settings.channelOverrides || {})[channel] || {};
    return Object.assign({}, settings, overrides);
  });
};

// Set an override for a specific channel
KS.setChannelOverride = function (channel, key, value) {
  return KS.getSettings().then((settings) => {
    const overrides = Object.assign({}, settings.channelOverrides || {});
    overrides[channel] = Object.assign({}, overrides[channel] || {}, { [key]: value });
    return KS.updateSettings({ channelOverrides: overrides });
  });
};

KS.clearChannelOverrides = function (channel) {
  return KS.getSettings().then((settings) => {
    const overrides = Object.assign({}, settings.channelOverrides || {});
    delete overrides[channel];
    return KS.updateSettings({ channelOverrides: overrides });
  });
};

// Subscribe to settings changes
KS.onSettingsChanged = function (callback) {
  const handler = () => KS.getSettings().then(callback);
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
};

KS.exportSettings = function () {
  return KS.getSettings().then((s) => JSON.stringify(s, null, 2));
};

// Validates and imports settings JSON; only accepts known keys
KS.importSettings = function (jsonString) {
  let imported;
  try {
    imported = JSON.parse(jsonString);
  } catch (e) {
    return Promise.reject(new Error('Invalid JSON: ' + e.message));
  }

  if (typeof imported !== 'object' || imported === null) {
    return Promise.reject(new Error('Settings must be a JSON object.'));
  }

  const validKeys = Object.keys(KS.DEFAULT_SETTINGS).concat(LOCAL_KEYS);
  const filtered = {};
  for (const k of validKeys) {
    if (k in imported) filtered[k] = imported[k];
  }

  if (!Object.keys(filtered).length) {
    return Promise.reject(new Error('No recognizable settings keys found.'));
  }

  return KS.updateSettings(filtered);
};

KS.resetSettings = function () {
  return new Promise((resolve) => {
    chrome.storage.sync.clear(() => {
      chrome.storage.local.clear(resolve);
    });
  });
};
