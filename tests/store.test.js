import { test, assert } from "./harness.js";
import { Store, LEGACY_KEY } from "../js/store.js";
import { DEFAULTS, SAMPLES, normalize, memoryLocalStorage, uniqueDb } from "./devices.js";

const init = (s) => s.init({ defaults: DEFAULTS, samples: SAMPLES, normalizeSettings: normalize });

test("store: first run seeds the examples with stamp 0 and nothing pending", async () => {
  const s = new Store({ dbName: uniqueDb("seed"), localStorage: memoryLocalStorage() });
  const v = await init(s);
  assert.deep(v.expenses.map(e => [e.id, e.updatedAt]), [["ex0", 0], ["ex1", 0]]);
  assert.eq(s.pendingCount(), 0); assert.ok(s.info.seeded);
});

test("store: data survives closing and reopening (IndexedDB)", async () => {
  const db = uniqueDb("persist");
  const s1 = new Store({ dbName: db, localStorage: memoryLocalStorage() }); const v = await init(s1);
  v.expenses.push({ id: "n1", date: "2026-10-10", amount: 5, currency: "AED", aed: 5, method: "cash", category: "Other", note: "Invented", createdAt: 1 });
  v.settings.budgets.Groceries = 900;
  await s1.commit(v.settings, v.expenses); s1.close();
  const s2 = new Store({ dbName: db, localStorage: memoryLocalStorage() }); const v2 = await init(s2);
  assert.ok(v2.expenses.some(e => e.id === "n1" && e.updatedAt > 0));
  assert.eq(v2.settings.budgets.Groceries, 900);
  s2.close();
});

test("store: migrates data saved by the single-file version in localStorage", async () => {
  const legacy = { app: "card-cash-ledger", v: 1, savedAt: "2026-10-01T00:00:00Z",
    settings: { budgets: { Groceries: 1500 }, paid: { "cbd:2026-09-12": true }, rules: { "TESTMART": "Groceries" }, categories: ["Groceries", "Other", "Pets"], fx: { AED: 1, USD: 3.6725, INR: 0.0437 } },
    expenses: [{ id: "old1", date: "2026-09-30", amount: 77, currency: "AED", aed: 77, method: "enbd", category: "Groceries", note: "Invented old entry", createdAt: 5 },
               { id: "ex3", date: "2026-10-14", amount: 1, currency: "AED", aed: 1, method: "citi", category: "Other", note: "x", createdAt: 3, sample: true, _confirm: true }] };
  const ls = memoryLocalStorage({ [LEGACY_KEY]: JSON.stringify(legacy) });
  const db = uniqueDb("mig");
  const s = new Store({ dbName: db, localStorage: ls }); const v = await init(s);
  assert.ok(s.info.migrated);
  assert.deep(v.expenses.map(e => e.id), ["old1", "ex3"]);
  assert.eq(v.expenses[1]._confirm, undefined, "UI flags dropped");
  assert.eq(v.settings.budgets.Groceries, 1500); assert.eq(v.settings.fx.INR, 0.0437); assert.deep(v.settings.categories, ["Groceries", "Other", "Pets"]);
  assert.ok(s.pendingCount() > 0, "migrated data is queued for sync");
  assert.ok(ls.getItem(LEGACY_KEY), "old copy left in place as a fallback");
  assert.ok(ls.getItem(LEGACY_KEY + ".migrated"));
  s.close();
  // reopening doesn't migrate again (IndexedDB already has data)
  ls.setItem(LEGACY_KEY, JSON.stringify({ ...legacy, expenses: [] }));
  const s2 = new Store({ dbName: db, localStorage: ls }); const v2 = await init(s2);
  assert.ok(!s2.info.migrated); assert.eq(v2.expenses.length, 2); s2.close();
});

test("store: unreadable old localStorage data is reported, examples seeded", async () => {
  const s = new Store({ dbName: uniqueDb("bad"), localStorage: memoryLocalStorage({ [LEGACY_KEY]: "{not json" }) });
  const v = await init(s);
  assert.eq(s.info.migrateError, "unreadable"); assert.eq(v.expenses.length, 2); s.close();
});

test("store: only changed records get a new stamp; deletions leave a marker", async () => {
  let t = 1000;
  const s = new Store({ dbName: uniqueDb("stamp"), localStorage: memoryLocalStorage(), now: () => t });
  const v = await init(s);
  t = 2000; v.expenses[0].note = "Edited"; await s.commit(v.settings, v.expenses);
  assert.eq(v.expenses[0].updatedAt, 2000); assert.eq(v.expenses[1].updatedAt, 0);
  t = 3000; await s.commit(v.settings, v.expenses.filter(e => e.id !== "ex1"));
  assert.eq(s.syncState().tombstones.ex1, 3000);
  s.close();
});

test("store: two open tabs writing at once don't lose each other's changes", async () => {
  const db = uniqueDb("tabs");
  const a = new Store({ dbName: db, localStorage: memoryLocalStorage() }); const va = await init(a);
  const b = new Store({ dbName: db, localStorage: memoryLocalStorage() }); const vb = await init(b);
  va.expenses.push({ id: "fromA", date: "2026-10-01", amount: 1, currency: "AED", aed: 1, method: "cash", category: "Other", note: "", createdAt: 1 });
  vb.expenses.push({ id: "fromB", date: "2026-10-02", amount: 2, currency: "AED", aed: 2, method: "cash", category: "Other", note: "", createdAt: 2 });
  await Promise.all([a.commit(va.settings, va.expenses), b.commit(vb.settings, vb.expenses)]);
  const c = new Store({ dbName: db, localStorage: memoryLocalStorage() }); const vc = await init(c);
  assert.ok(vc.expenses.some(e => e.id === "fromA") && vc.expenses.some(e => e.id === "fromB"));
  a.close(); b.close(); c.close();
});
