// Sync tests against a mocked Google Drive. Several simulated devices share one
// MockDrive; each has its own storage, clock, network and token. Invented data only.
import { test, assert } from "./harness.js";
import { MockDrive } from "./mock-drive.js";
import { makeDevice, tx } from "./devices.js";
import { SYNC_FILE_NAME } from "../js/drive.js";

async function pair() {
  const drive = new MockDrive();
  const A = await makeDevice("A", drive), B = await makeDevice("B", drive);
  return { drive, A, B };
}

test("sync: first sync creates one clearly named file, readable JSON", async () => {
  const { drive, A } = await pair();
  await A.add(tx("t1", 50));
  assert.eq(await A.connect(), "idle");
  const files = drive.only();
  assert.eq(files.length, 1);
  assert.eq(files[0].name, SYNC_FILE_NAME);
  assert.eq(files[0].appProperties.cclSync, "1");
  const c = drive.contentJSON();
  assert.eq(c.format, "card-cash-ledger-sync"); assert.eq(c.encrypted, false);
  assert.ok(c.data.expenses.some(e => e.id === "t1"));
  assert.eq(c.data.pending, undefined, "device-only bookkeeping isn't uploaded");
  assert.eq(A.sync.status.pending, 0); assert.ok(A.sync.status.lastSync);
});

test("sync: second device picks up the first device's data and settings", async () => {
  const { A, B } = await pair();
  await A.add(tx("t1", 50)); A.settings.budgets.Groceries = 1200; await A.commit();
  await A.connect();
  await B.connect();
  assert.ok(B.get("t1")); assert.eq(B.settings.budgets.Groceries, 1200);
  assert.eq(B.drive && B.sync.status.state, "idle");
});

test("sync: different transactions edited offline on two devices are all kept", async () => {
  const { A, B } = await pair();
  await A.add(tx("t1", 10)); await A.add(tx("t2", 20)); await A.connect(); await B.connect();
  A.net.online = false; B.net.online = false;
  await A.edit("t1", { aed: 11, note: "edited on A" });
  await B.edit("t2", { aed: 22, note: "edited on B" });
  await B.add(tx("t3", 30));
  assert.eq(await A.syncNow(), "offline"); assert.ok(A.sync.status.pending > 0, "change queued while offline");
  A.net.online = true; B.net.online = true;
  await A.syncNow(); await B.syncNow(); await A.syncNow();
  for (const D of [A, B]) {
    assert.eq(D.get("t1").aed, 11, D.name + " t1"); assert.eq(D.get("t2").aed, 22, D.name + " t2"); assert.ok(D.get("t3"), D.name + " t3");
    assert.eq(D.sync.status.pending, 0, D.name + " nothing left waiting");
  }
});

test("sync: same transaction edited offline on both devices → the later edit wins everywhere", async () => {
  const { A, B } = await pair();
  await A.add(tx("t1", 10)); await A.connect(); await B.connect();
  A.net.online = false; B.net.online = false;
  await A.edit("t1", { aed: 100, note: "A's edit (earlier)" });
  A.tick(5000); B.tick(10000);
  await B.edit("t1", { aed: 200, note: "B's edit (later)" });
  A.net.online = true; B.net.online = true;
  await B.syncNow(); await A.syncNow(); await B.syncNow();
  assert.eq(A.get("t1").note, "B's edit (later)"); assert.eq(B.get("t1").note, "B's edit (later)");
  // and in the opposite upload order
  const p = await pair();
  await p.A.add(tx("t1", 10)); await p.A.connect(); await p.B.connect();
  p.A.net.online = p.B.net.online = false;
  await p.A.edit("t1", { note: "A earlier" }); p.B.tick(10000); await p.B.edit("t1", { note: "B later" });
  p.A.net.online = p.B.net.online = true;
  await p.A.syncNow(); await p.B.syncNow(); await p.A.syncNow();
  assert.eq(p.A.get("t1").note, "B later"); assert.eq(p.B.get("t1").note, "B later");
});

test("sync: deleted offline on one device, edited earlier on the other → stays deleted everywhere", async () => {
  const { A, B, drive } = await pair();
  await A.add(tx("t1", 10)); await A.add(tx("t2", 20)); await A.connect(); await B.connect();
  A.net.online = false; B.net.online = false;
  await B.edit("t1", { note: "B edits first" });
  A.tick(20000);
  await A.del("t1");
  A.net.online = true; B.net.online = true;
  await B.syncNow(); await A.syncNow(); await B.syncNow();
  assert.ok(!A.get("t1") && !B.get("t1"), "deleted on both");
  assert.ok(A.get("t2") && B.get("t2"), "other transaction untouched");
  assert.ok(drive.contentJSON().data.tombstones.t1 > 0, "deletion marker stored in Drive");
});

test("sync: deleted on one device, edited later on the other → the later edit brings it back", async () => {
  const { A, B } = await pair();
  await A.add(tx("t1", 10)); await A.connect(); await B.connect();
  A.net.online = false; B.net.online = false;
  await A.del("t1");
  B.tick(30000);
  await B.edit("t1", { note: "edited after A deleted it" });
  A.net.online = true; B.net.online = true;
  await A.syncNow(); await B.syncNow(); await A.syncNow();
  assert.eq(A.get("t1") && A.get("t1").note, "edited after A deleted it");
  assert.eq(B.get("t1").note, "edited after A deleted it");
});

test("sync: deletions on both devices and adds on both, all offline, converge", async () => {
  const { A, B } = await pair();
  for (const i of [1, 2, 3, 4]) await A.add(tx("t" + i, i));
  await A.connect(); await B.connect();
  A.net.online = B.net.online = false;
  await A.del("t1"); await B.del("t2"); await A.add(tx("a5", 5)); await B.add(tx("b6", 6)); await B.del("t1");
  A.net.online = B.net.online = true;
  await A.syncNow(); await B.syncNow(); await A.syncNow();
  const want = ["a5", "b6", "ex0", "ex1", "t3", "t4"];
  assert.deep(A.ids(), want); assert.deep(B.ids(), want);
});

test("sync: settings changed on two devices merge per entry", async () => {
  const { A, B } = await pair();
  await A.connect(); await B.connect();
  A.settings.budgets.Groceries = 1500; await A.commit();
  B.settings.cards.cbd = { statementDay: 12, dueDay: 6, limit: 9000 }; B.settings.paid["cbd:2026-10-12"] = true; await B.commit();
  await A.syncNow(); await B.syncNow(); await A.syncNow();
  for (const D of [A, B]) {
    assert.eq(D.settings.budgets.Groceries, 1500, D.name); assert.eq(D.settings.cards.cbd.statementDay, 12, D.name); assert.ok(D.settings.paid["cbd:2026-10-12"], D.name);
  }
  delete B.settings.paid["cbd:2026-10-12"]; await B.commit(); await B.syncNow(); await A.syncNow();
  assert.ok(!A.settings.paid["cbd:2026-10-12"], "un-marking paid syncs too");
});

test("sync: a device whose clock is an hour behind can still override after it has synced", async () => {
  const drive = new MockDrive();
  const A = await makeDevice("A", drive), B = await makeDevice("B", drive, { offsetMs: -3600000 });
  await A.add(tx("t1", 10)); await A.connect(); await B.connect();
  await B.edit("t1", { note: "B's newer edit, slow clock" });
  await B.syncNow(); await A.syncNow();
  assert.eq(A.get("t1").note, "B's newer edit, slow clock");
});

test("sync: examples cleared on one device don't come back from a new device", async () => {
  const { A, B } = await pair();
  await A.connect();
  A.expenses = A.expenses.filter(e => !e.sample); await A.commit(); await A.syncNow();
  await B.connect(); // B was seeded with the same examples on first run
  assert.deep(B.ids(), []); await A.syncNow(); assert.deep(A.ids(), []);
});

test("sync: another device writing at the same moment isn't overwritten", async () => {
  const { drive, A, B } = await pair();
  await A.add(tx("t1", 1)); await A.connect(); await B.connect();
  await A.add(tx("fromA", 2)); await B.add(tx("fromB", 3));
  // A downloads the file, then B's upload lands before A uploads; A must notice and merge again
  drive.afterDownload = async () => { await B.syncNow(); };
  await A.syncNow();
  const ids = drive.contentJSON().data.expenses.map(e => e.id);
  assert.ok(ids.includes("fromA") && ids.includes("fromB"), "both survive: " + ids);
  await B.syncNow();
  assert.ok(B.get("fromA") && A.get("fromB"));
});

test("sync: expired Google sign-in pauses sync, keeps changes waiting", async () => {
  const { drive, A } = await pair();
  await A.connect();
  drive.validTokens.delete("tok-A");
  await A.add(tx("t9", 9));
  assert.eq(await A.syncNow(), "needs-auth");
  assert.eq(A.token, null, "stale token forgotten");
  assert.ok(A.sync.status.pending > 0);
  drive.validTokens.add("tok-A2"); A.token = "tok-A2";
  assert.eq(await A.syncNow(), "idle"); assert.eq(A.sync.status.pending, 0);
  assert.ok(drive.contentJSON().data.expenses.some(e => e.id === "t9"));
});

test("sync: a change made while an upload is in flight stays queued", async () => {
  const { drive, A } = await pair();
  await A.connect();
  await A.add(tx("t1", 1));
  drive.beforeUpload = async () => { drive.beforeUpload = null; await A.edit("t1", { note: "changed mid-upload" }); };
  await A.syncNow();
  assert.ok(A.sync.status.pending >= 1, "edit made during the upload is still waiting");
  await A.syncNow();
  assert.eq(A.sync.status.pending, 0);
  assert.eq(drive.contentJSON().data.expenses.find(e => e.id === "t1").note, "changed mid-upload");
});

test("sync: if the Drive file is deleted, the next sync recreates it from this device", async () => {
  const { drive, A } = await pair();
  await A.add(tx("t1", 1)); await A.connect();
  drive.files.clear();
  assert.eq(await A.syncNow(), "idle");
  assert.eq(drive.only().length, 1); assert.ok(drive.contentJSON().data.expenses.some(e => e.id === "t1"));
});

test("sync: a damaged Drive file is reported and never overwritten", async () => {
  const { drive, A } = await pair();
  await A.connect();
  drive.only()[0].content = "this is not json";
  await A.add(tx("t1", 1));
  assert.eq(await A.syncNow(), "error");
  assert.ok(/couldn't be read/.test(A.sync.status.lastError.message));
  assert.eq(drive.only()[0].content, "this is not json");
});

test("sync: network failure mid-sync is treated as offline and retried later", async () => {
  const { drive, A } = await pair();
  await A.connect(); await A.add(tx("t1", 1));
  let n = 0; const orig = drive.handle.bind(drive);
  drive.handle = async (u, o) => { if (++n === 2) throw new TypeError("Failed to fetch"); return orig(u, o); };
  assert.eq(await A.syncNow(), "offline");
  assert.ok(A.sync.status.pending > 0);
  assert.eq(await A.syncNow(), "idle"); assert.eq(A.sync.status.pending, 0);
});

test("encryption: turning it on encrypts the Drive file; no readable data left in it", async () => {
  const { drive, A } = await pair();
  await A.add(tx("t1", 1, { note: "Invented secret merchant" })); await A.connect();
  await A.sync.setPassphrase("purple elephant tractor 42");
  assert.eq(A.sync.status.state, "idle");
  const raw = drive.only()[0].content, c = JSON.parse(raw);
  assert.eq(c.encrypted, true); assert.eq(c.kdf.name, "PBKDF2"); assert.eq(c.cipher, "AES-GCM");
  assert.ok(!raw.includes("Invented secret merchant") && !raw.includes("t1"), "no plaintext");
  assert.ok(!JSON.stringify(A.store.meta).includes("purple elephant"), "passphrase itself isn't stored");
});

test("encryption: other device must enter the passphrase; wrong one is refused and nothing is overwritten", async () => {
  const { drive, A, B } = await pair();
  await A.add(tx("t1", 1)); await A.connect(); await A.sync.setPassphrase("purple elephant tractor 42");
  await B.add(tx("fromB", 2));
  assert.eq(await B.connect(), "needs-passphrase");
  const before = drive.only()[0].content;
  await assert.rejects(B.sync.unlock("wrong passphrase!!"), e => e.name === "WrongPassphrase");
  assert.eq(drive.only()[0].content, before, "file untouched");
  await B.sync.unlock("purple elephant tractor 42");
  assert.eq(B.sync.status.state, "idle"); assert.ok(B.get("t1"));
  await A.syncNow(); assert.ok(A.get("fromB"), "B's data reached A through the encrypted file");
  assert.eq(JSON.parse(drive.only()[0].content).encrypted, true);
});

test("encryption: changing the passphrase on one device asks the other for the new one", async () => {
  const { A, B } = await pair();
  await A.connect(); await A.sync.setPassphrase("first passphrase 111");
  await B.connect(); await B.sync.unlock("first passphrase 111");
  await A.sync.setPassphrase("second passphrase 222");
  assert.eq(await B.syncNow(), "needs-passphrase");
  assert.ok(/changed on another device/.test(B.sync.status.lastError.message));
  await B.sync.unlock("second passphrase 222"); assert.eq(B.sync.status.state, "idle");
});

test("encryption: turning it off on one device makes the file plain and the other follows", async () => {
  const { drive, A, B } = await pair();
  await A.connect(); await A.sync.setPassphrase("first passphrase 111");
  await B.connect(); await B.sync.unlock("first passphrase 111");
  await A.sync.disableEncryption();
  assert.eq(drive.contentJSON().encrypted, false);
  await B.add(tx("afterOff", 1));
  assert.eq(await B.syncNow(), "idle");
  assert.eq(B.sync.encrypted, false); assert.eq(drive.contentJSON().encrypted, false);
  assert.ok(drive.contentJSON().data.expenses.some(e => e.id === "afterOff"));
});

test("encryption: turned on while offline, applied at the next sync", async () => {
  const { drive, A } = await pair();
  await A.connect(); A.net.online = false;
  await A.sync.setPassphrase("offline passphrase 1");
  assert.eq(drive.contentJSON().encrypted, false);
  A.net.online = true; await A.syncNow();
  assert.eq(drive.contentJSON().encrypted, true);
});

test("sync: disconnecting stops syncing and forgets the encryption key on this device", async () => {
  const { A } = await pair();
  await A.connect(); await A.sync.setPassphrase("some passphrase 99");
  await A.sync.disconnect();
  assert.eq(A.sync.status.state, "off"); assert.eq(A.store.getMeta("enc"), undefined);
  await A.add(tx("local", 1)); assert.eq(await A.syncNow(), "off");
});
