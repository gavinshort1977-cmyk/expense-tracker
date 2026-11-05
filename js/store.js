// Local data storage in IndexedDB.
// - One "state" record holds settings, expenses, deletion markers and change stamps,
//   so every save is a single atomic write.
// - A "meta" record holds per-device things (sync connection, last sync time ...).
// - On first run, data saved by the old single-file version in localStorage is migrated.
import { mergeStates, canonical, stampChanges, snapshotOf, maxStamp } from "./merge.js";

export const LEGACY_KEY = "cardCashLedger.v1";
const STATE = "state", META = "meta";

function req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export function openDB(name = "card-cash-ledger") {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("kv"); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error("blocked"));
  });
}

function unionPending(a, b) { const o = { ...(normPending(a)) }; for (const [k, v] of Object.entries(normPending(b))) o[k] = Math.max(o[k] || 0, v); return o; }
function normPending(p) { return Array.isArray(p) ? Object.fromEntries(p.map(k => [k, 0])) : (p || {}); }
const strip = list => list.map(({ _confirm, ...e }) => e);

export class Store {
  constructor({ dbName = "card-cash-ledger", localStorage: ls = globalThis.localStorage, now = () => Date.now(), channelName = "ccl-store" } = {}) {
    this.dbName = dbName; this.ls = ls; this.now = now; this.channelName = channelName;
    this.listeners = new Set(); this.localListeners = new Set();
    this.writeChain = Promise.resolve();
  }

  async init({ defaults, samples, normalizeSettings }) {
    this.normalize = normalizeSettings;
    try { this.db = await openDB(this.dbName); }
    catch (e) { this.db = null; this.memory = new Map(); this.failed = e; } // storage blocked: keep working in memory
    let state = await this._get(STATE);
    this.meta = (await this._get(META)) || {};
    if (!this.meta.deviceId) this.meta.deviceId = "d" + Math.random().toString(36).slice(2, 10);
    this.info = { migrated: false, seeded: false, migrateError: null };
    if (!state) {
      const legacy = this._readLegacy();
      if (legacy && legacy.error) this.info.migrateError = legacy.error;
      if (legacy && legacy.data) {
        // Migrate the old localStorage data. Stamp everything so it counts as a change to sync.
        state = this._blank(normalizeSettings(legacy.data.settings));
        const prev = snapshotOf(this._blank(defaults()));
        state.expenses = Array.isArray(legacy.data.expenses) ? strip(legacy.data.expenses) : [];
        state.pending = Object.fromEntries(stampChanges(prev, state, () => this.tick(state)).map(k => [k, state.clock]));
        this.info.migrated = true;
        this.meta.migratedAt = new Date(this.now()).toISOString();
        try { this.ls && this.ls.setItem(LEGACY_KEY + ".migrated", this.meta.migratedAt); } catch (_) {}
      } else {
        // First run: seed the marked examples. They get stamp 0 so that a deletion on
        // another device always wins over them.
        state = this._blank(defaults());
        state.expenses = samples().map(e => ({ ...e, updatedAt: 0 }));
        this.info.seeded = true;
      }
      await this._put(STATE, state);
    }
    await this._put(META, this.meta);
    state.settings = normalizeSettings(state.settings);
    this.state = state;
    this.snap = snapshotOf(state);
    this._listenOtherTabs();
    return this.view();
  }

  _blank(settings) { return { settings, expenses: [], tombstones: {}, stamps: {}, clock: 0, pending: {} }; }

  _readLegacy() {
    let raw;
    try { raw = this.ls && this.ls.getItem(LEGACY_KEY); } catch (_) { return null; }
    if (!raw) return null;
    try { const d = JSON.parse(raw); return { data: d && typeof d === "object" ? d : { expenses: [] } }; }
    catch (e) { return { error: "unreadable" }; }
  }

  tick(state = this.state) {
    state.clock = Math.max(this.now(), (+state.clock || 0) + 1);
    return state.clock;
  }

  // What the UI works with
  view() { return { settings: this.state.settings, expenses: this.state.expenses }; }

  // Called by the app after every change. Works out what changed, stamps it and
  // writes it. Returns a promise; the in-memory state is updated immediately.
  commit(settings, expenses, { force = false } = {}) {
    const st = this.state;
    st.settings = settings; st.expenses = expenses;
    const work = { ...st, expenses: expenses };
    const changed = stampChanges(this.snap, work, () => this.tick(st), force);
    st.tombstones = work.tombstones; st.stamps = work.stamps;
    this.snap = snapshotOf(st);
    if (changed.length) { st.pending = { ...(st.pending || {}) }; for (const k of changed) st.pending[k] = st.clock; }
    const p = this._persist();
    if (changed.length) this.localListeners.forEach(f => f(changed));
    return p;
  }

  // Persist by merging with whatever is stored (another tab may have written meanwhile).
  // Read, merge and write happen in one IndexedDB transaction, so tabs can't overwrite each other.
  _persist() {
    const run = async () => {
      const mine = this._plain(this.state);
      const out = await this._update(stored => {
        if (!stored) return mine;
        const o = mergeStates(stored, mine);
        o.pending = unionPending(stored.pending, mine.pending);
        return o;
      });
      if (canonical(out) !== canonical(mine)) this._adopt(out);
      this._broadcast();
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  _plain(st) {
    return { settings: st.settings, expenses: strip(st.expenses), tombstones: { ...st.tombstones }, stamps: { ...st.stamps }, clock: st.clock, pending: { ...(st.pending || {}) } };
  }

  // Take in data written elsewhere, keeping anything newer that's only in memory
  _adopt(incoming) {
    const mem = this._plain(this.state);
    const m = mergeStates(incoming, mem);
    m.pending = unionPending(incoming.pending, mem.pending);
    this.state = { ...m, settings: this.normalize(m.settings), expenses: m.expenses.map(e => ({ ...e })) };
    this.snap = snapshotOf(this.state);
    this.listeners.forEach(f => f(this.view()));
  }

  // ---- for sync ----
  syncState() { return this._plain(this.state); }
  pendingCount() { return Object.keys(this.state.pending || {}).length; }

  // Merge data that came from Drive. Returns true if local data changed.
  async applyRemote(remote) {
    let changed = false;
    const run = async () => {
      const mine = this._plain(this.state);
      let before;
      const out = await this._update(stored => {
        const base = stored ? mergeStates(stored, mine) : mine;
        base.pending = unionPending(stored && stored.pending, mine.pending);
        before = canonical(base);
        const o = mergeStates(base, remote);
        o.pending = base.pending;
        changed = canonical(o) !== before;
        return o;
      });
      if (canonical(out) !== canonical(mine)) { this._adopt(out); this._broadcast(); }
    };
    this.writeChain = this.writeChain.then(run, run);
    await this.writeChain;
    return changed;
  }

  // After a successful upload: the changes that were pending when the upload was
  // prepared are now in Drive. A change made since then keeps its newer stamp and stays pending.
  async clearPending(snapshot) {
    const drop = p => { const o = { ...(p || {}) }; for (const [k, v] of Object.entries(snapshot || {})) if (o[k] === v) delete o[k]; return o; };
    this.state.pending = drop(this.state.pending);
    const run = async () => {
      await this._update(stored => { if (stored) stored.pending = drop(stored.pending); return stored; });
      this._broadcast("meta");
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  // ---- per-device meta ----
  getMeta(k) { return this.meta[k]; }
  async setMeta(patch) {
    Object.assign(this.meta, patch);
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete this.meta[k];
    await this._put(META, this.meta);
    this._broadcast("meta");
  }

  onChange(f) { this.listeners.add(f); }
  onLocalChange(f) { this.localListeners.add(f); }

  // ---- other tabs ----
  _listenOtherTabs() {
    if (typeof BroadcastChannel === "undefined") return;
    this.bc = new BroadcastChannel(this.channelName + ":" + this.dbName);
    this.bc.onmessage = async ev => {
      if (ev.data === "meta") { this.meta = (await this._get(META)) || this.meta; this.listeners.forEach(f => f(this.view(), "meta")); return; }
      const stored = await this._get(STATE);
      if (stored && canonical(stored) !== canonical(this._plain(this.state))) this._adopt(stored);
    };
  }
  _broadcast(kind = "state") { try { this.bc && this.bc.postMessage(kind); } catch (_) {} }

  // ---- raw IDB ----
  _get(k) {
    if (!this.db) return Promise.resolve(this.memory.has(k) ? structuredClone(this.memory.get(k)) : undefined);
    return req(this.db.transaction("kv").objectStore("kv").get(k));
  }
  // Atomic read-modify-write of the state record
  _update(fn) {
    if (!this.db) { const cur = this.memory.has(STATE) ? structuredClone(this.memory.get(STATE)) : undefined; const out = fn(cur); if (out) this.memory.set(STATE, structuredClone(out)); return Promise.resolve(out); }
    return new Promise((res, rej) => {
      const tx = this.db.transaction("kv", "readwrite"), os = tx.objectStore("kv");
      let out;
      const g = os.get(STATE);
      g.onsuccess = () => { try { out = fn(g.result); if (out) os.put(out, STATE); } catch (e) { tx.abort(); rej(e); } };
      tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error("abort"));
    });
  }
  _put(k, v) {
    if (!this.db) { this.memory.set(k, structuredClone(v)); return Promise.resolve(); }
    return new Promise((res, rej) => {
      const tx = this.db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(v, k);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error("abort"));
    });
  }
  close() { try { this.bc && this.bc.close(); this.db && this.db.close(); } catch (_) {} }
}

export async function requestPersistence() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return "unsupported";
    if (await navigator.storage.persisted()) return "granted";
    return (await navigator.storage.persist()) ? "granted" : "denied";
  } catch (_) { return "unsupported"; }
}
