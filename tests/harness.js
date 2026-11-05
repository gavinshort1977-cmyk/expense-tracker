// Tiny test harness: test(), assert helpers, and a runner that prints to the page.
const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }
export class AssertionError extends Error {}
export const assert = {
  ok(v, msg) { if (!v) throw new AssertionError(msg || "expected truthy, got " + JSON.stringify(v)); },
  eq(a, b, msg) { if (a !== b) throw new AssertionError((msg ? msg + ": " : "") + "expected " + JSON.stringify(b) + ", got " + JSON.stringify(a)); },
  deep(a, b, msg) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new AssertionError((msg ? msg + ": " : "") + "\n expected " + y + "\n got      " + x); },
  async rejects(p, check, msg) { try { await p; } catch (e) { if (check && !check(e)) throw new AssertionError((msg || "wrong error") + ": " + e); return e; } throw new AssertionError(msg || "expected rejection"); },
};
export async function run(filter) {
  const out = document.getElementById("out");
  const results = [];
  for (const t of tests) {
    if (filter && !t.name.includes(filter)) continue;
    const t0 = performance.now();
    let err = null;
    try { await t.fn(); } catch (e) { err = e; }
    const r = { name: t.name, ok: !err, ms: Math.round(performance.now() - t0), error: err ? String(err && err.stack || err) : null };
    results.push(r);
    const li = document.createElement("li");
    li.className = r.ok ? "pass" : "fail";
    li.textContent = (r.ok ? "✓ " : "✗ ") + t.name + (r.ok ? "" : "\n    " + r.error);
    out.appendChild(li);
  }
  const failed = results.filter(r => !r.ok).length;
  document.getElementById("sum").textContent = `${results.length - failed} passed, ${failed} failed`;
  window.__results = { done: true, passed: results.length - failed, failed, results };
  return window.__results;
}
