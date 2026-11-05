// Google sign-in for Drive sync, entirely in the browser with Google Identity
// Services (token model). No client secret, no backend. The access token lasts
// about an hour and is kept only on this device.

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GIS_SRC = "https://accounts.google.com/gsi/client";

export class AuthError extends Error { constructor(kind, detail) { super(kind + (detail ? ": " + detail : "")); this.name = "AuthError"; this.kind = kind; } }

export class GoogleAuth {
  constructor({ clientId, store, now = () => Date.now() }) {
    this.clientId = clientId; this.store = store; this.now = now; this.lib = null;
  }

  // Load the Google library ahead of time so the sign-in popup opens straight from a tap
  load() {
    if (this.lib) return this.lib;
    this.lib = new Promise((res, rej) => {
      if (window.google && google.accounts && google.accounts.oauth2) return res(google.accounts.oauth2);
      const s = document.createElement("script");
      s.src = GIS_SRC; s.async = true;
      const t = setTimeout(() => { this.lib = null; rej(new AuthError("load")); }, 20000);
      s.onload = () => { clearTimeout(t); window.google && google.accounts ? res(google.accounts.oauth2) : (this.lib = null, rej(new AuthError("load"))); };
      s.onerror = () => { clearTimeout(t); this.lib = null; s.remove(); rej(new AuthError("load")); };
      document.head.appendChild(s);
    });
    return this.lib;
  }
  loaded() { return !!(window.google && google.accounts && google.accounts.oauth2); }

  // Valid token if we have one, otherwise null (never opens a popup)
  token() {
    const t = this.store.getMeta("token"), exp = this.store.getMeta("tokenExp") || 0;
    return t && exp - 60000 > this.now() ? t : null;
  }

  // Must be called from a click/tap. Opens Google's popup.
  connect() {
    return new Promise((res, rej) => {
      const go = oauth2 => {
        const client = oauth2.initTokenClient({
          client_id: this.clientId,
          scope: DRIVE_SCOPE,
          callback: async resp => {
            if (resp.error) return rej(new AuthError(resp.error === "access_denied" ? "denied" : "failed", resp.error_description || resp.error));
            if (!oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) return rej(new AuthError("scope"));
            await this.store.setMeta({ token: resp.access_token, tokenExp: this.now() + (+resp.expires_in || 3600) * 1000, everConnected: true });
            res(resp.access_token);
          },
          error_callback: err => rej(new AuthError(err && err.type === "popup_failed_to_open" ? "popup" : err && err.type === "popup_closed" ? "closed" : "failed", err && err.type)),
        });
        client.requestAccessToken({ prompt: this.store.getMeta("everConnected") ? "" : "consent" });
      };
      if (this.loaded()) go(google.accounts.oauth2);
      else this.load().then(go, rej);
    });
  }

  async forgetToken() { await this.store.setMeta({ token: undefined, tokenExp: undefined }); }

  async disconnect() {
    const t = this.store.getMeta("token");
    try { if (t && this.loaded()) google.accounts.oauth2.revoke(t, () => {}); } catch (_) {}
    await this.store.setMeta({ token: undefined, tokenExp: undefined, everConnected: undefined });
  }
}
