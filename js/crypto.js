// Optional passphrase encryption of the Drive sync file (Web Crypto API).
// PBKDF2-SHA-256 turns the passphrase into an AES-256-GCM key. The passphrase is
// never stored; this device keeps only the derived key, marked non-extractable.
// There is no way to recover the data if the passphrase is lost.

export const DEFAULT_ITERATIONS = 600000;
const enc = new TextEncoder(), dec = new TextDecoder();

export const b64 = {
  from(buf) { let s = ""; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); },
  to(str) { const s = atob(str); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; },
};

export function newSalt() { return b64.from(crypto.getRandomValues(new Uint8Array(16))); }

export async function deriveKey(passphrase, saltB64, iterations = DEFAULT_ITERATIONS) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: b64.to(saltB64), iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptText(key, kdf, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
  return { kdf, cipher: "AES-GCM", iv: b64.from(iv), data: b64.from(ct) };
}

export class WrongPassphrase extends Error { constructor() { super("wrong-passphrase"); this.name = "WrongPassphrase"; } }

export async function decryptText(key, box) {
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.to(box.iv) }, key, b64.to(box.data));
    return dec.decode(pt);
  } catch (_) { throw new WrongPassphrase(); }
}
