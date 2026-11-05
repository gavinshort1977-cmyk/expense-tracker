#!/usr/bin/env python3
"""End-to-end checks of the real app in headless Chrome: install readiness, offline use,
storage, backup restore, migration and the sync screens (Google is faked in the page).
Start the server first: python3 tools/serve.py 8765        Needs: pip install websocket-client
Invented data only."""
import base64, json, os, sys, tempfile, time
sys.path.insert(0, os.path.dirname(__file__))
from cdp import Chrome

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
ALT = BASE.replace("127.0.0.1", "localhost")  # a second origin = a separate, empty device
results = []

def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  -> " + str(detail)))

def fresh(c, url):
    c.goto(url, wait=0.3)
    c.wait_for("document.querySelector('#rows tr') && !/Loading/.test(document.querySelector('#status').textContent)")

def set_file(c, selector, path):
    doc = c.send("DOM.getDocument")
    node = c.send("DOM.querySelector", nodeId=doc["root"]["nodeId"], selector=selector)
    c.send("DOM.setFileInputFiles", nodeId=node["nodeId"], files=[path])

def idb_state(c):
    return c.eval("""new Promise((res,rej)=>{const r=indexedDB.open('card-cash-ledger');r.onsuccess=()=>{const g=r.result.transaction('kv').objectStore('kv').get('state');g.onsuccess=()=>{res(JSON.parse(JSON.stringify(g.result)));r.result.close()}}})""")

c = Chrome(port=9335)
try:
    # ---------- first open, install readiness ----------
    fresh(c, BASE + "/")
    check("app opens with the example banner", c.eval("!document.querySelector('#exBanner').hidden"))
    c.wait_for("navigator.serviceWorker.ready.then(()=>true)")
    c.goto(BASE + "/", wait=0.5); c.wait_for("!!navigator.serviceWorker.controller")
    check("service worker controls the page", c.eval("!!navigator.serviceWorker.controller"))
    m = c.send("Page.getAppManifest")
    check("manifest parses without errors", not m.get("errors"), m.get("errors"))
    inst = c.send("Page.getInstallabilityErrors")
    errs = [e["errorId"] for e in inst.get("installabilityErrors", [])]
    check("Chrome reports the app as installable", not errs, errs)
    cache_n = c.eval("caches.keys().then(async ks=>{let n=0;for(const k of ks)n+=(await (await caches.open(k)).keys()).length;return n})")
    check("all app files are cached for offline use", cache_n >= 40, cache_n)
    check("persistent storage request answered", c.eval("navigator.storage.persisted()") in (True, False))
    ext = c.eval("performance.getEntriesByType('resource').map(r=>r.name).filter(u=>!u.startsWith(location.origin))")
    check("no requests to other sites (fonts, pdf.js are local)", not ext, ext)
    check("sync section says it's off until a client ID is added", "Sync is off" in c.eval("document.querySelector('#syncBody').textContent"))

    # ---------- add an expense, survives reload ----------
    c.eval("""(()=>{document.querySelector('#aAmt').value='123.45';document.querySelector('#aNote').value='E2E invented coffee';
      document.querySelector('#aAmt').dispatchEvent(new Event('input'));document.querySelector('#addForm').requestSubmit();})()""")
    time.sleep(0.6)
    c.goto(BASE + "/", wait=0.8)
    c.wait_for("document.querySelector('#rows').textContent.includes('E2E invented coffee')", 10)
    check("added expense is still there after reload", True)
    st = idb_state(c)
    check("stored in IndexedDB with a change stamp", any(e.get("note") == "E2E invented coffee" and e.get("updatedAt", 0) > 0 for e in st["expenses"]))
    check("nothing in localStorage", c.eval("localStorage.length") == 0, c.eval("Object.keys(localStorage)"))

    # ---------- offline ----------
    c.send("Network.emulateNetworkConditions", offline=True, latency=0, downloadThroughput=-1, uploadThroughput=-1)
    c.send("Network.setCacheDisabled", cacheDisabled=True)
    c.goto(BASE + "/", wait=1)
    ok = c.wait_for("document.querySelector('#rows') && document.querySelector('#rows').textContent.includes('E2E invented coffee')", 10)
    check("app opens with no network (from the offline cache)", ok)
    fonts = c.eval("document.fonts.ready.then(()=>[...document.fonts].filter(f=>f.status==='loaded').map(f=>f.family))")
    check("fonts load offline", any("Figtree" in f for f in fonts), fonts)
    # import a password-protected statement while offline
    set_file(c, "#iFile", os.path.join(ROOT, "tests/fixtures/statement-a-aes256.pdf"))
    c.eval("document.querySelector('#iCard').value='enbd';document.querySelector('#iPw').value='test-1234';document.querySelector('#impForm').requestSubmit()")
    txt = c.wait_for("!document.querySelector('#iReview').hidden && document.querySelector('#iStat').textContent", 30)
    check("password-protected PDF imports offline", "Found 7 lines" in txt, txt)
    check("PDF password field is cleared after reading", c.eval("document.querySelector('#iPw').value") == "")
    c.eval("document.querySelector('#iAdd').click()")
    time.sleep(0.5)
    st = idb_state(c)
    imported = [e for e in st["expenses"] if e.get("source") == "statement"]
    check("imported statement lines saved (5 charges; payment and refund skipped)", len(imported) == 5, [e["note"] for e in imported])
    c.send("Network.emulateNetworkConditions", offline=False, latency=0, downloadThroughput=-1, uploadThroughput=-1)
    c.send("Network.setCacheDisabled", cacheDisabled=False)

    # ---------- backup restore (single-file version's format) ----------
    fixture = json.load(open(os.path.join(ROOT, "tests/fixtures/backup-v1-sample.json")))
    c.goto(BASE + "/", wait=0.8)
    c.eval("document.querySelector('#settings').open=true")
    set_file(c, "#rsFile", os.path.join(ROOT, "tests/fixtures/backup-v1-sample.json"))
    c.wait_for("!document.querySelector('#rsConfirm').hidden", 10)
    check("restore asks before replacing", "with the backup from 28 Oct 2026 (6 expenses)" in c.eval("document.querySelector('#rsText').textContent"), c.eval("document.querySelector('#rsText').textContent"))
    c.eval("document.querySelector('#rsYes').click()"); time.sleep(0.6)
    st = idb_state(c)
    got = {e["id"]: {k: v for k, v in e.items() if k != "updatedAt"} for e in st["expenses"]}
    want = {e["id"]: e for e in fixture["expenses"]}
    check("restore: exactly the backup's expenses, field for field", got == want, set(got) ^ set(want))
    s = st["settings"]
    check("restore: settings (cards, budgets, rates, paid marks, rules, categories)",
          s["cards"]["cbd"] == fixture["settings"]["cards"]["cbd"] and s["budgets"] == fixture["settings"]["budgets"] and s["fx"]["INR"] == 0.0437
          and s["paid"] == fixture["settings"]["paid"] and s["rules"] == fixture["settings"]["rules"] and s["categories"] == fixture["settings"]["categories"])
    check("restore: old examples and earlier rows removed with deletion markers", "ex0" in st["tombstones"] and len(st["tombstones"]) >= 7, len(st["tombstones"]))
    c.eval("window.__view=(y,m)=>{}")
    # download a backup and compare the format
    dl = tempfile.mkdtemp(prefix="ccl-dl-")
    c.send("Browser.setDownloadBehavior", behavior="allow", downloadPath=dl)
    c.eval("document.querySelector('#bkBtn').click()"); time.sleep(1.5)
    files = [f for f in os.listdir(dl) if f.endswith(".json")]
    if files:
        bk = json.load(open(os.path.join(dl, files[0])))
        check("backup file keeps the same format (app, v:1, savedAt, settings, expenses)", list(bk.keys()) == ["app", "v", "savedAt", "settings", "expenses"] and bk["app"] == "card-cash-ledger" and bk["v"] == 1, list(bk.keys()))
        same = {e["id"]: {k: v for k, v in e.items() if k != "updatedAt"} for e in bk["expenses"]} == want
        check("downloaded backup contains the same expenses", same)
        # and it restores again (round trip)
        set_file(c, "#rsFile", os.path.join(dl, files[0])); c.wait_for("!document.querySelector('#rsConfirm').hidden", 10)
        c.eval("document.querySelector('#rsYes').click()"); time.sleep(0.5)
        st2 = idb_state(c)
        check("a backup made by the new app restores too", {e["id"] for e in st2["expenses"]} == set(want))
    else:
        check("backup downloaded", False, os.listdir(dl))
    errs = [e for e in c.console_errors() if "favicon" not in e and "ERR_INTERNET_DISCONNECTED" not in e]
    check("no script errors in the console", not errs, errs[:5])

    # ---------- migration from the old localStorage format (fresh origin = new device) ----------
    legacy = {"app": "card-cash-ledger", "v": 1, "savedAt": "2026-10-28T08:15:00.000Z", "settings": fixture["settings"], "expenses": fixture["expenses"]}
    c.goto(ALT + "/manifest.webmanifest", wait=0.2)
    c.eval("localStorage.setItem('cardCashLedger.v1', %s)" % json.dumps(json.dumps(legacy)))
    fresh(c, ALT + "/")
    st = idb_state(c)
    check("old localStorage data migrated into IndexedDB", {e["id"] for e in st["expenses"]} == set(want), [e["id"] for e in st["expenses"]])
    check("migrated settings kept", st["settings"]["budgets"] == fixture["settings"]["budgets"])
    check("migration message shown", "Moved your saved expenses" in c.eval("document.querySelector('#addMsg').textContent"))

    # ---------- sync screens with a faked Google (in-page mock Drive) ----------
    fake = r"""
      window.__fakeGoogle = true;
      window.google = { accounts: { oauth2: {
        initTokenClient: (o) => ({ requestAccessToken: () => setTimeout(() => o.callback({ access_token: "tok-A", expires_in: 3599, scope: o.scope }), 10) }),
        hasGrantedAllScopes: (r, s) => r.scope === s, revoke: (t, cb) => cb && cb() } } };
      const realFetch = window.fetch.bind(window);
      window.fetch = async (u, o) => {
        if (String(u).startsWith("https://www.googleapis.com/")) {
          if (!window.__drive) { const { MockDrive } = await import(new URL("tests/mock-drive.js", document.baseURI).href); window.__drive = new MockDrive(); }
          return window.__drive.handle(String(u), o || {});
        }
        return realFetch(u, o);
      };"""
    c.send("Page.addScriptToEvaluateOnNewDocument", source=fake)
    c.send("Network.setBypassServiceWorker", bypass=True)
    c.send("Network.setCacheDisabled", cacheDisabled=True)
    c.send("Fetch.enable", patterns=[{"urlPattern": "*config.js*", "requestStage": "Response"}])
    cfg = 'export const GOOGLE_CLIENT_ID = "1234567890-fakeclientidfortests.apps.googleusercontent.com";\n'
    c.send("Page.navigate", url=ALT + "/")
    # answer the config.js request with a test client ID
    end = time.time() + 15
    while time.time() < end:
        m = json.loads(c.ws.recv())
        if m.get("method") == "Fetch.requestPaused":
            c.send("Fetch.fulfillRequest", requestId=m["params"]["requestId"], responseCode=200,
                   responseHeaders=[{"name": "Content-Type", "value": "text/javascript"}], body=base64.b64encode(cfg.encode()).decode())
            break
        c.events.append(m)
    c.send("Fetch.disable")
    c.wait_for("document.querySelector('#syncBody') && document.querySelector('#syncBody').textContent.includes('Connect Google Drive')", 15)
    check("with a client ID, the sync section offers 'Connect Google Drive'", True)
    c.eval("document.querySelector('#settings').open=true; document.querySelector('[data-sync=connect]').click()")
    c.wait_for("document.querySelector('#status').textContent.includes('Synced')", 15)
    check("connecting syncs and the header shows 'Synced …'", True, c.eval("document.querySelector('#status').textContent"))
    f = c.eval("window.__drive.only().map(f=>({name:f.name,enc:JSON.parse(f.content).encrypted,n:JSON.parse(f.content).data.expenses.length}))")
    check("one clearly named file in (mock) Drive with this device's data", len(f) == 1 and f[0]["name"] == "Card & Cash Ledger - sync data.json" and f[0]["n"] == 6, f)
    body = c.eval("document.querySelector('#syncBody').textContent")
    check("sync section shows last sync time and file name", "Last synced" in body and "just now" in body and "sync data.json" in body, body[:300])
    # a change uploads by itself shortly after
    c.eval("""(()=>{document.querySelector('#aAmt').value='9.99';document.querySelector('#aNote').value='E2E after connect';
      document.querySelector('#aAmt').dispatchEvent(new Event('input'));document.querySelector('#addForm').requestSubmit();})()""")
    c.wait_for("window.__drive.contentJSON().data.expenses.some(e=>e.note==='E2E after connect')", 15)
    check("a new expense uploads automatically after the change", True)
    # encryption through the UI
    c.eval("document.querySelector('[data-sync=showpass]').click()")
    check("passphrase form shows the no-recovery warning", "can't be opened by you, by Google or by anyone else" in c.eval("document.querySelector('#passForm').textContent"))
    c.eval("document.querySelector('#syP1').value='e2e invented passphrase';document.querySelector('#syP2').value='e2e invented passphrase';document.querySelector('[data-sync=encon]').click()")
    time.sleep(0.5)
    check("refuses without ticking the 'no recovery' box", "Tick the box" in c.eval("document.querySelector('#syncMsg').textContent"))
    c.eval("document.querySelector('#syAck').checked=true;document.querySelector('[data-sync=encon]').click()")
    c.wait_for("window.__drive.contentJSON().encrypted===true", 30)
    raw = c.eval("window.__drive.only()[0].content")
    check("Drive file is encrypted after turning it on in the UI", "E2E after connect" not in raw)
    c.wait_for("document.querySelector('#syncBody').textContent.includes('encrypted with your passphrase')", 10)
    check("sync section says the file is encrypted", True)
    # error display
    c.eval("window.__drive.only()[0].content='garbage'; document.querySelector('[data-sync=now]').click()")
    c.wait_for("document.querySelector('#status').textContent.includes('Sync error')", 10)
    check("sync errors appear in the header and the sync section", "couldn't be read" in c.eval("document.querySelector('#syncBody').textContent"))
    # offline queue indicator
    c.eval("window.__drive.only()[0].content=JSON.stringify({format:'card-cash-ledger-sync',v:1,encrypted:false,data:{expenses:[],tombstones:{},settings:{},stamps:{},clock:0}})")
    c.send("Network.emulateNetworkConditions", offline=True, latency=0, downloadThroughput=-1, uploadThroughput=-1)
    c.eval("window.dispatchEvent(new Event('offline'))")
    c.eval("""(()=>{document.querySelector('#aAmt').value='4.00';document.querySelector('#aNote').value='E2E offline';
      document.querySelector('#aAmt').dispatchEvent(new Event('input'));document.querySelector('#addForm').requestSubmit();})()""")
    time.sleep(3)
    status = c.eval("document.querySelector('#status').textContent")
    check("offline changes show as waiting", "waiting" in status, status)
finally:
    c.close()
failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
