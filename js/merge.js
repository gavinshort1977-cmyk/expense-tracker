// Pure merge logic shared by local storage (multi-tab) and Google Drive sync.
//
// A "state" looks like:
//   { settings, expenses:[{id, ..., updatedAt}], tombstones:{id: deletedAt},
//     stamps:{path: changedAt}, clock }
//
// Transactions merge one by one by id: the newest version wins (last writer wins
// per transaction), and a deletion wins over any version older than it. Settings
// merge per entry (one card, one budget, one rate, one "paid" mark ...).
// merge(a,b) is commutative and idempotent, so devices converge whatever order
// they sync in.

export const MAP_SECTIONS = ["cards", "budgets", "fx", "paid", "rules"];

export function stableStringify(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).filter(k => v[k] !== undefined).sort()
    .map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

// The part of a record that counts as its content (ignores sync bookkeeping and UI flags)
export function recordBody(e) {
  const { updatedAt, _confirm, ...rest } = e;
  return stableStringify(rest);
}

// settings -> { pathKey: valueJSON }
export function flattenSettings(s) {
  const out = {};
  for (const [k, v] of Object.entries(s || {})) {
    if (MAP_SECTIONS.includes(k) && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [kk, vv] of Object.entries(v)) {
        if (vv === undefined) continue;
        out[JSON.stringify([k, kk])] = stableStringify(vv);
      }
    } else if (v !== undefined) {
      out[JSON.stringify([k])] = stableStringify(v);
    }
  }
  return out;
}

export function unflattenSettings(flat) {
  const s = {};
  for (const sec of MAP_SECTIONS) s[sec] = {};
  for (const [p, json] of Object.entries(flat)) {
    const path = JSON.parse(p);
    const val = JSON.parse(json);
    if (path.length === 2) { (s[path[0]] ||= {})[path[1]] = val; } else s[path[0]] = val;
  }
  return s;
}

function pickLive(a, b) {
  if (!a) return b; if (!b) return a;
  const ta = +a.updatedAt || 0, tb = +b.updatedAt || 0;
  if (ta !== tb) return ta > tb ? a : b;
  // same timestamp: deterministic choice so both sides agree
  return recordBody(a) >= recordBody(b) ? a : b;
}

export function mergeExpenses(aList, aTomb, bList, bTomb) {
  const A = new Map((aList || []).map(e => [e.id, e]));
  const B = new Map((bList || []).map(e => [e.id, e]));
  const ids = new Set([...A.keys(), ...B.keys(), ...Object.keys(aTomb || {}), ...Object.keys(bTomb || {})]);
  const expenses = [], tombstones = {};
  for (const id of ids) {
    const live = pickLive(A.get(id), B.get(id));
    const ta = (aTomb || {})[id], tb = (bTomb || {})[id];
    const tomb = ta == null ? tb : tb == null ? ta : Math.max(ta, tb);
    if (tomb != null && (!live || tomb >= (+live.updatedAt || 0))) tombstones[id] = tomb;
    else if (live) expenses.push(live);
  }
  return { expenses, tombstones };
}

export function mergeSettings(aSet, aStamps, bSet, bStamps) {
  const fa = flattenSettings(aSet), fb = flattenSettings(bSet);
  aStamps ||= {}; bStamps ||= {};
  const paths = new Set([...Object.keys(fa), ...Object.keys(fb), ...Object.keys(aStamps), ...Object.keys(bStamps)]);
  const flat = {}, stamps = {};
  for (const p of paths) {
    const sa = +aStamps[p] || 0, sb = +bStamps[p] || 0;
    let useA;
    if (sa !== sb) useA = sa > sb;
    else useA = (fa[p] ?? "") >= (fb[p] ?? ""); // tie: deterministic
    const val = useA ? fa[p] : fb[p];
    const st = Math.max(sa, sb);
    if (st) stamps[p] = st;
    if (val !== undefined) flat[p] = val;
  }
  return { settings: unflattenSettings(flat), stamps };
}

export function maxStamp(state) {
  let m = +state.clock || 0;
  for (const e of state.expenses || []) m = Math.max(m, +e.updatedAt || 0);
  for (const t of Object.values(state.tombstones || {})) m = Math.max(m, +t || 0);
  for (const t of Object.values(state.stamps || {})) m = Math.max(m, +t || 0);
  return m;
}

export function mergeStates(a, b) {
  if (!b) return a; if (!a) return b;
  const ex = mergeExpenses(a.expenses, a.tombstones, b.expenses, b.tombstones);
  const st = mergeSettings(a.settings, a.stamps, b.settings, b.stamps);
  const out = { settings: st.settings, stamps: st.stamps, expenses: ex.expenses, tombstones: ex.tombstones };
  out.clock = Math.max(maxStamp(a), maxStamp(b));
  return out;
}

// Canonical form used to test "are these two states the same data?"
export function canonical(state) {
  return stableStringify({
    settings: unflattenSettings(flattenSettings(state.settings)),
    stamps: state.stamps || {},
    expenses: [...(state.expenses || [])].map(({ _confirm, ...e }) => e).sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
    tombstones: state.tombstones || {},
  });
}

// Work out what changed between two snapshots and stamp it.
// prev: { settingsFlat, bodies: Map(id -> body) } ; returns changed keys for the pending list.
export function stampChanges(prev, state, tick, force) {
  const changed = [];
  const flat = flattenSettings(state.settings);
  const paths = new Set([...Object.keys(prev.settingsFlat), ...Object.keys(flat)]);
  for (const p of paths) {
    if (force || prev.settingsFlat[p] !== flat[p]) { state.stamps[p] = tick(); changed.push("s:" + p); }
  }
  const seen = new Set();
  for (const e of state.expenses) {
    seen.add(e.id);
    const body = recordBody(e);
    if (force || prev.bodies.get(e.id) !== body) {
      e.updatedAt = tick();
      delete state.tombstones[e.id];
      changed.push("e:" + e.id);
    }
  }
  for (const id of prev.bodies.keys()) {
    if (!seen.has(id)) { state.tombstones[id] = tick(); changed.push("e:" + id); }
  }
  return changed;
}

export function snapshotOf(state) {
  return {
    settingsFlat: flattenSettings(state.settings),
    bodies: new Map((state.expenses || []).map(e => [e.id, recordBody(e)])),
  };
}
