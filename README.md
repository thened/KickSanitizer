# KickSanitizer

A Chrome extension that cleans up Kick.com chat — hides the noise, keeps what you
came for.

Made by **nedx**. Independent extension, not affiliated with or endorsed by Kick.com.

## Install

**From a release folder**

1. Download and unzip a release, or run `python build.py` to produce
   `dist/kicksanitizer-<version>/`
2. Open `chrome://extensions` → enable **Developer mode**
3. **Load unpacked** → select that folder
4. Open any Kick channel — the broom icon appears next to the chat settings gear

Changed a file while developing? Reload the **Kick tab**. Changed `manifest.json`
or `background.js`? Reload at `chrome://extensions` **and** the tab.

## Clean chat

Clean chat is **on by default**, and it is the point of the extension.

Kick renders chat as a virtualised list where every row is absolutely positioned
at a precomputed offset. Hiding a message therefore cannot close the space it
occupied — you get a hole exactly the height of the message you filtered. Filter
heavily and the chat becomes mostly gaps.

So instead of subtracting from Kick's list, clean chat copies the messages that
survive filtering into a list of its own, in normal flow. Nothing is left behind
because nothing was removed — the filtered messages were simply never copied.

Kick's own chat is one click away in the bar above the chat, and switching back
is how you moderate: **delete, timeout, ban and pin do not work on clean-chat
messages**, because copied messages carry no event handlers. If you moderate a
channel the extension tells you this the first time it notices.

Trade-offs worth knowing:

- Scrollback is capped at 200 messages, and only covers what arrived while clean
  chat was on. Kick's own list keeps more.
- Clicking a username still opens Kick's profile card.
- Everything else on the page is untouched.

## Filters

**Chat** — things people typed

| filter | default |
|---|---|
| Hide duplicates from the same user | On |
| Hide emote-only messages | On |
| Hide repeated emotes within a message | Off |
| Hide all emotes, keep the text | Off |
| Hide messages over N emotes | Off |
| Hide messages shorter than N characters | Off |
| Hide chat games (`!fish` and the bot replies) | Off |
| Collapse global copypasta | Off |
| Hide bot commands, all-caps, repeated characters, links | Off |
| Hide or collapse gifted-sub, sub and follow notices | Off |
| Hide Kicks notices below N Kicks | Off |
| Keep messages deleted by moderators | Off |
| Force timestamps on | Off |

**Page** — Kick's furniture around the chat

Kicks widget and ticker · Top Gifters leaderboard · gift animations · suggested
channels · recommended streams · pinned messages · polls and predictions · goals
· autoplay overlay · the "you're banned" panel · auto-accept chat rules (off by
default — it agrees to a channel's rules on your behalf).

## Settings scope

Settings are **global** by default. The Scope tab lets you switch to *this
channel only*, which stores an override for the channel you are viewing;
everything else still falls through to your global settings. The channel bar
shows which of the two you are looking at.

*This session only* is not implemented yet — it currently behaves as global.

## Statistics

The Scope tab shows what has actually been hidden, broken down by reason, for
the current channel and across all channels.

## Privacy

- **No data is ever sent anywhere.** No analytics, no tracking, no servers.
- Settings live in `chrome.storage`; per-channel overrides and counters are local.
- Permissions: `storage`, and host access to `*://*.kick.com/*`.
- **One outbound connection:** while clean chat is on, the extension keeps a
  **receive-only** WebSocket to Kick's chat service (`ws-us2.pusher.com`) — the
  same service the Kick page itself uses. It is how the extension learns that a
  message was deleted or a user banned, because Kick does not put a message id
  anywhere in the page, and does not show a normal viewer that someone else was
  banned. Nothing is transmitted on it.
- The extension does not run on `dashboard.kick.com`.

## Development

No build step — plain JS. `python build.py [--bump patch|minor|major]` produces
an unpacked folder and a store-ready zip from an explicit allowlist of files.

The test harness and DOM capture tools are kept out of this repo — they are
development-only and never part of a release.

`CLAUDE.md` documents Kick's DOM and socket behaviour — how the virtualiser
behaves, which selectors are confirmed, what the socket carries. Read it before
changing selectors; several filters have shipped broken because a plausible
`data-testid` was guessed rather than verified.

## Licence

MIT — see [LICENSE](LICENSE).
