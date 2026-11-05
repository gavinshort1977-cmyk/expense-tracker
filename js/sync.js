// Google Drive sync engine. No backend: this device downloads the sync file,
// merges it with local data transaction by transaction, and uploads the result.
import { canonical } from "./merge.js";
import { deriveKey, encryptText, decryptText, newSalt, WrongPassphrase, DEFAULT_ITERATIONS } from "./crypto.js";
import { DriveError } from "./drive.js";

export const FILE_FORMAT = "card-cash-ledger-sync";

export class NeedPassphrase extends Error { constructor(reason) { super("need-passphrase"); this.name = "NeedPassphrase"; this.reason = reason; } }
export class BadFile extends Error { constructor(why) { super("bad-file: " + why); this.name = "BadFile"; } }

export class SyncEngine {
  constructor({ store, drive, auth, configured = true, online = () => navigator.onLine, now = () => Date.now(), iterations = DEFAULT_ITERATIONS, debounceMs = 2000, retryMs = 120000, timers = globalThis }) {
    Object.assign(this, { store, drive, auth, configured, online, now, iterations, debounceMs, retryMs, timers });
    this.listeners = new Set();
    this.running = null; this.again = false; this.timer = null;
    this.status = { state: "off", notice: null };
    this.lastRemoteText = null;
    this._recompute();
  }

  get connected() { return this.configured && !!this.store.getMeta("syncConnected"); }
  get encrypted() { return !!this.store.getMeta("enc"); }

  onStatus(f) { this.listeners.add(f); }
  _set(patch) { Object.assign(this.status, patch); this._recompute(); this.listeners.forEach(f => f(this.status)); }
  _recompute() {
    const m = k => this.store.getMeta(k);
    Object.assign(this.status, { lastSync: m("lastSync") || null, lastError: m("lastError") || null, pending: this.store.pendingCount(), connected: this.connected, configured: this.configured, encrypted: this.encrypted });
    if (!this.connected) this.status.state = "off";
    else if (this.status.state === "off") this.status.state = "idle";
  }
  refresh() { this._set({}); }

  // Call after every local change; uploads a little later so quick edits go in one upload
  schedule(ms = this.debounceMs) {
    this._recompute(); this.listeners.forEach(f => f(this.status));
    if (!this.connected) return;
    this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => { this.timer = null; this.syncNow().catch(() => {}); }, ms);
  }

  async connect() {
    await this.store.setMeta({ syncConnected: true, lastError: undefined });
    return this.syncNow();
  }
  async disconnect() {
    this.timers.clearTimeout(this.timer);
    await this.store.setMeta({ syncConnected: false, fileId: undefined, lastError: undefined, enc: undefined, encPrev: undefined, encPending: undefined });
    this._set({ state: "off", notice: null });
  }

  syncNow() {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try {
        do { this.again = false; await this._run(); } while (this.again);
      } finally { this.running = null; }
      return this.status;
    })();
    return this.running;
  }

  async _run() {
    if (!this.connected) { this._set({ state: "off" }); return; }
    if (!this.online()) { this._set({ state: "offline" }); return; }
    if (!this.auth.token()) { this._set({ state: "needs-auth" }); return; }
    this._set({ state: "syncing" });
    try {
      for (let attempt = 0; ; attempt++) {
        if (attempt >= 4) throw new Error("busy");
        // 1. find the sync file
        let file = null;
        const id = this.store.getMeta("fileId");
        if (id) {
          try { file = await this.drive.meta(id); if (file.trashed) file = null; }
          catch (e) { if (!(e instanceof DriveError && e.kind === "notfound")) throw e; }
        }
        if (!file) file = await this.drive.find();
        // 2. download and merge
        let remote = null;
        if (file) {
          const text = await this.drive.download(file.id);
          this.lastRemoteText = text;
          remote = await this._decode(text);
          await this.store.applyRemote(remote.state);
        }
        // 3. upload if Drive is behind (or the encryption setting changed)
        const pendingSnap = { ...(this.store.syncState().pending) };
        const local = this._payload();
        const enc = this.store.getMeta("enc");
        const modeChanged = remote && (remote.encrypted !== !!enc || (enc && remote.salt !== enc.salt));
        if (!remote || modeChanged || canonical(local) !== canonical(remote.state)) {
          if (file) {
            // someone else wrote since we downloaded: start over and merge their version too
            const m = await this.drive.meta(file.id);
            if (m.version !== file.version) continue;
          }
          const text = await this._encode(local);
          file = file ? await this.drive.update(file.id, text) : await this.drive.create(text);
        }
        await this.store.setMeta({ fileId: file.id, lastSync: new Date(this.now()).toISOString(), lastError: undefined, encPending: undefined, encPrev: undefined });
        await this.store.clearPending(pendingSnap);
        this._set({ state: "idle" });
        return;
      }
    } catch (e) {
      await this._fail(e);
    }
  }

  async _fail(e) {
    let state = "error", msg;
    if (e instanceof NeedPassphrase) { state = "needs-passphrase"; msg = e.reason === "changed" ? "The sync passphrase was changed on another device. Enter the new passphrase." : "The Drive file is encrypted. Enter your sync passphrase on this device."; }
    else if (e instanceof WrongPassphrase) { state = "needs-passphrase"; msg = "The saved passphrase no longer opens the Drive file. Enter the current passphrase."; }
    else if (e instanceof BadFile) msg = "The sync file in Drive couldn't be read (" + e.message.replace("bad-file: ", "") + "). Nothing was overwritten.";
    else if (e instanceof DriveError) {
      if (e.kind === "auth") { state = "needs-auth"; await this.auth.forgetToken(); msg = null; }
      else if (e.kind === "network") { state = "offline"; msg = null; }
      else if (e.kind === "ratelimit") msg = "Google Drive asked the app to slow down. It will try again shortly.";
      else if (e.kind === "forbidden") msg = "Google Drive refused access (" + (e.message || "403") + ").";
      else msg = "Google Drive error (" + (e.status || e.kind) + "). It will try again shortly.";
    } else if (e && e.message === "busy") msg = "Another device kept writing at the same moment. It will try again shortly.";
    else msg = "Sync failed: " + (e && e.message || e);
    if (msg) await this.store.setMeta({ lastError: { at: new Date(this.now()).toISOString(), message: msg } });
    this._set({ state });
    if (state === "error") { this.timers.clearTimeout(this.timer); this.timer = this.timers.setTimeout(() => { this.timer = null; this.syncNow().catch(() => {}); }, this.retryMs); }
  }

  _payload() {
    const { pending, ...rest } = this.store.syncState();
    return rest;
  }

  async _encode(state) {
    const head = { format: FILE_FORMAT, v: 1, app: "card-cash-ledger", writtenAt: new Date(this.now()).toISOString(), writtenBy: this.store.getMeta("deviceId") };
    const enc = this.store.getMeta("enc");
    if (!enc) return JSON.stringify({ ...head, encrypted: false, data: state });
    const kdf = { name: "PBKDF2", hash: "SHA-256", iterations: enc.iterations, salt: enc.salt };
    const box = await encryptText(enc.key, kdf, JSON.stringify(state));
    return JSON.stringify({ ...head, encrypted: true, ...box });
  }

  async _decode(text) {
    let f;
    try { f = JSON.parse(text); } catch (_) { throw new BadFile("not JSON"); }
    if (!f || f.format !== FILE_FORMAT) throw new BadFile("not a ledger sync file");
    if (f.v > 1) throw new BadFile("made by a newer version of the app; update this device");
    if (f.encrypted) {
      const salt = f.kdf && f.kdf.salt;
      const keys = [this.store.getMeta("enc"), this.store.getMeta("encPrev")].filter(k => k && k.salt === salt);
      if (!keys.length) throw new NeedPassphrase(this.store.getMeta("enc") ? "changed" : "locked");
      let lastErr;
      for (const k of keys) {
        try { return { state: JSON.parse(await decryptText(k.key, f)), encrypted: true, salt }; } catch (e) { lastErr = e; }
      }
      throw lastErr;
    }
    if (!f.data || !Array.isArray(f.data.expenses)) throw new BadFile("missing data");
    // Encryption was turned off on another device: follow the file (unless this device just turned it on)
    if (this.store.getMeta("enc") && this.store.getMeta("encPending") !== "on") {
      await this.store.setMeta({ enc: undefined });
      this._set({ notice: "Encryption of the Drive file was turned off on another device." });
    }
    return { state: f.data, encrypted: false, salt: null };
  }

  // ---- encryption controls ----
  async setPassphrase(passphrase) {
    const salt = newSalt();
    const key = await deriveKey(passphrase, salt, this.iterations);
    const prev = this.store.getMeta("enc");
    await this.store.setMeta({ enc: { salt, iterations: this.iterations, key }, encPrev: prev || this.store.getMeta("encPrev"), encPending: "on" });
    this._set({ notice: null });
    return this.syncNow();
  }

  async disableEncryption() {
    const prev = this.store.getMeta("enc");
    await this.store.setMeta({ enc: undefined, encPrev: prev, encPending: "off" });
    return this.syncNow();
  }

  // Enter the passphrase for a file that was encrypted on another device
  async unlock(passphrase) {
    const f = JSON.parse(this.lastRemoteText || "{}");
    if (!f.encrypted || !f.kdf) return this.syncNow();
    const key = await deriveKey(passphrase, f.kdf.salt, f.kdf.iterations);
    await decryptText(key, f); // throws WrongPassphrase
    const k = { salt: f.kdf.salt, iterations: f.kdf.iterations, key };
    if (this.store.getMeta("encPending") === "on") await this.store.setMeta({ encPrev: k });
    else await this.store.setMeta({ enc: k, encPrev: undefined, encPending: undefined });
    await this.store.setMeta({ lastError: undefined });
    return this.syncNow();
  }
}
