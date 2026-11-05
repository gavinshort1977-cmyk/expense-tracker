// Minimal Google Drive v3 REST client, used only with the drive.file scope
// (the app can see only files it created itself). fetch is injectable for tests.

export const SYNC_FILE_NAME = "Card & Cash Ledger - sync data.json";
export const SYNC_FILE_DESCRIPTION =
  "Sync data for the Card & Cash Ledger app. Don't edit this file. Deleting it (and emptying Drive's bin) resets sync; each device then uploads its own data again.";
const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FIELDS = "id,name,version,modifiedTime";

export class DriveError extends Error {
  constructor(kind, status, detail) { super(kind + (status ? " " + status : "") + (detail ? ": " + detail : "")); this.name = "DriveError"; this.kind = kind; this.status = status; }
}

export class DriveClient {
  constructor({ fetch: f = (...a) => globalThis.fetch(...a), getToken }) { this.fetch = f; this.getToken = getToken; }

  async _call(url, opts = {}, want = "json") {
    const token = await this.getToken();
    if (!token) throw new DriveError("auth");
    let r;
    try {
      r = await this.fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + token } });
    } catch (e) { throw new DriveError("network", 0, e && e.message); }
    if (r.status === 401) throw new DriveError("auth", 401);
    if (r.status === 404) throw new DriveError("notfound", 404);
    if (r.status === 403 || r.status === 429) {
      let msg = ""; try { msg = (await r.json()).error.message; } catch (_) {}
      throw new DriveError(/rate|quota|limit/i.test(msg) || r.status === 429 ? "ratelimit" : "forbidden", r.status, msg);
    }
    if (!r.ok) throw new DriveError("http", r.status);
    return want === "text" ? r.text() : r.json();
  }

  async find() {
    const q = "appProperties has { key='cclSync' and value='1' } and trashed=false";
    const u = API + "?spaces=drive&orderBy=modifiedTime desc&pageSize=10&fields=files(" + FIELDS + ")&q=" + encodeURIComponent(q);
    const r = await this._call(u);
    return (r.files && r.files[0]) || null;
  }
  meta(id) { return this._call(API + "/" + encodeURIComponent(id) + "?fields=" + FIELDS + ",trashed"); }
  download(id) { return this._call(API + "/" + encodeURIComponent(id) + "?alt=media", {}, "text"); }

  create(text) {
    const boundary = "ccl" + Math.random().toString(36).slice(2);
    const metadata = { name: SYNC_FILE_NAME, mimeType: "application/json", description: SYNC_FILE_DESCRIPTION, appProperties: { cclSync: "1" } };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    return this._call(UPLOAD + "?uploadType=multipart&fields=" + FIELDS, { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body });
  }
  update(id, text) {
    return this._call(UPLOAD + "/" + encodeURIComponent(id) + "?uploadType=media&fields=" + FIELDS, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: text });
  }
}
