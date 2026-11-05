// Simulated devices for sync tests: each has its own IndexedDB database, clock,
// network switch and Google token, and they share one MockDrive. Invented data only.
import { Store } from "../js/store.js";
import { SyncEngine } from "../js/sync.js";
import { DriveClient } from "../js/drive.js";

export const DEFAULTS = () => ({
  cards: { cbd: { statementDay: null, dueDay: null, limit: null }, enbd: { statementDay: null, dueDay: null, limit: null } },
  categories: ["Groceries", "Dining & coffee", "Other"], budgets: {}, fx: { AED: 1, USD: 3.6725 }, paid: {}, rules: {}, lastBackup: null,
});
export const SAMPLES = () => [
  { id: "ex0", date: "2026-10-03", amount: 10, currency: "AED", aed: 10, method: "cbd", category: "Groceries", note: "Example A", createdAt: 0, sample: true },
  { id: "ex1", date: "2026-10-04", amount: 20, currency: "AED", aed: 20, method: "cash", category: "Other", note: "Example B", createdAt: 1, sample: true },
];
export function normalize(s) {
  const d = DEFAULTS();
  const out = { ...d, ...(s || {}) };
  for (const k of ["cards", "budgets", "fx", "paid", "rules"]) out[k] = { ...(k === "cards" ? d.cards : {}), ...((s || {})[k] || {}) };
  if (!Array.isArray(out.categories) || !out.categories.length) out.categories = d.categories;
  if (!Object.keys(out.fx).length) out.fx = d.fx;
  return out;
}

export function memoryLocalStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}

let dbCounter = 0;
export function uniqueDb(prefix = "test") { return `${prefix}-${Date.now()}-${++dbCounter}-${Math.random().toString(36).slice(2, 6)}`; }

export const BASE_TIME = Date.UTC(2026, 10, 1, 9, 0, 0);

export async function makeDevice(name, drive, { offsetMs = 0, ls, dbName } = {}) {
  const dev = { name, net: { online: true }, clockOffset: offsetMs, elapsed: 0 };
  dev.now = () => BASE_TIME + dev.elapsed + dev.clockOffset;
  dev.store = new Store({ dbName: dbName || uniqueDb(name), localStorage: ls || memoryLocalStorage(), now: dev.now, channelName: "test-" + name });
  const view = await dev.store.init({ defaults: DEFAULTS, samples: SAMPLES, normalizeSettings: normalize });
  dev.settings = view.settings; dev.expenses = view.expenses;
  dev.token = "tok-" + name;
  dev.auth = { token: () => dev.token, forgetToken: async () => { dev.token = null; } };
  dev.drive = new DriveClient({ fetch: drive.fetchFor(dev.net), getToken: () => dev.auth.token() });
  // no background timers in tests: every sync is triggered explicitly
  dev.sync = new SyncEngine({ store: dev.store, drive: dev.drive, auth: dev.auth, online: () => dev.net.online, now: dev.now, iterations: 2000, timers: { setTimeout: () => 0, clearTimeout: () => {} } });
  dev.store.onChange(v => { dev.settings = v.settings; dev.expenses = v.expenses; });
  // the same moves the app makes: change the arrays, then commit
  dev.tick = (ms = 1000) => { dev.elapsed += ms; };
  dev.commit = (opts) => { dev.tick(); return dev.store.commit(dev.settings, dev.expenses, opts); };
  dev.add = (rec) => { dev.expenses.push({ currency: "AED", createdAt: dev.now(), category: "Other", ...rec }); return dev.commit(); };
  dev.edit = (id, patch) => { Object.assign(dev.expenses.find(e => e.id === id), patch); return dev.commit(); };
  dev.del = (id) => { dev.expenses = dev.expenses.filter(e => e.id !== id); return dev.commit(); };
  dev.get = (id) => dev.expenses.find(e => e.id === id);
  dev.ids = () => dev.expenses.map(e => e.id).sort();
  dev.syncNow = async () => { dev.tick(); await dev.sync.syncNow(); return dev.sync.status.state; };
  dev.connect = async () => { await dev.store.setMeta({ syncConnected: true }); return dev.syncNow(); };
  return dev;
}

export const tx = (id, aed, extra = {}) => ({ id, date: "2026-10-15", amount: aed, aed, method: "cbd", note: "Invented " + id, ...extra });
