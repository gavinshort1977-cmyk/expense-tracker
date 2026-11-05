#!/usr/bin/env python3
"""Run tests/index.html in headless Chrome and print the results.
Start the server first: python3 tools/serve.py 8765
Needs: pip install websocket-client"""
import sys, os, json
sys.path.insert(0, os.path.dirname(__file__))
from cdp import Chrome
base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
c = Chrome(port=9334)
try:
    c.goto(base + "/tests/index.html")
    res = c.wait_for("window.__results", timeout=300)
    for r in res.get("results", []):
        print(("PASS " if r["ok"] else "FAIL ") + r["name"] + ("" if r["ok"] else "\n     " + r["error"].replace("\n", "\n     ")))
    if res.get("crashed"): print("CRASHED:", res["crashed"]); print("\n".join(c.console_errors()))
    print(f"\n{res.get('passed', 0)} passed, {res.get('failed', 0)} failed")
    sys.exit(1 if res.get("failed") or res.get("crashed") else 0)
finally:
    c.close()
