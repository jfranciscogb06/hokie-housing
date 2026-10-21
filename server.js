// Local app + same-origin AI endpoint. Node 22+, no installed dependencies.
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const search = require("./api/search.js");
const sponsors = require("./sponsorships.js").createHandler();
const root = __dirname;
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
http.createServer(async (req, res) => {
    let name;
    try { name = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch { res.writeHead(400); return res.end(); }
    if (name === "/api/search") return search(req, res);
    if (["/api/sponsors", "/api/sponsors/event"].includes(name)) return sponsors(req, res);
    // Serve only public assets, not environment files, source tooling or git.
    if (name === "/") name = "/index.html";
    if (!(["/index.html", "/housing-search.js", "/eligibility.js"].includes(name) || /^\/(?:data|photos|assets)\/[\w./-]+$/.test(name)) || name.split("/").some(x => x.startsWith("."))) { res.writeHead(404); return res.end(); }
    const file = path.resolve(root, "." + name);
    if (!file.startsWith(root + path.sep)) { res.writeHead(404); return res.end(); }
    try {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile()) throw new Error("not a file");
        res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Content-Length": stat.size });
        fs.createReadStream(file).pipe(res);
    } catch { res.writeHead(404); res.end(); }
}).listen(Number(process.env.PORT) || 8788, process.env.HOST || "127.0.0.1", () => console.log("Hokie Housing: http://127.0.0.1:" + (process.env.PORT || 8788)));
