#!/usr/bin/env python3
"""Local test server (serves .mjs with the right type). Usage: python3 tools/serve.py [port]"""
import http.server, os, sys
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".mjs": "text/javascript", ".js": "text/javascript", ".webmanifest": "application/manifest+json",
                      ".woff2": "font/woff2", ".pfb": "application/octet-stream"}
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()
    def log_message(self, *a): pass
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
