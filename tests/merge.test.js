import { test, assert } from "./harness.js";
import { mergeStates, canonical, flattenSettings, unflattenSettings } from "../js/merge.js";

const S = (expenses = [], tombstones = {}, settings = { budgets: {} }, stamps = {}) => ({ settings, stamps, expenses, tombstones, clock: 0 });
const r = (id, t, aed = 1) => ({ id, updatedAt: t, aed, date: "2026-10-01", method: "cash" });

test("merge: different transactions from two devices are all kept", () => {
  const m = mergeStates(S([r("a", 1), r("b", 2)]), S([r("c", 3)]));
  assert.deep(m.expenses.map(e => e.id).sort(), ["a", "b", "c"]);
});
test("merge: same transaction edited on both, the newer edit wins", () => {
  const m = mergeStates(S([r("a", 5, 10)]), S([r("a", 9, 20)]));
  assert.eq(m.expenses[0].aed, 20);
  assert.eq(mergeStates(S([r("a", 9, 20)]), S([r("a", 5, 10)])).expenses[0].aed, 20, "order doesn't matter");
});
test("merge: deletion newer than the edit removes it", () => {
  const m = mergeStates(S([r("a", 5)]), S([], { a: 7 }));
  assert.eq(m.expenses.length, 0); assert.eq(m.tombstones.a, 7);
});
test("merge: edit newer than the deletion keeps it", () => {
  const m = mergeStates(S([r("a", 8)]), S([], { a: 7 }));
  assert.eq(m.expenses.length, 1); assert.eq(m.tombstones.a, undefined);
});
test("merge: settings merge per entry (budgets from both devices, newest per key)", () => {
  const a = S([], {}, { budgets: { Groceries: 100, Fuel: 50 } }, { [JSON.stringify(["budgets", "Groceries"])]: 5, [JSON.stringify(["budgets", "Fuel"])]: 5 });
  const b = S([], {}, { budgets: { Groceries: 200, Home: 70 } }, { [JSON.stringify(["budgets", "Groceries"])]: 9, [JSON.stringify(["budgets", "Home"])]: 9, [JSON.stringify(["budgets", "Fuel"])]: 10 });
  const m = mergeStates(a, b);
  assert.deep(m.settings.budgets, { Groceries: 200, Home: 70 }, "Fuel was removed later on b");
});
test("merge: flatten/unflatten round trip keeps keys with slashes and odd characters", () => {
  const s = { cards: { cbd: { statementDay: 3 } }, budgets: { "Food/Drink": 1, 'Q"uote': 2 }, categories: ["a/b"], lastBackup: null, paid: {}, fx: {}, rules: {} };
  assert.deep(unflattenSettings(flattenSettings(s)).budgets, s.budgets);
  assert.deep(unflattenSettings(flattenSettings(s)).categories, s.categories);
});
test("merge: commutative, associative and idempotent on 300 random cases", () => {
  let seed = 42; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const gen = () => {
    const ex = [], tb = {}, stamps = {}, budgets = {};
    for (let i = 0; i < 6; i++) { const k = rnd(4); if (k === 1) ex.push(r("t" + i, rnd(20), rnd(5))); if (k === 2) tb["t" + i] = rnd(20); }
    for (const c of ["x", "y"]) { const k = rnd(3); const p = JSON.stringify(["budgets", c]); if (k) { stamps[p] = rnd(20); if (k === 1) budgets[c] = rnd(9); } }
    return S(ex, tb, { budgets }, stamps);
  };
  for (let i = 0; i < 300; i++) {
    const a = gen(), b = gen(), c = gen();
    assert.eq(canonical(mergeStates(a, b)), canonical(mergeStates(b, a)), "commutative #" + i);
    assert.eq(canonical(mergeStates(mergeStates(a, b), c)), canonical(mergeStates(a, mergeStates(b, c))), "associative #" + i);
    const ab = mergeStates(a, b);
    assert.eq(canonical(mergeStates(ab, ab)), canonical(ab), "idempotent #" + i);
  }
});
