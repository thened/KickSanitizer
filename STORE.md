# Chrome Web Store submission

Working notes and ready-to-paste copy. Not shipped in the zip (see `DEV_ONLY`
in `build.py`).

---

## 1. The name

Chrome Web Store policy prohibits listings that imply affiliation with another
brand. Any name containing "Kick" alongside a `kick.com` host permission is the
shape reviewers flag, and it was the most likely rejection reason here.

**Decision: "Matcha".** Green tea as a nod to Kick being the green one, with no
brand name in the title at all — so the affiliation question never arises rather
than being argued down. It also survives Kick rebranding, or the extension being
pointed somewhere else later.

Spelling: **Matcha**, not Macha. It is the standard transliteration and the one
people actually type.

The cost is discoverability — nobody searches "Matcha" looking for a chat
filter. That is handled in the listing rather than the name: the Store indexes
the description, so "Kick" appears in the first line of the short description
and again in the first sentence of the long one. Descriptive use of a brand to
say what a product works with is permitted; using it as your own name is not.

Worth doing before committing to it: search the Web Store for existing
extensions called Matcha. A clash is not fatal but is worth knowing about.

The GitHub repo should be renamed too, not just the extension. The listing
links the source, and linking it is worth doing — open source helps review. A
reviewer following that link to a repo still called "KickSanitizer" sees the
brand name that was just removed from the title, which reads as an attempt to
route around them. GitHub redirects the old URL indefinitely, so nothing
breaks; only the local `git remote set-url` needs updating.

Renaming touches more than the manifest — repo name, README, the `KS`/
`KickSanitizer` identifiers in code, the built zip name, and the icon, which
would want to be green tea rather than a broom. The internal `KS.*` namespace
can stay; it is not user-visible.

## 2. Listing copy

### Short description (132 char limit — this is `description` in manifest.json)

```
Filter Kick chat: hide spam, duplicates, emote walls and bot games, or read a clean rebuilt chat with themes.
```

*109 characters.*

### Detailed description

```
Kick chat moves fast and most of it is noise. Matcha filters it down to the messages
you actually came for.

WHAT IT FILTERS

• Duplicate and repeated messages, with a configurable time window
• Emote-only messages, emote walls, and repeated emotes within a message
• Copypasta — the same message posted by many people at once
• Bot commands, bot replies, and chat games (!fish and friends)
• ALL CAPS, keyboard mashing, and links
• Very short messages, below a length you choose
• Kicks notices below an amount you choose
• Gifted-sub, subscription and follow notices

Messages that @-mention you are never filtered, whatever else they would trip.

CLEAN CHAT MODE

Kick's chat is a virtualised list: hiding a message leaves a gap that cannot be
closed. So instead of cutting holes in their chat, Matcha rebuilds the
surviving messages in a list of its own. Kick's chat is never modified — it is
only read.

Clean chat keeps emotes, badges, timestamps, replies and reply previews, and
clicking a username still opens Kick's profile card.

APPEARANCE

Seven themes, switchable from a bar above chat: Normal, Clown, Terminal,
CRT Amber, Typewriter, High Contrast and Minimal. Badges can be hidden by kind
— level badges, all non-moderator badges, or moderator badges.

PAGE CLEANUP

Hide the Kicks widget, top gifters, gift animations, polls and predictions,
channel goals, pinned messages, suggested channels and recommended streams.
Individual suggested channels can be dismissed permanently.

PRIVACY

No account required. No analytics. No tracking. No data is sent anywhere.
Your settings are stored by Chrome and never leave your browser except through
Chrome's own sync, if you have it enabled.

Runs only on kick.com. Does not run on dashboard.kick.com.

Open source: https://github.com/thened/matcha

Not affiliated with, endorsed by, or connected to Kick.com. "Kick" is used only
to describe what this extension works with.
```

### Category

Social & Communication.

### Single-purpose statement

```
Filtering and decluttering chat and page elements on kick.com, so the user can
read chat without spam, duplicates and promotional widgets.
```

---

## 3. Permission justifications

Each of these has to be filled in on the submission form.

### `storage`

```
Stores the user's own filter settings and per-channel overrides so they persist
between sessions. Nothing else is stored, and nothing is transmitted.
```

### Host permission `*://*.kick.com/*`

```
The extension reads and filters chat messages and page widgets on kick.com.
This is the only site it runs on, and it cannot function without access to the
page it filters. dashboard.kick.com is explicitly excluded.
```

### Remote code

```
None. Every script is included in the package. No code is fetched or evaluated
at runtime.
```

---

## 4. Privacy disclosures

Every data-collection category on the form is **No**. Verified by audit, not
assumption — the entire codebase makes exactly two outbound calls:

| Call | Where | Why |
|---|---|---|
| `fetch('/api/v2/channels/<slug>')` | kick.com, same origin | Reads the chatroom id needed to subscribe to the chat feed |
| `new WebSocket(...pusher...)` | Kick's own realtime service | Read-only chat feed, used for deletions and bans; connects only while clean chat is on |

Both are requests the Kick page itself already makes, using the user's own
session. Neither sends anything to a server operated by this extension — there
is no such server.

Certifications to accept:
- Not being sold to third parties
- Not being used or transferred for purposes unrelated to the single purpose
- Not being used to determine creditworthiness or for lending

A privacy policy URL is required once any disclosure is made. Since everything
is "No", the README's privacy section can serve, or link the repo directly.

---

## 5. Screenshots

Required: 1–5 images at **1280×800** (or 640×400). These need a real Kick
channel with busy chat, so they have to be captured manually.

Shot list, in the order they should appear:

1. **Side by side** — Kick's raw chat next to clean chat on the same channel.
   This is the whole pitch in one image.
2. **The popup**, Chat tab, showing the filter list.
3. **A theme** — Terminal or CRT Amber reads most distinctly at thumbnail size.
4. **The mode bar** with the filtered-count odometer showing a non-trivial number.
5. **Page cleanup** — sidebar and widgets before/after.

Also needed: a 440×280 small promo tile. The 128px icon already exists.

---

## 6. Before submitting

- [ ] Rename to Matcha (§1): `manifest.json`, README, repo, icon
- [ ] Bump version — `python build.py --bump minor`
- [ ] `python build.py`, then **load `dist/kicksanitizer-<version>/` unpacked and
      click through it**. Source and package are not the same thing: the popup
      logo pointed at an SVG the package deliberately excludes, and that shipped
      unnoticed because testing always happened from source.
- [ ] Confirm the two account-acting features (`page_autoAcceptChatRules`,
      `page_autoClaimRewards`) still default to off. They automate clicks in the
      user's account and will draw reviewer attention; defaulting off is the
      justification.
- [ ] Capture screenshots (§5)
- [ ] $5 one-time developer registration fee

## Known-unverified at time of writing

Worth clearing before a public release, since fixes go through review latency
once listed:

- Mentions have never been observed firing in real use
- Muted users — see the unresolved section in `DEVELOPMENT.md`
- Auto-claim across a daily rollover
- Socket-driven deletion/ban removal in the mirror
