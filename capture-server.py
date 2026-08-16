"""
KickSanitizer capture server.
Receives DOM snapshots from capture-sniffer.js and writes them to files.
Run: python capture-server.py
Then paste capture-sniffer.js into DevTools console on any kick.com channel.
"""

import http.server
import json
import os
import re
import time
from datetime import datetime, timezone

PORT = 7799
CAPTURES_DIR = os.path.join(os.path.dirname(__file__), "captures")


def safe_name(s):
    return re.sub(r"[^a-zA-Z0-9_-]", "_", s)[:40]


class Handler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self._cors()
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        try:
            data = json.loads(body.decode("utf-8"))
        except Exception as e:
            self.send_error(400, str(e))
            return

        capture_type = safe_name(data.get("type", "unknown"))
        channel = safe_name(data.get("channel", "unknown"))
        html = data.get("html", "")
        note = data.get("note", "")

        out_dir = os.path.join(CAPTURES_DIR, channel)
        os.makedirs(out_dir, exist_ok=True)

        ts = datetime.now(timezone.utc).strftime("%H%M%S_%f")[:12]
        filename = f"{capture_type}_{ts}.html"
        filepath = os.path.join(out_dir, filename)

        with open(filepath, "w", encoding="utf-8") as f:
            f.write(f"<!-- type={capture_type} channel={channel} note={note} -->\n")
            f.write(html)

        # Append to the session log
        log_path = os.path.join(out_dir, "log.jsonl")
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": datetime.now(timezone.utc).isoformat(),
                "type": capture_type,
                "channel": channel,
                "file": filename,
                "note": note,
                "html_len": len(html),
            }) + "\n")

        print(f"  [{channel}] {capture_type:30s} → {filename}  ({len(html)} bytes)  {note[:60]}")

        self._cors()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")

    def log_message(self, *_):
        pass  # suppress default access log


os.makedirs(CAPTURES_DIR, exist_ok=True)
print(f"KickSanitizer capture server listening on http://localhost:{PORT}")
print(f"Writing to: {CAPTURES_DIR}")
print("Open kick.com in Chrome, paste capture-sniffer.js into DevTools console.")
print("Ctrl+C to stop.\n")

with http.server.HTTPServer(("localhost", PORT), Handler) as srv:
    srv.serve_forever()
