// Local app + same-origin AI endpoint. Node 22+, no installed dependencies.
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const search = require("./api/search.js");
const message = require("./api/message.js");
const root = __dirname;
// DATA_DIR: writable, persistent location for sponsorship metrics on a host (e.g. a Render disk).
const dataDir = process.env.DATA_DIR || path.join(root, ".local");
const sponsors = require("./sponsorships.js").createHandler({ statsPath: path.join(dataDir, "sponsor-stats.json") });
// Local photo path -> original CDN URL. Hosts don't carry the 800MB photos/ folder,
// so a missing local photo redirects straight to its CDN copy (no failed request).
let photoMap = new Map(), photoMapMtime = 0;
function cdnFor(name) {
    try {
        const file = path.join(root, "data/listings.json"), mtime = fs.statSync(file).mtimeMs;
        if (mtime !== photoMapMtime) {
            photoMap = new Map();
            for (const l of JSON.parse(fs.readFileSync(file, "utf8")).listings) {
                Object.entries(l.photoFallbacks || {}).forEach(([k, v]) => v && photoMap.set("/" + k, v));
                (l.photos || []).forEach((k, i) => l.photosRemote?.[i] && !photoMap.has("/" + k) && photoMap.set("/" + k, l.photosRemote[i]));
            }
            photoMapMtime = mtime;
        }
    } catch { return null; }
    return photoMap.get(name) || null;
}
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
http.createServer(async (req, res) => {
    let name;
    try { name = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { res.writeHead(400); return res.end(); }
    if (name === "/api/search") return search(req, res);
    if (name === "/api/message") return message(req, res);
    if (["/api/sponsors", "/api/sponsors/event"].includes(name)) return sponsors(req, res);
    // Serve only public assets, not environment files, source tooling or git.
    if (name === "/") name = "/index.html";
    if (!(["/index.html", "/housing-search.js", "/eligibility.js", "/catalog.js"].includes(name) || /^\/(?:data|photos|assets)\/[\w./-]+$/.test(name)) || name.split("/").some(x => x.startsWith("."))) { res.writeHead(404); return res.end(); }
    const file = path.resolve(root, "." + name);
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
    try {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile()) throw new Error("not a file");
        res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Content-Length": stat.size,
            "Cache-Control": name.startsWith("/photos/") || name.startsWith("/assets/") ? "public, max-age=604800" : "no-cache" });
        fs.createReadStream(file).pipe(res);
    } catch {
        const cdn = name.startsWith("/photos/") && cdnFor(name);
        if (cdn) { res.writeHead(302, { Location: cdn, "Cache-Control": "public, max-age=86400" }); return res.end(); }
        res.writeHead(404); res.end();
    }
}).listen(Number(process.env.PORT) || 8788, process.env.HOST || "127.0.0.1", () => console.log("Hokie Housing: http://127.0.0.1:" + (process.env.PORT || 8788)));
