"""Minimal Chrome DevTools Protocol helper for the automated tests (needs: pip install websocket-client)."""
import json, os, shutil, subprocess, tempfile, time, urllib.request
import websocket

CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

class Chrome:
    def __init__(self, port=9333, headless=True):
        self.port = port
        self.profile = tempfile.mkdtemp(prefix="ccl-chrome-")
        args = [CHROME, f"--remote-debugging-port={port}", f"--user-data-dir={self.profile}", "--no-first-run",
                "--no-default-browser-check", "--disable-gpu", "--window-size=1280,900", "about:blank"]
        if headless: args.insert(1, "--headless=new")
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json")); break
            except Exception: time.sleep(0.1)
        page = [t for t in tabs if t["type"] == "page"][0]
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=120, suppress_origin=True)
        self.i = 0; self.events = []
        self.send("Page.enable"); self.send("Runtime.enable"); self.send("Network.enable")

    def send(self, method, **params):
        self.i += 1; mid = self.i
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == mid:
                if "error" in m: raise RuntimeError(f"{method}: {m['error']}")
                return m.get("result", {})
            self.events.append(m)

    def eval(self, expr, await_promise=True):
        r = self.send("Runtime.evaluate", expression=expr, awaitPromise=await_promise, returnByValue=True)
        if "exceptionDetails" in r:
            raise RuntimeError(json.dumps(r["exceptionDetails"])[:1500])
        return r["result"].get("value")

    def goto(self, url, wait=0.5):
        self.send("Page.navigate", url=url); self.wait_load(); time.sleep(wait)

    def wait_load(self, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            if self.eval("document.readyState") == "complete": return
            time.sleep(0.1)

    def wait_for(self, expr, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            try:
                v = self.eval(expr)
                if v: return v
            except RuntimeError: pass
            time.sleep(0.2)
        raise TimeoutError(expr)

    def console_errors(self):
        out = []
        for m in self.events:
            if m.get("method") == "Runtime.exceptionThrown": out.append(m["params"]["exceptionDetails"].get("text", "") + " " + json.dumps(m["params"]["exceptionDetails"].get("exception", {}).get("description", ""))[:300])
            if m.get("method") == "Runtime.consoleAPICalled" and m["params"]["type"] == "error":
                out.append(" ".join(str(a.get("value", a.get("description", ""))) for a in m["params"]["args"]))
        return out

    def close(self):
        try: self.ws.close()
        except Exception: pass
        self.proc.terminate()
        try: self.proc.wait(5)
        except Exception: self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)
