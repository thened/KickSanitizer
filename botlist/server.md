# bots.nedbot.site

The shared bot list KickSanitizer pulls from. Does not exist yet — as of
2026-08-17 the subdomain has no DNS record, while `nedbot.site` itself resolves
and serves a static page.

## What it has to do

Two endpoints. No CORS headers required: the extension fetches from its service
worker, not from the page, so page-origin CORS does not apply.

### `GET /bots.json`

`bots.json` in this folder is the seed. Serve it as-is to start with.

Optional `?since=YYYY-MM-DD`. Ignoring the parameter is fine — the client
handles a full list every time, it just transfers more. When it IS honoured,
return only entries added or removed since that date, and set `through` to the
date the response is current to.

The client sends back whatever `through` it last received, so the two never
drift: our clock is never used to decide what to ask for.

`removed` is the only way a name leaves an incremental feed. Without it a list
can add forever and never retract, and anyone wrongly on it is stuck.

### `POST /report`

```json
{ "username": "someone" }
```

That is the entire payload — no message text, no channel, nothing identifying
who reported it. Return any 2xx to accept.

## The part that needs care

**A report must not become an entry on its own.** Publishing reports directly
turns this into a harassment tool: anyone could mass-report an account and make
it invisible to every install. Before a name reaches `bots.json` it needs, at
minimum:

- a threshold of distinct reporters
- a human look at anything crossing it
- a documented way to be removed

Until that exists, `POST /report` can accept and queue without anything being
published. The extension does not assume otherwise — it treats a report as a
report.

## Seeding

The seed is deliberately only well-known automated chat services — the same
accounts already bundled in `kickSelectors.js` as `knownChatBots`. Those are
bots by design and by their own description.

Individual accounts *suspected* of being spam bots are deliberately NOT here,
including the ones observed during development. One person's observation of a
few messages is not evidence, and a shared list is exactly where a wrong guess
does the most damage.

## Hosting

Unresolved. `nedbot.site` serves a static page; whether `bots.nedbot.site`
becomes a route on the same host, a separate static bucket, or something with
a backend for `/report` is a decision that has not been made.

Static hosting is enough for `GET`. `POST /report` needs something that can
accept a request body and store it.
