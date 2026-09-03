#!/usr/bin/env python3
"""
Seed the published list with accounts that are bots by their own description.

Deliberately only well-known automated chat services — the same set already
bundled in the extension as knownChatBots. Individual accounts merely SUSPECTED
of being spam bots are not here and must not be added this way: they go through
/report and a human decision like everything else.
"""

import os
import sqlite3
import sys
from datetime import datetime, timezone

DB_PATH = os.environ.get("BOTLIST_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "botlist.db"))

SERVICES = [
    ("kickbot", "platform"),
    ("botrix", "service"),
    ("streamelements", "service"),
    ("fossabot", "service"),
    ("nightbot", "service"),
    ("moobot", "service"),
    ("wizebot", "service"),
    ("sery_bot", "service"),
]


def main():
    today = datetime.now(timezone.utc).date().isoformat()
    conn = sqlite3.connect(DB_PATH)
    added = 0
    for username, kind in SERVICES:
        cur = conn.execute(
            "INSERT INTO entries (username, status, kind, added, note, updated_at) "
            "VALUES (?, 'published', ?, ?, 'seed: known chat bot service', ?) "
            "ON CONFLICT(username) DO NOTHING",
            (username, kind, today, today),
        )
        added += cur.rowcount
    conn.commit()
    total = conn.execute(
        "SELECT COUNT(*) FROM entries WHERE status='published' AND removed_at IS NULL"
    ).fetchone()[0]
    conn.close()
    print(f"seeded {added} new, {total} published in total")


if __name__ == "__main__":
    sys.exit(main())
