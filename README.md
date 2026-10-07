# KickSanitizer

A Chrome extension for reading Kick.com chat: it filters out the noise, rebuilds
chat without the gaps, and lets you decide whose messages you see.

Made by **nedx**. Independent extension, not affiliated with or endorsed by Kick.com.

## Install

1. Download and unzip a release, or run `python build.py` to produce
   `dist/kicksanitizer-<version>/`
2. Open `chrome://extensions` and turn on **Developer mode**
3. Click **Load unpacked** and select that folder
4. Open any Kick channel. The broom icon appears next to the chat settings gear.

## Clean chat

Clean chat is **on by default**, and it is the point of the extension.

Kick renders chat as a virtualised list where every row sits at a precomputed
position. Hiding a message cannot close the space it occupied, so heavy
filtering leaves chat mostly gaps. Clean chat instead copies the messages that
survive filtering into a list of its own. Kick's chat is only read, never
changed.

- Usernames still open Kick's profile card.
- A **back to live chat** button appears when you scroll up, with a count of new
  messages.
- The counter above chat shows how many messages were filtered. Click it to see
  them, with the reason for each and a one-click way to turn that filter off.
- Scrollback holds 200 messages, from the time clean chat was on.

**Moderators:** delete, timeout, ban and pin do not work on clean-chat messages,
because copied messages carry none of Kick's handlers. Kick's own chat is one
click away in the bar above chat. The extension says so the first time it
notices you moderate.

## Filters

**Messages**

- Duplicates from the same user, within a window you choose (10 s to 1 hour)
- Emote-only messages, messages over N emotes, repeated emotes, or all emotes
  while keeping the text
- Global copypasta: the same message from several people at once
- Coordinated spam: many accounts each posting one crafted sentence at the same
  moment
- Bot commands (`!`), chat games such as `!fish` and the bot replies they cause
- All caps, repeated characters (`LLLLLL`, `xDxDxD`), links, and messages
  shorter than N characters
- Level-up announcements, channel point redemptions
- Gifted-sub, sub and follow notices, with gift batches collapsible to one line
- Kicks notices below an amount you choose; the Kicks strip above chat can be
  hidden, or hidden once read
- **Mizkif mode:** emotes only, anything with words in it is hidden

Messages that mention you are never filtered.

**The page around chat:** the Kicks widget and balance, Top Gifters, gift
animations, channel points, pinned messages, polls and predictions, goals,
suggested channels (all of them, or ones you dismiss individually), recommended
streams, autoplay overlays, notification pop-ups and the ban notice.

## People and recipes

- **Like or dislike someone** from their profile card. Liked people are
  highlighted and never filtered; disliked people are hidden. Unlike Kick's
  mute, the lists can be exported and sync between your browsers.
- **Mark bots** whose messages you never want to see.
- **Recipes** hide or highlight messages by what they start with, end with or
  contain, either for one account or for anyone (`*`). A recipe for NedBot ships
  built in, sorted by its jobs: raids, bans, polls, racing, points, cards and
  lookups, each switchable on its own. Recipes can be shared as text and
  imported.
- **Shared bot lists:** pull known bots from a list server, and optionally
  report one. One server comes listed but switched off, and nothing is
  contacted until you turn it on.

## Appearance

Sixteen chat themes, switchable from the bar above chat.

- **Plain:** Normal, Minimal, High Contrast, Colour-blind safe and Typewriter.
  Colour-blind safe gives every chatter a stable colour from a palette that stays
  distinguishable under common colour vision deficiencies.
- **Styled:** Terminal, CRT Amber, Synthwave, Diablo, Clown, Fabulous, Gross,
  Psychedelic, Hypnotoad, 8-bit and Tube.

Badges can be hidden by kind: level badges, all non-moderator badges, or
moderator badges. Timestamps can be forced on. Purely for fun, the sidebar can
say LAME instead of LIVE, and the Kick logo can have its BETA tag back.

## Conveniences

- Restore focus to the chat box after slow-mode cooldown, so typing does not
  hit the player's keyboard shortcuts (on by default)

Off by default:

- Show real viewer counts in the sidebar instead of "LIVE"
- Auto-dismiss the "Congratulations!" popup when someone gifts you a sub
- Auto-accept a channel's chat rules
- Auto-claim the daily reward

## Settings

Settings are **global** by default. The Scope tab can switch to *this channel
only*, which stores an override for the channel you are viewing. Everything else
falls through to your global settings. The same tab shows what has been hidden,
broken down by reason, for this channel and across all channels.

Settings, lists and recipes can be exported to a file and imported. Lists also
travel through Chrome Sync if you have it on; that can be switched off on its
own.

## Privacy

No account, no analytics, no tracking. The extension talks to:

- **Kick itself:** a channel lookup to find its chatroom, and, only if you turn
  them on, viewer counts for live sidebar channels and avatars for the Tube
  theme.
- **Kick's chat service** (`ws-us2.pusher.com`, which the Kick page also uses):
  a receive-only connection while clean chat is on. It is how the extension
  learns that a message was deleted or a user banned, because the page carries
  no message id. Nothing is sent on it.
- **A shared bot list server**, only if you switch one on and grant Chrome's
  permission for that host. Pulling sends nothing but the request; reporting
  sends the username you report.

Settings and lists live in `chrome.storage` and leave your browser only through
Chrome's own sync. Permissions: `storage`, `kick.com`, and optional access to a
host you add. The extension does not run on `dashboard.kick.com`.

## Development

No build step, plain JS. `python build.py [--bump patch|minor|major]` produces
an unpacked folder and a store-ready zip from an explicit allowlist of files.
While developing, reload the **Kick tab** after changing a file; after changing
`manifest.json` or `background.js`, reload at `chrome://extensions` as well.

[DEVELOPMENT.md](DEVELOPMENT.md) documents Kick's DOM and socket behaviour: how
the virtualiser works, which selectors are confirmed, what the socket carries.
Read it before changing selectors. Several filters have shipped broken because
a plausible `data-testid` was guessed rather than verified.

## Licence

MIT. See [LICENSE](LICENSE).
