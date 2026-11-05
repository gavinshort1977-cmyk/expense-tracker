import { test, assert } from "./harness.js";
import { deriveKey, encryptText, decryptText, newSalt, WrongPassphrase } from "../js/crypto.js";

test("crypto: encrypt/decrypt round trip; ciphertext hides the text", async () => {
  const salt = newSalt(), key = await deriveKey("correct horse battery staple", salt, 2000);
  const box = await encryptText(key, { salt }, "Invented note: Testmart 245.50");
  assert.ok(!atob(box.data).includes("Testmart"));
  assert.eq(await decryptText(key, box), "Invented note: Testmart 245.50");
});
test("crypto: wrong passphrase is rejected", async () => {
  const salt = newSalt();
  const box = await encryptText(await deriveKey("right one", salt, 2000), {}, "x");
  await assert.rejects(decryptText(await deriveKey("wrong one", salt, 2000), box), e => e instanceof WrongPassphrase);
});
test("crypto: tampered file is rejected", async () => {
  const salt = newSalt(), key = await deriveKey("pp", salt, 2000);
  const box = await encryptText(key, {}, "hello world");
  const raw = atob(box.data); box.data = btoa(String.fromCharCode(raw.charCodeAt(0) ^ 1) + raw.slice(1));
  await assert.rejects(decryptText(key, box), e => e instanceof WrongPassphrase);
});
test("crypto: derived key can't be exported", async () => {
  const key = await deriveKey("pp", newSalt(), 2000);
  assert.eq(key.extractable, false);
});
