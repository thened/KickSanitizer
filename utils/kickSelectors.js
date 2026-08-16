// kickSelectors.js — All Kick.com DOM selectors in one place.
//
// Kick uses Tailwind utility classes that are stable as long as their
// component structure doesn't change. Verified selectors come first;
// fallbacks handle future redesigns. data-testid and ARIA attributes
// are the most stable — prefer them over class patterns.
//
// TO UPDATE: Run KS.Debug.outlineAll() in the browser console on Kick.com
// to highlight detected elements, then inspect failing selectors here.
// Last verified: 2026-08-06 against kick.com/nedx

window.KS = window.KS || {};

KS.Sel = {

  // ── Chat container ───────────────────────────────────────────────────────
  // Confirmed: id="chatroom-messages" with data-testid="chatroom-messages"
  chatContainer: [
    '#chatroom-messages',
    '[data-testid="chatroom-messages"]',
    '[data-chat-scroller]',
    '[class*="chatroom"][class*="messages"]',
  ],

  // ── Individual chat messages ─────────────────────────────────────────────
  // Each message is a virtualizer row: div[data-index] > div.group
  // Target the .group div — it's the actual message root with hover styles.
  chatMessage: [
    '[data-testid="chatroom-messages"] [data-index] > div',
    '[data-testid="chatroom-messages"] .group',
    '[data-chat-entry]',
    '[data-test-id="chat-message"]',
    '.chat-message-default',
  ],

  // ── Username inside a message ────────────────────────────────────────────
  // Confirmed: button[data-prevent-expand="true"] inside each message row
  messageUsername: [
    'button[data-prevent-expand="true"]',
    '[data-chat-username]',
    '[data-username]',
    '[class*="chat-message-username"]',
  ],

  // ── Message text/content area ────────────────────────────────────────────
  // Confirmed: span.font-normal.leading-[1.55] — the last span in the row
  // after the colon span. Scoped to a message root to avoid false matches.
  messageContent: [
    'span.font-normal',
    '[data-chat-message-content]',
    '[class*="chat-message-content"]',
    '[class*="message-content"]',
  ],

  // ── Emote spans inside message content ───────────────────────────────────
  // Confirmed: emotes are span[data-emote-id][data-emote-name] elements
  // containing a div > img. They live inside span.font-normal.
  // src pattern: https://files.kick.com/emotes/{id}/fullsize
  messageEmote: [
    'span[data-emote-id]',
    'span[data-emote-name]',
    'img[src*="files.kick.com/emotes"]',
    'img[data-emote-name]',
  ],

  // ── Badge images (excluded from emote counting) ──────────────────────────
  // Confirmed: [data-testid^="identity-badge-"] wraps all badge images.
  // Badges are OUTSIDE span.font-normal (in the username wrapper div),
  // so they never appear in the content area at all.
  messageBadge: [
    '[data-testid^="identity-badge-"]',
    '[data-testid^="identity-badge-"] img',
    'img[src*="/img/gift-ranks/"]',
    '[data-badge]',
    'img[class*="badge"]',
  ],

  // ── System notices in chat ───────────────────────────────────────────────
  // These fire when subs/gifts/follows happen. Kick renders them as special
  // rows that do NOT contain button[data-prevent-expand] (no clickable username).
  // Class patterns and data-testid TBD — verify when a sub event fires.
  subscriptionNotice: [
    '[data-testid="subscription-message"]',
    '[data-testid="chat-subscription-notice"]',
    '[data-subscription-message]',
    '[class*="subscription-message"]',
    '[class*="sub-notice"]',
    // Likely same border-card structure as gifted subs but different color — TBD
  ],
  giftedSubNotice: [
    '[data-testid="gifted-subscription-message"]',
    '[data-testid="chat-gift-notice"]',
    '[data-gift-message]',
    '[class*="gift-message"]',
    '[class*="gifted-sub"]',
    // Confirmed DOM (2026-08-06): gift batch row is [data-index] > div.flex.flex-col.gap-1
    // Individual cards: div.bg-surface-base.border-l-4 with inline border-color rgb(192,112,255)
    // No data-testid. Detected via :has() on the batch container or inline style on cards.
    'div:has(div[style*="rgb(192, 112, 255)"])',
    'div[style*="border-color: rgb(192, 112, 255)"]',
  ],
  followNotice: [
    '[data-testid="follow-message"]',
    '[data-testid="chat-follow-notice"]',
    '[data-follow-message]',
    '[class*="follow-message"]',
    '[class*="follow-notice"]',
  ],

  // ── Pinned messages ──────────────────────────────────────────────────────
  // Confirmed live 2026-08-16. The container is data-testid="pinned-message-modal"
  // — NOT "pinned-message", which is what was guessed here before, so
  // page_hidePinnedMessages never matched anything. Inner parts, for reference:
  //   [data-testid="sent-by"]               author line
  //   [data-testid="pinned-message-content"] body
  //   [data-testid="pinned-expand-button"]   expand chevron
  // The prefix form is listed after the exact one to survive a rename.
  pinnedMessage: [
    '[data-testid="pinned-message-modal"]',
    '[data-testid^="pinned-message"]',
    '[data-pinned-message]',
    '[class*="pinned-message"]',
  ],

  // ── Kicks (virtual currency) panels & buttons ────────────────────────────
  kicksWidget: [
    '[data-testid="kicks-widget"]',
    '[data-testid="kicks-panel"]',
    '[data-kicks-widget]',
    '[class*="kicks-panel"]',
    '[class*="kicks-widget"]',
  ],
  // Confirmed live 2026-08-16. Both sit in the control row above the chat
  // input: <div class="flex gap-x-1 lg:w-full lg:gap-x-2">
  //   button[data-testid="channel-points-button"] > span[data-testid="channel-points-value"]
  //   button[data-testid="gift-shop-button"]      > span[data-testid="kicks-value"]
  // Hiding the button takes the icon and the number together; hiding only the
  // value would leave a bare icon with nothing in it.
  channelPointsButton: [
    '[data-testid="channel-points-button"]',
    '[data-testid="channel-points-value"]',
  ],
  kicksBalanceButton: [
    '[data-testid="gift-shop-button"]',
    '[data-testid="kicks-value"]',
  ],

  kicksButton: [
    // The real one, confirmed — the guesses below it never matched anything.
    'button[data-testid="gift-shop-button"]',
    'button[aria-label*="Kicks"]',
    'button[data-testid*="kicks"]',
    'button[data-kicks]',
    'button[class*="kicks"]',
  ],
  kicksBanner: [
    '[data-testid="kicks-banner"]',
    '[class*="kicks-banner"]',
    '[class*="kicks-promo"]',
    // Confirmed: Kicks overlay strip uses Tailwind class !z-[102] (no data-testid)
    // It is a persistent ticker above chat showing recent Kicks senders
    'div[class*="!z-[102]"]',
  ],
  // Kicks in chat has NO dedicated markup. Verified live 2026-08-16: Kick posts
  // it as an ordinary ChatMessageEvent from the official KickBot account
  // (user id 4377088), so the row is structurally identical to a user message.
  // The four selectors previously listed here (kicks-transaction / kicks-notice
  // variants) matched nothing on any channel and have been removed.
  // Detection lives in chatFilters._isKicksNotice: KickBot sender + text.
  // Kept as an empty list so a future native card can be added without a code
  // change — KS.Sel.matches([]) is simply false.
  kicksChatNotice: [],

  // Sender name Kick uses to announce Kicks in chat (case-insensitive compare)
  kicksBotUsername: 'KickBot',

  // Follows have NO native Kick notice — they are announced by chat bots, so a
  // follow "notice" is an ordinary message row with a username button. Matching
  // on text alone would hide a viewer typing "x just followed", so detection
  // also requires the sender to be a known bot.
  // KickBot is Kick's own (user id 4377088); the rest are common third-party
  // bots. Extend this list if a channel uses something else.
  knownChatBots: [
    'KickBot', 'Botrix', 'BotRix', 'StreamElements', 'Fossabot',
    'Nightbot', 'Moobot', 'Wizebot', 'sery_bot',
  ],

  // ── Native notice cards (sub / gifted sub / raid …) ──────────────────────
  // Confirmed live 2026-08-16 on jackdoherty + myrongainesx. Kick renders these
  // as a card with a coloured left accent bar; no data-testid anywhere on them.
  //   [data-index] > div.px-px                     → single-card notice (sub)
  //   [data-index] > div.flex.flex-col.gap-1 > …   → multi-card (gifted subs)
  // The card itself is the stable anchor; the svg[data-ds-icon] inside says
  // which kind it is. Do NOT use data-ds-icon alone — page chrome uses it too
  // (Menu, SearchOutline, VerifiedBadge …), so always scope to a notice card.
  noticeCard: [
    'div[class*="border-l-4"]',
  ],

  // Confirmed data-ds-icon values, notice cards only:
  //   Gift50        batch gifted-subs summary ("Gifted 50 subscriptions…")
  //   Gift          one gifted sub to one recipient
  //   SparkleFilled subscription / resub   (note: SparkleOutline is page chrome)
  noticeIcons: {
    giftedSubSummary: 'Gift50',
    giftedSubSingle:  'Gift',
    subscription:     'SparkleFilled',
  },

  // ── Top Gifters / Leaderboard ────────────────────────────────────────────
  // Confirmed: button[aria-label="Expand leaderboard"] and its parent div.
  // The leaderboard scrolls across the top of the chatroom.
  topGiftersPanel: [
    'button[aria-label="Expand leaderboard"]',
    'button[aria-label*="leaderboard"]',
    '[data-testid="gifters-leaderboard"]',
    '[class*="leaderboard-marquee"]',
    '[class*="animate-leaderboards"]',
    'img[src*="/img/gift-ranks/"]',
  ],

  // ── Gift animations / overlays ───────────────────────────────────────────
  giftAnimation: [
    '[data-testid="gift-animation"]',
    '[data-testid="subscription-animation"]',
    '[data-gift-animation]',
    '[class*="gift-animation"]',
    '[class*="GiftAnimation"]',
    '[class*="gift-overlay"]',
    '[class*="subscription-animation"]',
  ],

  // ── Polls ────────────────────────────────────────────────────────────────
  pollWidget: [
    '[data-testid="poll"]',
    '[data-testid="chat-poll"]',
    '[data-poll]',
    '[class*="poll-widget"]',
    '[class*="chat-poll"]',
    '[class*="stream-poll"]',
  ],

  // ── Predictions ──────────────────────────────────────────────────────────
  predictionWidget: [
    '[data-testid="prediction"]',
    '[data-testid="chat-prediction"]',
    '[data-prediction]',
    '[class*="prediction-widget"]',
    '[class*="stream-prediction"]',
  ],

  // ── Channel Goals ────────────────────────────────────────────────────────
  goalWidget: [
    '[data-testid="channel-goal"]',
    '[data-testid="stream-goal"]',
    '[data-goal]',
    '[class*="channel-goal"]',
    '[class*="stream-goal"]',
  ],

  // ── Suggested / Recommended channels (sidebar) ───────────────────────────
  // Confirmed: sidebar links use data-testid="sidebar-recommended-channel-N"
  suggestedChannels: [
    '[data-testid^="sidebar-recommended-channel-"]',
    '[data-testid="sidebar-recommended"]',
    '[data-suggested-channels]',
    '[class*="suggested-channels"]',
    '[class*="recommended-channels"]',
  ],
  // The "Show More" / "Show Less" row that sits under the recommended list.
  // Confirmed live 2026-08-16. Hiding only the channel rows leaves this behind
  // as an orphaned divider, so it must be hidden with them.
  //   <a  data-testid="sidebar-show-more-recommended-to-browse" href="/browse">
  //   <button data-testid="sidebar-show-less-recommended">
  // Both sit in a shared <div class="mx-3 flex items-center justify-between">,
  // which is what should actually be hidden (the divider lines live there too).
  // Prefix forms are listed after the exact ones to survive renames.
  suggestedChannelsControls: [
    '[data-testid="sidebar-show-more-recommended-to-browse"]',
    '[data-testid="sidebar-show-less-recommended"]',
    '[data-testid^="sidebar-show-more-recommended"]',
    '[data-testid^="sidebar-show-less-recommended"]',
  ],

  recommendedStreams: [
    '[data-testid^="sidebar-recommended-channel-"]',
    '[data-recommended-streams]',
    '[class*="recommended-streams"]',
    '[class*="suggested-streams"]',
  ],

  // ── Autoplay overlay ─────────────────────────────────────────────────────
  autoplayOverlay: [
    '[data-testid="autoplay-overlay"]',
    '[data-testid="up-next"]',
    '[data-autoplay-overlay]',
    '[class*="autoplay-overlay"]',
    '[class*="next-video"]',
    '[class*="up-next"]',
  ],

  // ── Ban notice box + unban request ──────────────────────────────────────
  // Confirmed DOM (2026-08-06): a single wrapper div contains both elements:
  //   <div class="flex flex-col gap-2 p-6">
  //     <div ...><input placeholder="You're banned from chat" disabled></div>
  //     <button dir="ltr">Request unban</button>
  //   </div>
  // Hiding the wrapper hides both. Uses CSS :has() (Chrome MV3 fully supports it).
  banNotice: [
    'div:has(> div > input[placeholder*="banned" i])',
    'div:has(input[placeholder="You\'re banned from chat"])',
    'div:has(input[placeholder*="banned" i])',
    '[data-testid="ban-notice"]',
    '[class*="ban-notice"]',
  ],
  // In practice banNotice targets the container that wraps both the input and
  // the unban button, so these are a safety net only.
  //
  // REMOVED 2026-08-16: 'button[dir="ltr"]:has(~ *)'. It matched ANY button
  // carrying dir="ltr" that had a following sibling — which is every sidebar
  // channel entry. Confirmed live: followed channels 1-4 were hidden as
  // "ban-notice" while the last one survived purely because it had no sibling
  // after it. findAll returns the first selector that matches anything, so this
  // also shadowed the two specific selectors below and they never ran.
  unbanRequest: [
    '[data-testid="unban-request"]',
    'button[aria-label*="unban" i]',
  ],

  // ── Chat input area (for button injection) ───────────────────────────────
  // Confirmed: div[data-testid="chat-input"] — Lexical rich-text editor
  chatInputArea: [
    '[data-testid="chat-input"]',
    '[data-lexical-editor="true"]',
    '.editor-input',
    '[class*="chat-input"]',
    'form[class*="chat"]',
  ],
};

// ── Utilities ────────────────────────────────────────────────────────────────

// Try selectors in order, return first match (or null)
KS.Sel.find = function (selectorList, root) {
  root = root || document;
  if (!Array.isArray(selectorList)) selectorList = [selectorList];
  for (const sel of selectorList) {
    try {
      const el = root.querySelector(sel);
      if (el) return el;
    } catch (_) { /* invalid selector — skip */ }
  }
  return null;
};

// Return all matches from the first selector that yields results
KS.Sel.findAll = function (selectorList, root) {
  root = root || document;
  if (!Array.isArray(selectorList)) selectorList = [selectorList];
  for (const sel of selectorList) {
    try {
      const els = Array.from(root.querySelectorAll(sel));
      if (els.length) return els;
    } catch (_) { }
  }
  return [];
};

// Check whether an element matches any selector in a list
KS.Sel.matches = function (el, selectorList) {
  if (!Array.isArray(selectorList)) selectorList = [selectorList];
  for (const sel of selectorList) {
    try { if (el.matches(sel)) return true; } catch (_) { }
  }
  return false;
};

// Find a heading-like element containing the given text (case-insensitive)
KS.Sel.findByHeadingText = function (text, root) {
  root = root || document;
  const tags = root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,div[role="heading"],button');
  const lower = text.toLowerCase();
  for (const el of tags) {
    if (!el.children.length && el.textContent.trim().toLowerCase().includes(lower)) return el;
  }
  return null;
};

// Walk up the DOM to find a panel-like ancestor
KS.Sel.findContainerPanel = function (el, maxDepth) {
  maxDepth = maxDepth || 8;
  if (!el) return null;
  let cur = el.parentElement;
  let depth = 0;
  while (cur && depth < maxDepth) {
    const tag = cur.tagName.toLowerCase();
    if (tag === 'aside' || tag === 'section' || tag === 'article') return cur;
    const cls = (cur.className && typeof cur.className === 'string') ? cur.className : '';
    if (/panel|widget|section|sidebar|container|leaderboard/i.test(cls)) return cur;
    const role = cur.getAttribute('role');
    if (role === 'region' || role === 'complementary') return cur;
    cur = cur.parentElement;
    depth++;
  }
  return null;
};

// Extract the current Kick channel from the URL (null on non-channel pages)
KS.Sel.getCurrentChannel = function () {
  const match = location.pathname.match(/^\/([^\/\?#]+)/);
  if (!match) return null;
  const slug = match[1].toLowerCase();
  const nonChannels = [
    'categories', 'clips', 'discover', 'following', 'subscriptions',
    'settings', 'en', 'search', 'trending', 'browse', 'help',
  ];
  return nonChannels.includes(slug) ? null : slug;
};
