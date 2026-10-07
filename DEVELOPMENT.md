# KickSanitizer — development notes

Chrome MV3 extension that filters Kick.com chat and hides page clutter.
No build step — plain JS, loaded unpacked.

Everything below was verified against live Kick on **2026-08-16** unless marked
otherwise. Raw captures: [`captures/confirmed/kicks-and-gift-notices-2026-08-16.md`](captures/confirmed/kicks-and-gift-notices-2026-08-16.md).

## Reloading — read this first

Several debugging rounds were wasted on output from stale code.

| changed | needed |
|---|---|
| content script, CSS, `filters/*`, `utils/*` | **reload the Kick tab** |
| `manifest.json`, `background.js`, new files | reload at `chrome://extensions` **and** the tab |

Reloading the extension does **not** replace content scripts already running in
open tabs. An orphaned script keeps running with `chrome.runtime.id` undefined,
so every `chrome.*` call throws "Extension context invalidated" — that error in
the console means the tab needs reloading, not that the code is wrong.
DevTools shows the file from disk, not what is executing.

Tests: `python -m http.server` over the folder, open `tests/test.html`
(a `kicksanitizer-tests` entry exists in `F:\Development\.claude\launch.json`,
port 7788). 81 tests, no framework.

## The selector trap — the dominant bug class here

`KS.Sel.findAll` returns the results of the **first selector that matches
anything**. An over-broad entry therefore does not merely add false positives —
it *shadows every selector below it*. Three separate bugs today were this shape:

- `unbanRequest[0] = 'button[dir="ltr"]:has(~ *)'` matched every sidebar channel
  entry with a following sibling, hiding all but the last followed channel as
  `ban-notice`. It carried a comment admitting it was too generic.
- `KS.Sel.chatMessage.join(',')` in `handleAddedNode` turned an ordered fallback
  chain into a union, so `.group` matched Kick's mod-toolbar buttons and they
  were filtered and mirrored as if they were messages.
- `kicksChatNotice` was four plausible-looking selectors
  (`kicks-transaction`, `kicks-notice`, …) that matched **nothing on any
  channel**, and `_collapseGiftedSubs` looked for `rgb(192, 112, 255)`, a colour
  Kick does not use.

None of these failed loudly. Before trusting any selector, count matches on a
live page. Never join the list with commas; iterate it in order.

Three more, found 2026-10-07 by watching a live page rather than reading code:

- **A Tailwind class renamed under us.** The sidebar live badge was
  `.bg-green-500 + span`; Kick renamed the dot to `bg-kick-voltGreen-150`. LAME
  and the forced viewer counts both matched nothing — switched on, doing
  nothing, no error. Now `KS.Sel.sidebarLiveBadge`, matched by structure (the
  dot is an empty `div`). Prefer structure and `data-testid` to colour classes.
- **A selector matching the definer as well as the user of a CSS variable.**
  `[style*="chatroom-timestamps-display"]` was meant for the timestamp spans
  (`display: var(--chatroom-timestamps-display)`) but also matched `<html>` and
  `#ks-mirror`, which *define* the variable. The forced `display: inline` turned
  the mirror from a flex column into a block: rows stacked from the top instead
  of the bottom, and every theme's `gap` silently stopped applying. Match
  `var(--…` to get only consumers.
- **A shape that is not unique to what you mean.** `kicksPill` (an avatar plus
  a `span[title]` holding a number) also describes every sidebar channel entry —
  avatar, viewer count in `title`. With a threshold set it hid followed channels.
  Now scoped to `#channel-chatroom`, so a future layout change fails to match
  rather than hiding the wrong thing.

`ksDebug.health` counts what each Kick-dependent selector finds. On a live
channel page every value except `kicksPills` should be above zero; a `0` is the
first sign Kick changed something. Read it before debugging a feature that
"does nothing".

## Kick DOM facts

**Chat is virtualised.** Every row is
`<div data-index="N" class="absolute inset-x-0 top-0" style="transform: translateY(9400px)">`.

- DOM order ≠ visual order. Recycled rows are reinserted anywhere. Order by
  `data-index`, never by walk order.
- Rows are **destroyed and re-created**, not reused in place, so marking an
  element (`dataset.x = 1`) cannot dedupe — key on message identity instead
  (`username|time|text`).
- **Hiding a row cannot close its gap.** Verified: `display:none` on the row, on
  its parent, and a zero-height collapsed box all leave following rows at
  `dy = 0`, because siblings are absolutely positioned at precomputed offsets
  and the container height is set explicitly. Gaps are unavoidable when
  filtering in place; that is why clean chat mode exists.
- A `display:none` chat container has `clientHeight` 0, so the virtualiser
  renders **nothing**. To hide Kick's list while keeping it producing rows, use
  `opacity: 0` — not `display: none`.

**Stacking**: Kick's chat footer is `z-common` with `z-index: 1` on a
`position: static` element, which is inert. Kick relies on DOM order around the
chat column, so adding any `z-index` to our overlays jumps them above Kick's own
settings popover. Don't set one.

**Clipping**: the footer is `overflow: hidden` (340×134). Anything anchored
inside it and larger gets cut — the in-page panel is `position: fixed`,
positioned from the button's rect, for this reason.

**Confirmed selectors** (rest of `kickSelectors.js` is unverified):

```
#chatroom-messages / [data-testid="chatroom-messages"]   chat container
[data-index] > div                                        message row
button[data-prevent-expand="true"]                        username (messages only)
span.font-normal                                          message text
span[data-emote-id][data-emote-name]                      emote
[data-testid^="identity-badge-"]                          badge
[data-testid="chat-input"]                                Lexical editor
[data-testid^="sidebar-following-channel-"]               followed channel
[data-testid^="sidebar-recommended-channel-"]             recommended channel
[data-testid="sidebar-show-more-recommended-to-browse"]   recommended controls
[data-testid="sidebar-show-less-recommended"]             (only when sidebar expanded)
```

`data-ds-icon` is Kick's design-system icon attribute and appears **everywhere**
(`Menu`, `SearchOutline`, `VerifiedBadge`…). It is not a discriminator on its
own — always scope it to a notice card first, and match exact values
(`SparkleFilled` is a sub notice; `SparkleOutline` is page chrome).

## Notices

Native notice cards share one shape: `border-l-4 bg-surface-base p-4 rounded-r`
with a coloured accent and an icon. **No `data-testid` anywhere on them.**

| kind | `data-ds-icon` | accent | structure |
|---|---|---|---|
| gifted subs summary | `Gift50` | `rgb(255,196,102)` amber | `[data-index] > div.flex.flex-col.gap-1` holding a summary card **plus one card per recipient** |
| gifted sub (single) | `Gift` | amber | one card in that group |
| subscription | `SparkleFilled` | `rgb(83,252,24)` green | `[data-index] > div.px-px` — single card, no wrapper |

**Kicks has no native notice.** Kick posts it as an ordinary `ChatMessageEvent`
from the official **KickBot** account (user id `4377088`), so the row is
structurally identical to any user message. Detect by sender, not markup.

**Follows have no native notice either** — chat bots announce them, so the row
is again an ordinary message. Any rule requiring "no username element" is
therefore dead code for both Kicks and follows; that is exactly what silently
disabled `chat_kicksMinAmount` and `chat_hideFollowNotices`.

**Deleted messages**: moderators see the row re-rendered struck through with
"(Deleted)" rather than removed. Non-mods presumably just lose the row —
*unverified*. The re-render is a new element with changed text, so it bypasses
dedupe and duplicates unless handled (`_isDeletedRender` / `_applyDeletion`).

**Bans — two different things, don't conflate them:**

- *Someone else being banned* is *not rendered in chat* for a normal viewer.
  Mods get a DOM signal; everyone gets `UserBannedEvent` on the socket. So ban
  handling must be socket-driven (`Mirror._onBanned` removes rows by username),
  exactly like deletions.
- *You being banned* IS in the DOM: a disabled `input[placeholder*="banned"]`
  with a "Request unban" button. That is what the `banNotice` / `unbanRequest`
  selectors and `page_hideBanNotice` are for — your own ban state, not an event.

## Socket

Kick uses Pusher. App key `32cbd69e4b950bf97679`, cluster `us2`.

| channel | carries |
|---|---|
| `chatrooms.{chatroom_id}.v2` | `ChatMessageEvent`, `MessageDeletedEvent`, `UserBannedEvent`, `UserUnbannedEvent`, `ChatroomClearEvent`, polls, pins |
| `channel_{channel_id}` — **underscore** | `KicksGifted`, `KicksLeaderboardUpdated` |

The underscore form matters: subscribing to `channel.{id}` (dot) receives
nothing for Kicks. Note also that Kicks event names carry **no `App\Events\`
prefix**, unlike chat events. Pusher ACKs a subscription to any channel name, so
`subscription_succeeded` is not evidence a channel exists — only traffic is.

Resolve ids with `/api/v2/channels/{slug}` **from the page** (same-origin, so it
passes Cloudflare where a background fetch would not).

Payloads:

```jsonc
// KicksGifted
{ "gift_transaction_id": "…", "sender": { "id": 100000001, "username": "…" },
  "gift": { "gift_id": "hype", "name": "Hype", "amount": 10, "tier": "BASIC" } }

// MessageDeletedEvent — the NESTED id is the message; the outer one is the event
{ "id": "…", "message": { "id": "e7887041-…" },
  "aiModerated": false, "violatedRules": [] }

// UserBannedEvent
{ "user": { "username": "…" }, "banned_by": { "username": "…" },
  "permanent": false, "duration": 5, "expires_at": "2026-08-16T04:58:11+00:00" }
```

`MessageDeletedEvent` identifies its target **by id only** — no username, no
text. The DOM carries no message id anywhere, which is the one thing that
genuinely forces a socket tap. The socket also beats the rendered row by
**~440 ms**, so an id is already buffered when the row paints.

`chatSocket.js` connects while clean chat mode is on — which is now the
**default**, so the socket connects by default. It is receive-only, but it is a connection to
`ws-us2.pusher.com` — a non-Kick origin — so the README's "no data leaves your
browser" wording needs care.

## Architecture

```
Kick renders → MutationObserver → chatFilters.processMessage
                                    ├─ hide in place (data-ks-hidden)   normal mode
                                    └─ survivors → Mirror.ingest        clean chat mode
```

- `stats.js` counts every hide by reason, per channel and site-wide, batched to
  `chrome.storage.local` (bursts + rate limits). Shown in the popup's Scope tab.
- `mirror.js` clones surviving rows into `#ks-mirror` in normal flow. Clones keep
  emotes, badges, timestamps, reply previews and CDN images; they lose React
  handlers, so username clicks are forwarded to the original node **by label,
  never by index** — index mapping pointed username clicks at delete/ban buttons
  once icon-only controls were stripped from clones.
- The mirror is a copy of what Kick *rendered*. It is not a log: anything
  scrolled off before it was enabled never appears.

## Gotchas

- `ChatFilters.restoreAll()` must be scoped to the chat container. Page filters
  use the same `data-ks-hidden` attribute, so an unscoped query un-hid the
  leaderboard and suggested channels on every settings change.
- Re-scanning re-stamps state. `data-ks-seen` is set **once**; `_isDuplicate`
  measures its window from that, not `Date.now()`. Otherwise a re-scan treats
  the whole buffer as simultaneous, every repeat matches, and the chat empties.
- A bulk scan must not retro-hide backlog as duplicates — arrival times for
  history are unknowable.
- Anything injected into Kick's chat column (broom, mode bar) is destroyed by
  React re-renders. `content.js` re-injects on a 2s watchdog.
- Emote-only messages normalise to `''`. Without an empty-text guard every one
  of them counts as a duplicate of the last.
- Badge `<img>` elements sit inside a `<div data-state="closed">` wrapper. Hiding
  the img alone leaves an empty flex child that still takes a `gap` slot, so a
  stray space appears before the username. Hide the wrapper via
  `div:has(> img[...])`.
- Level badges are identified by `alt="Level N"`, **not** by the `/chat/badges/`
  src path — that path may serve other badge types, and over-hiding a subscriber
  or moderator badge destroys information the reader needs. Fail open here.

### Muted users — unresolved

Kick's mute list is in **localStorage under `silencedUsers`** (confirmed live).

An earlier sweep concluded it was server-side. That was wrong: the sweep searched
localStorage *values* for known muted usernames and matched nothing, which means
`silencedUsers` stores IDs rather than names. Search by key, not by expected
content. Its exact shape is not yet read.

Related: the logged-in user's own identity is NOT available from `/api/v1/user`
— that returns `{}`. It is on the header avatar's `alt`, and also embedded as
`"username":"..."` inside several unrelated localStorage entries.

What is not yet established is whether Kick drops a muted user's message before
render or renders the row and hides it. The mirror clones DOM rows, so the second
case would put a muted user back on screen. `Mirror._isSuppressedByKick()` guards
against it by skipping any row whose computed `display`/`visibility`/`opacity`
says it is not being shown — correct under either behaviour, a no-op under the
first.

To settle it: mute someone who is **actively talking**, then check whether their
rows still exist in `[data-index]`. A probe against idle muted users proves
nothing — they simply may not have spoken. If rows do survive with
`display: none`, the guard is load-bearing and it becomes worth finding the
endpoint behind the Muted Users panel so the mirror can filter by username
directly rather than depending on Kick's CSS staying the same.

## Recipes — the shared format

`utils/botRecipes.js`. A recipe hides or highlights messages by category — some
of a bot's jobs rather than the whole bot, or a word from anyone. Recipes are
user data in `chrome.storage.local` under `botRecipes`; NedBot's ships as the
default. Users share them as text, so **this format is a public contract** —
changing it breaks recipes people have already posted. Add fields; do not
rename or repurpose them. A breaking change needs `kickSanitizerRecipe: 2` and
a reader for 1.

```json
{
  "kickSanitizerRecipe": 1,
  "name": "NedBot",
  "channels": ["nedx"],
  "rules": [
    { "label": "Raids", "account": "nedbot", "start": ["🚀"], "on": true },
    { "label": "Pokémon cards", "account": "nedbot", "start": ["🃏"], "end": ["🃏", "📿"] },
    { "label": "Race results", "account": "nedbot", "contains": ["wins the race"], "action": "highlight", "on": true },
    { "label": "Spoilers", "account": "*", "contains": ["ending spoiler"], "on": true }
  ]
}
```

- `channels` empty or absent = every channel.
- `account` is one Kick username, or `*` for anyone. To highlight everything a
  person says, Like them instead — a rule needs something to match, by design.
- `action` is `hide` (the default when absent) or `highlight`. Hide and
  highlight rules are evaluated separately; a message matching both is hidden.
- A rule matches if ANY of `start` / `end` / `contains` matches; `contains` is
  case-insensitive. U+FE0F is ignored on both sides, so 🗳 and 🗳️ are one marker.
- `on` must be literally `true`. **Readers also accept `hide: true`** — the
  switch's name while hiding was the only action, and it shipped in b321612.
  Writers emit `on`. A shared recipe's switches are the sharer's suggestion;
  the importer can change them.
- Everything pasted goes through `KS.BotRecipes.parse`: size and count limits,
  account/channel patterns, empty markers dropped (an empty marker would match
  every message). The popup renders every field with `textContent`.
- Settings import runs `botRecipes` through the same normaliser — it is the one
  structured value the filter walks on every message.

The NedBot defaults come from measuring its output, not from its source: 400
messages, 2026-10-06/07. `end` markers are used only where the data shows they
are exclusive — 🃏/📿 end only Pokémon messages, while the racing promos end in
👑 🏆 🎰 as decoration.

## Liked and disliked people

`likedChatters` (highlighted, never filtered — the pass a mention gets) and
`ignoredChatters` (every message hidden), both LOCAL. Set from 👍/👎 on Kick's
user card (`filters/personCard.js`), from the filtered-messages panel, or typed
into the popup.

- On the card, not on rows. Buttons on every message were tried first and
  covered the end of the text; the card is where Kick puts per-person actions.
  The card is `#user-identity`; the person is read from its profile link
  (`<a title="name" href="https://kick.com/name">`), the one stable identity on
  it. Other tools inject there too — a nedbot overlay sits above Kick's part as
  `#nb-card` — so ours goes inside Kick's part and touches nothing else.

- Kick's own mute lives in this browser's localStorage only. These lists are
  the portable version: they go through settings export and import.
- Deliberately NOT the marked-bots list. A marked bot can be reported to a
  shared list; a disliked person's name must never leave the browser.
- A dislike outranks a mention — like Kick's mute, you asked not to see them.
- The lists are mutually exclusive. `_setPerson` writes into the in-memory
  settings at once rather than waiting for storage to echo back, so the row
  update, the next message, and a quick second click all see the new state.

Settings import used to accept only sync keys plus `channelOverrides`, so marked
bots, recipes and these lists were exported but silently dropped on import.
Import now takes every LOCAL list and validates each — names against the
username pattern, recipes through the recipe normaliser — because an export is
a file anyone can hand you.

## List sync — `utils/listSync.js`

The lists are LOCAL (sync allows 8 KB per item, 100 KB total). The service
worker copies them into `chrome.storage.sync` as `ks.sync.<key>` (header:
pieces, time, hash) plus `ks.sync.<key>.<i>` (pieces measured after
JSON-encoding, ≤ 7000 bytes each), and pulls other browsers' changes back.
Local stays the source of truth; nothing outside the worker knows sync exists.

- Echo prevention: `ksSyncState` (local) remembers the hash last synced; a push
  of matching content is skipped. Without it two browsers loop forever.
- First contact merges (names union; recipes union by name, this browser's copy
  kept on a clash) instead of overwriting. After that, newer wins.
- Pieces can land separately; a pull whose pieces do not hash to the header
  waits for the next change rather than writing half a list.
- Synced data is validated like an import — it is the user's own, but nothing
  stops a broken client or a hand edit writing nonsense.
- Liked vs disliked conflicts across browsers resolve to disliked.
- `ks.sync.*` keys are stripped wherever settings are read from sync, or they
  would end up in the settings object and every export.
- `tests/listSync.test.js` runs the real files as two simulated browsers on
  one sync store with Chrome's per-item quota enforced.

## Bot list sources — what a server has to serve

No server exists yet. `bots.nedbot.site` ships as a preset with both flags off;
it is a suggestion, not a connection.

Two endpoints, both plain JSON. No CORS headers needed: the fetches run in the
service worker, not the content script, so page-origin CORS does not apply.

### `GET /bots.json`

Optional `?since=YYYY-MM-DD`. Absent means "send everything".

```json
{
  "through": "2026-08-17",
  "bots": [
    { "username": "spammer1", "added": "2026-08-01" },
    { "username": "spammer2", "added": "2026-08-14" }
  ],
  "removed": ["namecleared"]
}
```

A bare array is also accepted, and entries may be plain strings — a source with
no dates works, it just cannot be fetched incrementally.

Details that matter:

- **`through` is the server's own date**, echoed back as `since` on the next
  pull. Sending the server's value rather than ours avoids clock skew: the
  client's idea of today may not match, and an incremental feed keyed on the
  wrong date silently skips entries.
- **`removed` is the only way a name comes off** an incremental feed. Without
  it a source could add for ever and never retract, and someone wrongly listed
  would be stuck.
- **A full response replaces that source's contribution**; an incremental one
  is layered onto it. Each source's names are tracked separately so one going
  away removes only its own entries.
- **A failed pull keeps the last known names.** A server being down must not
  empty the list.
- Capped at 5000 names per source, 10 sources.

### `POST /report`

```json
{ "username": "spammer1" }
```

That is the whole payload — no message text, no channel, no identity of the
reporter. Any 2xx counts as accepted.

**A report is a report, not an entry.** What reaches `bots.json` is the
server's decision. A list that publishes reports directly is a harassment
tool: anyone could make anyone invisible to every install. Whatever stands
this up needs a threshold of distinct reporters, a moderation step, and a way
to get removed.
