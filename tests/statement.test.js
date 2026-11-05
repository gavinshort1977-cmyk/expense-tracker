// Statement import tests with synthetic PDFs (tools/make_fixtures.py) and CSVs. Invented data only.
import { test, assert } from "./harness.js";
import { pdfLines, lineToTx, finishTxs, parseStatementCsv, setCategorizer } from "../js/statement.js";

const expected = () => fetch("fixtures/statements-expected.json").then(r => r.json());
const bytes = name => fetch("fixtures/" + name).then(r => r.arrayBuffer()).then(b => new Uint8Array(b));
// the same steps the import form runs
async function readPdf(name, password) {
  const lines = await pdfLines(await bytes(name), password);
  const flat = lines.map(c => c.join("  "));
  return finishTxs(lines.map(lineToTx).filter(Boolean), flat);
}
const pick = t => ({ date: t.date, description: t.description, aed: t.aed, amount: t.amount, currency: t.currency, type: t.type });

setCategorizer(d => /HYPERMARKET/.test(d) ? "Groceries" : "Other");

for (const f of ["statement-a-aes256.pdf", "statement-a-rc4.pdf", "statement-a-plain.pdf"]) {
  test("pdf: " + f + " is unlocked and every transaction read correctly", async () => {
    const exp = await expected();
    const res = await readPdf(f, f.includes("plain") ? "" : exp.password);
    assert.eq(res.statementDate, exp.a.statementDate, "statement date");
    assert.eq(res.dueDate, exp.a.dueDate, "due date");
    assert.deep(res.txs.map(pick), exp.a.txs);
    assert.eq(res.txs[0].category, "Groceries", "categoriser applied");
  });
}

test("pdf: two-page AES-128 statement with year-less dates across New Year", async () => {
  const exp = await expected();
  const res = await readPdf("statement-b-aes128.pdf", exp.password);
  assert.eq(res.statementDate, exp.b.statementDate); assert.eq(res.dueDate, exp.b.dueDate);
  assert.deep(res.txs.map(pick), exp.b.txs);
});

test("pdf: missing password → asks for it (PasswordException code 1)", async () => {
  const e = await assert.rejects(readPdf("statement-a-aes256.pdf", ""), e => e.name === "PasswordException");
  assert.eq(e.code, 1);
});

test("pdf: wrong password → 'didn't open' (PasswordException code 2)", async () => {
  const e = await assert.rejects(readPdf("statement-a-rc4.pdf", "not-the-password"), e => e.name === "PasswordException");
  assert.eq(e.code, 2);
});

test("pdf: reader loads from the app's own files, not a CDN", async () => {
  await readPdf("statement-a-plain.pdf", "");
  const urls = performance.getEntriesByType("resource").map(r => r.name).filter(u => /pdf(\.worker)?\.min\.mjs/.test(u));
  assert.ok(urls.length > 0, "pdf.js was loaded");
  assert.ok(urls.every(u => u.startsWith(location.origin)), "all local: " + urls.join(", "));
});

test("csv: bank CSV with debit/credit columns", async () => {
  const csv = "Transaction Date,Description,Debit,Credit\n" +
    "02/10/2026,PRETEND CAFE JUMEIRAH,38.00,\n" +
    "03/10/2026,REFUND TESTMART,,45.50\n" +
    "05/10/2026,PAYMENT RECEIVED THANK YOU,,500.00\n";
  const r = parseStatementCsv(csv);
  assert.deep(r.txs.map(t => [t.date, t.aed, t.type]), [["2026-10-02", 38, "charge"], ["2026-10-03", 45.5, "credit"], ["2026-10-05", 500, "payment"]]);
});
