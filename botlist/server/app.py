#!/usr/bin/env python3
"""
bots.nedbot.site — the shared bot list.

Two public endpoints and a small admin surface.

  GET  /bots.json[?since=YYYY-MM-DD]   the published list, full or incremental
  POST /report  {"username": "..."}    a report, which is NOT an entry

The distinction between those two is the whole design. A report goes into a
queue. Nothing reaches the published list without a human saying so. A list
that published reports directly would be a harassment tool: anyone could
mass-report an account and make it invisible to every install.

On reporter identity: the extension deliberately sends only a username — no
message, no channel, nothing about who reported it. But "how many DISTINCT
people reported this" is the one signal that separates a real pattern from one
person with a grudge, and the server has to derive it from something. It hashes
the request IP with a per-install salt and stores only the hash. The raw IP is
never written down, the hash cannot be reversed to an address, and it is used
for exactly two things: counting distinct reporters, and rate limiting.
"""

import hashlib
import json
import os
import re
import sqlite3
import time
from datetime import date, datetime, timezone
from flask import Flask, g, jsonify, request

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("BOTLIST_DB", os.path.join(APP_DIR, "botlist.db"))
ADMIN_TOKEN = os.environ.get("BOTLIST_ADMIN_TOKEN", "")
IP_SALT = os.environ.get("BOTLIST_IP_SALT", "")

# A username Kick would accept. Anything else is not worth storing, and this is
# the only untrusted string the service takes.
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{1,64}$")

REPORTS_PER_IP_PER_HOUR = 20

app = Flask(__name__)


# ── storage ────────────────────────────────────────────────────────────────

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    username    TEXT PRIMARY KEY,
    status      TEXT NOT NULL DEFAULT 'pending',   -- pending | published | rejected
    kind        TEXT,                              -- service | platform | spam
    added       TEXT,                              -- date it was published
    removed_at  TEXT,                              -- date it was retracted
    note        TEXT,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
    username    TEXT NOT NULL,
    ip_hash     TEXT NOT NULL,
    at          INTEGER NOT NULL,
    PRIMARY KEY (username, ip_hash)                -- one report per person per name
);

CREATE INDEX IF NOT EXISTS idx_reports_at ON reports(at);
CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
"""


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA journal_mode=WAL")
    return g.db


@app.teardown_appcontext
def _close(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()


# ── helpers ────────────────────────────────────────────────────────────────

def client_ip():
    # Behind Cloudflare and nginx, so the socket address is a proxy. Prefer the
    # header Cloudflare sets; fall back through X-Forwarded-For.
    cf = request.headers.get("CF-Connecting-IP")
    if cf:
        return cf.strip()
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        return xff.split(",")[0].strip()
    return request.remote_addr or ""


def ip_hash():
    """Salted hash of the reporter's address. The address itself is never stored."""
    return hashlib.sha256((IP_SALT + "|" + client_ip()).encode("utf-8")).hexdigest()


def today():
    return datetime.now(timezone.utc).date().isoformat()


def valid_date(s):
    try:
        date.fromisoformat(s)
        return True
    except (TypeError, ValueError):
        return False


# ── public: the list ───────────────────────────────────────────────────────

@app.get("/bots.json")
def bots_json():
    since = request.args.get("since", "")
    incremental = valid_date(since)
    conn = db()

    if incremental:
        # Only what changed. `added > since` rather than >=, because `since` is
        # a date the client has already seen in full.
        bots = conn.execute(
            "SELECT username, added, kind FROM entries "
            "WHERE status='published' AND removed_at IS NULL AND added > ? "
            "ORDER BY added, username",
            (since,),
        ).fetchall()
        removed = conn.execute(
            "SELECT username FROM entries WHERE removed_at IS NOT NULL AND removed_at > ? "
            "ORDER BY username",
            (since,),
        ).fetchall()
    else:
        bots = conn.execute(
            "SELECT username, added, kind FROM entries "
            "WHERE status='published' AND removed_at IS NULL "
            "ORDER BY added, username"
        ).fetchall()
        removed = []

    body = {
        # The client echoes this back as `since` next time. Sending the server's
        # own date rather than letting the client use its clock is what stops
        # the two drifting and silently skipping a day's entries.
        "through": today(),
        "bots": [
            {"username": r["username"], "added": r["added"], "kind": r["kind"]}
            for r in bots
        ],
        "removed": [r["username"] for r in removed],
    }
    resp = jsonify(body)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Cache-Control"] = "public, max-age=300"
    return resp


# ── public: reporting ──────────────────────────────────────────────────────

@app.post("/report")
def report():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip().lower()

    if not USERNAME_RE.match(username):
        return jsonify({"ok": False, "error": "invalid username"}), 400

    who = ip_hash()
    conn = db()

    # Rate limit before anything is written.
    hour_ago = int(time.time()) - 3600
    recent = conn.execute(
        "SELECT COUNT(*) c FROM reports WHERE ip_hash=? AND at > ?", (who, hour_ago)
    ).fetchone()["c"]
    if recent >= REPORTS_PER_IP_PER_HOUR:
        return jsonify({"ok": False, "error": "rate limited"}), 429

    # An account already ruled on is not re-queued by further reports. Somebody
    # cleared is cleared; re-reporting should not walk them back into review.
    existing = conn.execute(
        "SELECT status FROM entries WHERE username=?", (username,)
    ).fetchone()

    conn.execute(
        "INSERT OR IGNORE INTO reports (username, ip_hash, at) VALUES (?,?,?)",
        (username, who, int(time.time())),
    )
    if existing is None:
        conn.execute(
            "INSERT INTO entries (username, status, updated_at) VALUES (?, 'pending', ?)",
            (username, today()),
        )
    conn.commit()

    # Deliberately does not say how many reports an account has, or whether it
    # is queued or published. That would turn the endpoint into a way to probe
    # the moderation state of any account.
    return jsonify({"ok": True}), 202


# ── admin ──────────────────────────────────────────────────────────────────

def admin_ok():
    if not ADMIN_TOKEN:
        return False
    sent = request.headers.get("Authorization", "")
    return sent == "Bearer " + ADMIN_TOKEN


@app.get("/admin/pending")
def pending():
    if not admin_ok():
        return jsonify({"ok": False}), 401
    rows = db().execute(
        "SELECT e.username, e.status, e.note, "
        "       COUNT(r.ip_hash) reporters, MAX(r.at) last_report "
        "FROM entries e LEFT JOIN reports r ON r.username = e.username "
        "WHERE e.status='pending' "
        "GROUP BY e.username ORDER BY reporters DESC, e.username"
    ).fetchall()
    return jsonify({
        "ok": True,
        "pending": [dict(r) for r in rows],
    })


@app.post("/admin/decide")
def decide():
    """publish | reject | remove — the only way anything reaches the list."""
    if not admin_ok():
        return jsonify({"ok": False}), 401

    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip().lower()
    action = str(data.get("action", "")).strip()
    kind = str(data.get("kind", "spam")).strip() or "spam"
    note = str(data.get("note", "")).strip() or None

    if not USERNAME_RE.match(username):
        return jsonify({"ok": False, "error": "invalid username"}), 400
    if action not in ("publish", "reject", "remove"):
        return jsonify({"ok": False, "error": "invalid action"}), 400

    conn = db()
    if action == "publish":
        conn.execute(
            "INSERT INTO entries (username, status, kind, added, removed_at, note, updated_at) "
            "VALUES (?, 'published', ?, ?, NULL, ?, ?) "
            "ON CONFLICT(username) DO UPDATE SET "
            "  status='published', kind=excluded.kind, added=COALESCE(entries.added, excluded.added), "
            "  removed_at=NULL, note=excluded.note, updated_at=excluded.updated_at",
            (username, kind, today(), note, today()),
        )
    elif action == "reject":
        conn.execute(
            "INSERT INTO entries (username, status, note, updated_at) VALUES (?, 'rejected', ?, ?) "
            "ON CONFLICT(username) DO UPDATE SET status='rejected', note=excluded.note, "
            "  updated_at=excluded.updated_at",
            (username, note, today()),
        )
    else:  # remove — retract something already published
        # removed_at is set rather than the row deleted: an incremental client
        # only learns about a retraction if it appears in `removed`, and a
        # deleted row cannot be reported to anyone.
        conn.execute(
            "UPDATE entries SET removed_at=?, status='rejected', note=?, updated_at=? "
            "WHERE username=?",
            (today(), note, today(), username),
        )
    conn.commit()
    return jsonify({"ok": True, "username": username, "action": action})


@app.get("/health")
def health():
    counts = db().execute(
        "SELECT "
        "  (SELECT COUNT(*) FROM entries WHERE status='published' AND removed_at IS NULL) published, "
        "  (SELECT COUNT(*) FROM entries WHERE status='pending') pending, "
        "  (SELECT COUNT(*) FROM reports) reports"
    ).fetchone()
    return jsonify({"ok": True, "through": today(), **dict(counts)})


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5002")))
