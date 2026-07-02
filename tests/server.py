#!/usr/bin/env python3
"""Local test server for the extension's e2e smoke tests.

Endpoints (per-name isolated state, stdlib only):

  GET  /page/<name>?after=N&kw=WORD   HTML page; from the N-th request on
                                      (default 3) the body contains WORD
                                      (default "โปรโมชั่นพิเศษ") inside a
                                      button that POSTs /clicked/<name>.
  GET  /changing/<name>?after=N       HTML page whose text content changes
                                      from the N-th request on (no keyword).
  GET  /counter/<name>                {"count": int, "times": [epoch_ms, ...]}
  GET  /clicks/<name>                 {"clicks": int}
  POST /clicked/<name>                record a button click
  POST /reset/<name>                  reset all state for <name>

Usage: python3 tests/server.py [port]   (default 8907)
"""

import json
import sys
import threading
import time
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DEFAULT_PORT = 8907
DEFAULT_KEYWORD = "โปรโมชั่นพิเศษ"

_lock = threading.Lock()
_counts = defaultdict(int)
_times = defaultdict(list)
_clicks = defaultdict(int)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # keep test output clean
        pass

    def _send(self, status, body, content_type="text/html; charset=utf-8"):
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj):
        self._send(200, json.dumps(obj), "application/json; charset=utf-8")

    def do_GET(self):
        url = urlparse(self.path)
        parts = [p for p in url.path.split("/") if p]
        qs = parse_qs(url.query)

        if len(parts) == 2 and parts[0] in ("page", "changing"):
            name = parts[1]
            after = int(qs.get("after", ["3"])[0])
            keyword = qs.get("kw", [DEFAULT_KEYWORD])[0]
            with _lock:
                _counts[name] += 1
                _times[name].append(int(time.time() * 1000))
                count = _counts[name]

            if parts[0] == "page":
                extra = ""
                if count >= after:
                    extra = (
                        f'<p>สถานะสินค้า: <button id="buy" '
                        f"onclick=\"fetch('/clicked/{name}', {{method: 'POST'}})\">"
                        f"{keyword} — ซื้อเลย</button></p>"
                    )
                body = f"""<!DOCTYPE html>
<html lang="th"><head><meta charset="utf-8"><title>ทดสอบ {name}</title></head>
<body>
<h1>หน้าทดสอบ {name}</h1>
<p>โหลดครั้งที่ {count}</p>
{extra}
</body></html>"""
            else:  # changing
                phase = "ข้อความชุดแรก ยังไม่มีอะไรเปลี่ยน" if count < after else f"เนื้อหาเปลี่ยนแล้ว! (รอบ {count})"
                body = f"""<!DOCTYPE html>
<html lang="th"><head><meta charset="utf-8"><title>ทดสอบ {name}</title></head>
<body>
<h1>หน้าทดสอบความเปลี่ยนแปลง</h1>
<p>{phase}</p>
<p><button id="act" onclick="fetch('/clicked/{name}', {{method: 'POST'}})">ดำเนินการ</button></p>
</body></html>"""
            self._send(200, body)
            return

        if len(parts) == 2 and parts[0] == "counter":
            with _lock:
                self._json({"count": _counts[parts[1]], "times": list(_times[parts[1]])})
            return

        if len(parts) == 2 and parts[0] == "clicks":
            with _lock:
                self._json({"clicks": _clicks[parts[1]]})
            return

        self._send(404, "not found", "text/plain; charset=utf-8")

    def do_POST(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]

        if len(parts) == 2 and parts[0] == "clicked":
            with _lock:
                _clicks[parts[1]] += 1
            self._json({"ok": True})
            return

        if len(parts) == 2 and parts[0] == "reset":
            name = parts[1]
            with _lock:
                _counts.pop(name, None)
                _times.pop(name, None)
                _clicks.pop(name, None)
            self._json({"ok": True})
            return

        self._send(404, "not found", "text/plain; charset=utf-8")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"test server on http://127.0.0.1:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
