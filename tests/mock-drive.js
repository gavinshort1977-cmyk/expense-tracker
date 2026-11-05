// In-memory stand-in for the Google Drive v3 REST API, enough for js/drive.js.
// One MockDrive is "the user's Drive"; each simulated device gets its own fetch().
// Invented data only.

export class MockDrive {
  constructor() {
    this.files = new Map(); // id -> {id,name,version,modifiedTime,content,appProperties,trashed}
    this.seq = 0;
    this.log = [];
    this.validTokens = new Set(["tok-A", "tok-B", "tok-C"]);
    this.beforeUpload = null; // hooks to simulate another device writing at the same moment
    this.afterDownload = null;
  }

  // Returns a fetch() for one device. net.online=false makes it throw like a dropped connection.
  fetchFor(net = { online: true }) {
    return async (url, opts = {}) => {
      if (!net.online) throw new TypeError("Failed to fetch");
      return this.handle(url, opts);
    };
  }

  _res(status, body, type = "application/json") {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "Content-Type": type } });
  }
  _meta(f, fields) {
    const m = { id: f.id, name: f.name, version: String(f.version), modifiedTime: f.modifiedTime };
    if (fields && fields.includes("trashed")) m.trashed = !!f.trashed;
    return m;
  }

  async handle(url, opts) {
    const u = new URL(url);
    const method = (opts.method || "GET").toUpperCase();
    const auth = (opts.headers || {}).Authorization || "";
    this.log.push(method + " " + u.pathname + u.search);
    if (!this.validTokens.has(auth.replace("Bearer ", ""))) return this._res(401, { error: { message: "Invalid Credentials" } });

    const m = u.pathname.match(/^\/(upload\/)?drive\/v3\/files(?:\/([^/]+))?$/);
    if (!m) return this._res(400, { error: { message: "bad path" } });
    const isUpload = !!m[1], id = m[2] && decodeURIComponent(m[2]);
    const fields = u.searchParams.get("fields") || "";

    if (!isUpload && method === "GET" && !id) {
      const q = u.searchParams.get("q") || "";
      const wantProp = /appProperties has \{ key='cclSync' and value='1' \}/.test(q);
      const list = [...this.files.values()].filter(f => !f.trashed && (!wantProp || (f.appProperties || {}).cclSync === "1"))
        .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
      return this._res(200, { files: list.map(f => this._meta(f)) });
    }
    if (!isUpload && method === "GET" && id) {
      const f = this.files.get(id);
      if (!f) return this._res(404, { error: { message: "File not found" } });
      if (u.searchParams.get("alt") === "media") {
        const content = f.content;
        if (this.afterDownload) { const h = this.afterDownload; this.afterDownload = null; await h(); }
        return this._res(200, content);
      }
      return this._res(200, this._meta(f, fields));
    }
    if (isUpload && method === "POST") {
      if (this.beforeUpload) await this.beforeUpload();
      const body = String(opts.body);
      const boundary = /boundary=(\S+)/.exec((opts.headers || {})["Content-Type"])[1];
      const parts = body.split("--" + boundary).slice(1, -1).map(p => p.split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, ""));
      const meta = JSON.parse(parts[0]);
      const f = { id: "file" + (++this.seq), name: meta.name, appProperties: meta.appProperties, description: meta.description, version: 1, modifiedTime: this._now(), content: parts[1] };
      this.files.set(f.id, f);
      return this._res(200, this._meta(f));
    }
    if (isUpload && method === "PATCH" && id) {
      if (this.beforeUpload) await this.beforeUpload();
      const f = this.files.get(id);
      if (!f) return this._res(404, { error: { message: "File not found" } });
      f.content = String(opts.body); f.version++; f.modifiedTime = this._now();
      return this._res(200, this._meta(f));
    }
    return this._res(400, { error: { message: "unsupported" } });
  }
  _now() { this.tc = (this.tc || 0) + 1; return new Date(Date.now() + this.tc).toISOString(); }

  // test helpers
  only() { return [...this.files.values()].filter(f => !f.trashed); }
  contentJSON() { const f = this.only()[0]; return f ? JSON.parse(f.content) : null; }
}
