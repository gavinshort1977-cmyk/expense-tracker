# Card & Cash Ledger (installable web app)

Personal card and cash expense ledger. Installs on Android Chrome and desktop Chrome, works fully offline, keeps data in IndexedDB on each device, and can optionally sync through a file in the user's own Google Drive. No backend, no AI calls, no analytics.

**Setting it up?** Read [SETUP-GUIDE.md](SETUP-GUIDE.md), which is written for non-developers.

## The one setting

`config.js` holds `GOOGLE_CLIENT_ID`. Leave it empty and sync stays off; everything else works. A client ID is public by design. There is no client secret anywhere in this app, and none should be added.

## Layout

| Path | What it is |
|---|---|
| `index.html` | The page and its styles (same design as the single-file version) |
| `js/app.js` | The app: quick add, statements, charts, register, settings, backup/restore, sync screens |
| `js/store.js` | IndexedDB storage, migration from the old `localStorage` key, multi-tab safety |
| `js/merge.js` | Pure merge logic (per transaction and per setting, with deletion markers) |
| `js/sync.js` | Drive sync engine: download, merge, upload, offline queue, encryption |
| `js/drive.js` | Minimal Drive v3 REST client (`drive.file` scope) |
| `js/auth.js` | Google Identity Services token flow (in the browser, no secret) |
| `js/crypto.js` | Passphrase encryption (PBKDF2-SHA-256 600k → AES-256-GCM, Web Crypto) |
| `js/statement.js` | PDF and bank CSV statement reading |
| `vendor/pdfjs/` | pdf.js 4.10.38 (Apache-2.0), bundled locally |
| `fonts/` | Self-hosted Google Fonts (OFL) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and installability |
| `tests/` | Browser test suite; `tests/fixtures/` holds synthetic statements and a synthetic backup |
| `tools/` | Build, local server, fixture generator, headless test runners |

## Data and file formats

- **Backup file:** unchanged: `{app:"card-cash-ledger", v:1, savedAt, settings, expenses}`. Expenses now carry one extra field, `updatedAt` (sync timestamp), which older copies ignore. Old backups restore as before.
- **Local storage:** IndexedDB database `card-cash-ledger`, store `kv`: `state` (settings, expenses, deletion markers, per-setting stamps, clock, pending-change list) and `meta` (per-device: sync connection, file id, last sync, error, encryption key, token).
- **Migration:** on first run, if IndexedDB is empty and `localStorage["cardCashLedger.v1"]` exists on the same origin, it is imported and stamped for upload. The old key is left in place, plus a `.migrated` marker. Data from the old `file://` page is on a different origin, so users move it with a backup (see the guide).
- **Drive file:** `Card & Cash Ledger - sync data.json` in My Drive, tagged with `appProperties.cclSync = "1"`. Plain: `{format:"card-cash-ledger-sync", v:1, encrypted:false, data:{settings, stamps, expenses, tombstones, clock}}`. Encrypted: the same header plus `{encrypted:true, kdf:{name,hash,iterations,salt}, cipher:"AES-GCM", iv, data}`.

## How sync merges

- Every change goes through `save()` → `Store.commit()`, which diffs against the last snapshot and stamps changed records (`updatedAt`), removed records (a deletion marker, `tombstones[id]`) and changed settings entries (`stamps[path]`). Stamps use a hybrid clock, `max(now, lastSeen + 1)`, so a device with a slow clock still orders after what it has already seen.
- `mergeStates` works per transaction id: the newest version wins, and a deletion wins over versions older than it. Settings merge per card, budget, rate, paid mark and rule. The merge is commutative, associative and idempotent (the tests check this on random cases).
- Sync cycle: find the file → download → decrypt → merge into local → if Drive is behind, re-check the file `version` (restart if another device wrote meanwhile) → upload. Changes made during an upload stay queued.
- Triggers: app open, 2 s after a change, `online` event, returning to the app after 30 s or more away, and every 5 minutes while it's open.
- Seeded example rows have stamp 0, so a deletion on any device wins.
- Restoring a backup force-stamps everything, so "replace" applies on all synced devices.

## Developing

```bash
python3 tools/serve.py 8765
```

Then open <http://127.0.0.1:8765/> for the app, or <http://127.0.0.1:8765/tests/> for the test suite in any Chrome.

After changing any app file (except `config.js`), regenerate the service worker's file list and version:

```bash
python3 tools/build.py
```

Headless runs (need `pip install websocket-client`, plus Google Chrome):

```bash
python3 tools/run_tests.py
```

```bash
python3 tools/e2e.py
```

Synthetic statement PDFs are regenerated with `pip install pypdf cryptography`, then:

```bash
python3 tools/make_fixtures.py
```

**Never add real statements, backups or financial data to this repository.** All fixtures are invented.

## Test coverage

`tests/` (47 tests, real Chrome, mocked Drive):
- merge rules, plus 300 random cases for convergence
- IndexedDB persistence, localStorage migration, unreadable legacy data, two tabs writing at once
- encryption round trip, wrong passphrase, tampering, non-extractable key
- sync with simulated devices, each with its own storage, clock, network switch and token: first upload, second device; offline edits to different transactions; conflicting edits to the same transaction, in both upload orders; offline deletion vs. earlier and later edits; deletions and adds on both sides; per-setting merges, including un-marking "paid"; a device with a slow clock; cleared examples; another device writing between download and upload; a change during an upload; expired token; deleted Drive file; damaged Drive file; network failure mid-sync; encryption on, unlock, wrong passphrase, passphrase change, encryption off, encryption turned on offline; disconnect
- PDF import: AES-256, AES-128, RC4-128 and unencrypted synthetic statements; year-less dates across New Year; missing and wrong password; pdf.js loaded locally; bank CSV

`tools/e2e.py` (38 checks on the real app in headless Chrome): installability, service worker and offline cache, no external requests, offline reload, offline fonts, offline import of a password-protected PDF, IndexedDB storage, restoring the old-format backup field for field, the downloaded backup's format and its round trip, migration from localStorage, and the sync screens against a faked Google library and an in-page mock Drive (connect, automatic upload, encryption with the no-recovery warning, error display, offline queue).

## Not tested against the real Google service

Everything Google-facing was tested only against mocks. Before relying on sync, try it once with throwaway entries:

- Google Identity Services: the real sign-in pop-up, consent screen, "unverified app" screen, the `hasGrantedAllScopes` check, token expiry after about an hour, and revoking on Disconnect.
- Pop-up behaviour on Android Chrome when the app runs installed (standalone).
- Real Drive v3 responses: the `appProperties` search, multipart create, media update, the `version` field going up on each upload, and real error bodies (401, 403, 404, 429).
- The `drive.file` permission letting the *same* client ID see the file from a second device. Google documents this, but it hasn't been exercised here.
- Behaviour when the file is moved, shared, or edited by hand in Drive.
- Google Cloud console steps in the guide: the screens are described from Google's current documentation and may be worded differently.
- GitHub Pages hosting itself. Everything ran on a local server, both at the root and under a `/repo-name/`-style sub-path like GitHub Pages uses; both test suites pass in both setups.
- Real bank PDFs: only synthetic statements were used.
