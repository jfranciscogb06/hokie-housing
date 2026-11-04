// Local app + same-origin AI endpoint. Node 22+, no installed dependencies.
const http = require("node:http"), fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
const search = require("./api/search.js");
// Property contact happens in the student's own Gmail; no server sends mail.
function message(req, res) {
    req.resume();
    res.writeHead(410, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ code: "gmail_only", error: "Open a Gmail draft from the property page." }));
}
const root = __dirname;
// DATA_DIR: writable, persistent location for sponsorship metrics on a host (e.g. a Render disk).
const { storagePaths, ensureCampaigns } = require("./storage");
const storage = ensureCampaigns(storagePaths());
const sponsors = require("./sponsorships.js").createHandler(storage);
// Local photo path -> original CDN URL. Hosts don't carry the 800MB photos/ folder,
// so a missing local photo redirects straight to its CDN copy (no failed request).
let photoMap = new Map(), photoMapMtime = 0;
const gzCache = new Map();
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
async function handleRequest(req, res, handlers) {
    let name;
    try { name = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { res.writeHead(400); return res.end(); }
    if (name === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        return res.end(JSON.stringify({ ok: true }));
    }
    if (name === "/site-config.js") {
        const email = process.env.SUPPORT_EMAIL || "";
        const contactEmail = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email) ? email : "";
        res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
        return res.end("window.HOUSING_CONFIG = " + JSON.stringify({ contactEmail }) + ";");
    }
    if (name === "/api/search") return handlers.search(req, res);
    if (name === "/api/message") return handlers.message(req, res);
    if (["/api/sponsors", "/api/sponsors/event"].includes(name)) return handlers.sponsors(req, res);
    // Serve only public assets, not environment files, source tooling or git.
    if (name === "/" || name === "/privacy" || name === "/terms") name = "/index.html";
    const publicData = ["listings.js", "listings.json", "contacts.json", "amenities.json", "bt_stops.json"].map(x => "/data/" + x);
    if (!(["/index.html", "/housing-search.js", "/eligibility.js", "/catalog.js", "/contact-history.js", ...publicData].includes(name) || /^\/(?:photos|assets)\/[\w./-]+$/.test(name)) || name.split("/").some(x => x.startsWith("."))) { res.writeHead(404); return res.end(); }
    const file = path.resolve(root, "." + name);
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
    try {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile()) throw new Error("not a file");
        const type = types[path.extname(file)] || "application/octet-stream";
        const cache = name.startsWith("/photos/") || name.startsWith("/assets/") ? "public, max-age=604800" : "no-cache";
        // Text files (the 1.9MB catalog especially) go out gzipped: ~5x smaller on phones.
        if (/text|javascript|json/.test(type) && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
            const key = file + ":" + stat.mtimeMs;
            let body = gzCache.get(key);
            if (!body) { body = zlib.gzipSync(await fs.promises.readFile(file), { level: 6 }); gzCache.set(key, body); }
            res.writeHead(200, { "Content-Type": type, "Content-Encoding": "gzip", "Content-Length": body.length, "Cache-Control": cache, Vary: "Accept-Encoding" });
            return res.end(body);
        }
        res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Cache-Control": cache });
        fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
    } catch {
        const cdn = name.startsWith("/photos/") && cdnFor(name);
        if (cdn) { res.writeHead(302, { Location: cdn, "Cache-Control": "public, max-age=86400" }); return res.end(); }
        res.writeHead(404); res.end();
    }
}
function createServer(handlers = {}) {
    const routes = { search, message, sponsors, ...handlers };
    return http.createServer((req, res) => {
        Promise.resolve().then(() => handleRequest(req, res, routes)).catch(() => {
            if (res.headersSent) return res.destroy();
            res.writeHead(500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ error: "Unable to process this request." }));
        });
    });
}
if (require.main === module) createServer().listen(Number(process.env.PORT) || 8788, process.env.HOST || "127.0.0.1", () => console.log("Blacksburg Housing: http://127.0.0.1:" + (process.env.PORT || 8788)));
module.exports = { createServer };
