// POST /api/message — deliver a student's Request info / tour message to the property.
// The recipient comes from data/contacts.json on the server (never from the browser),
// so this can't be used to email arbitrary addresses. Replies go to the student
// (Reply-To), and the student gets a copy. Sends through Resend when RESEND_API_KEY
// and MAIL_FROM are set; otherwise answers 503 not_configured and the page falls back
// to a prefilled Gmail draft addressed to the same recipient.
const fs = require("node:fs"), path = require("node:path");
const root = path.join(__dirname, "..");
const perIp = new Map(), perSender = new Map();
let daily = { day: "", count: 0 };
const LIMITS = { ipPerHour: 6, senderPerHour: 4, perDay: 300 };

function load(file) {
    const full = path.join(root, file), m = fs.statSync(full).mtimeMs;
    load.cache ||= {};
    if (load.cache[file]?.m !== m) load.cache[file] = { m, data: JSON.parse(fs.readFileSync(full, "utf8")) };
    return load.cache[file].data;
}
/* Listing ID -> { email, name } using the manager directory. */
function recipientFor(listingId) {
    const listing = load("data/listings.json").listings.find((l) => String(l.id) === String(listingId));
    if (!listing) return { listing: null, to: null };
    const managers = load("data/contacts.json").managers || {};
    const hit = listing.email ? { email: listing.email } : managers[listing.manager] || null;
    return { listing, to: hit?.email || null };
}
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
const oneLine = (v, max) => clean(v, max).replace(/[\r\n]+/g, " ");
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function allow(map, key, max, now) {
    const e = map.get(key);
    if (!e || now - e.start > 3600000) { map.set(key, { start: now, count: 1 }); return true; }
    if (e.count >= max) return false;
    e.count++; return true;
}
function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
}
async function readJson(req) {
    let body = "";
    for await (const chunk of req) { body += chunk; if (body.length > 8000) throw new Error("too large"); }
    return JSON.parse(body);
}
/* Validated message fields, or an error string. */
function compose(input) {
    const name = oneLine(input.name, 80), email = oneLine(input.email, 120).toLowerCase();
    const message = clean(input.message, 2000), kind = input.kind === "tour" ? "tour" : "info";
    if (name.length < 2) return { error: "Add your name." };
    if (!/^[^\s@]+@vt\.edu$/.test(email)) return { error: "Use your @vt.edu email so the property can reply." };
    if (message.length < 10) return { error: "Write a short message." };
    return { name, email, message, kind, phone: oneLine(input.phone, 30), moveIn: oneLine(input.moveIn, 40),
        tourWhen: oneLine(input.tourWhen, 60), unit: oneLine(input.unit, 160) };
}
async function deliver({ to, from, replyTo, subject, text, html }, { apiKey, fetchImpl = fetch }) {
    const r = await fetchImpl("https://api.resend.com/emails", {
        method: "POST", signal: AbortSignal.timeout(10000),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, text, html }),
    });
    if (!r.ok) throw new Error(`mail ${r.status}`);
    return (await r.json()).id || null;
}
function createHandler({ fetchImpl = fetch, now = () => Date.now() } = {}) {
    return async function handler(req, res) {
        if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Use POST." }); }
        if (req.headers.origin) {
            try { if (new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: "Send messages from this site." }); }
            catch { return send(res, 403, { error: "Invalid origin." }); }
        }
        let input;
        try { input = await readJson(req); } catch { return send(res, 400, { error: "Invalid message." }); }
        if (input.website) return send(res, 200, { sent: true }); // honeypot field: bots fill it, people never see it
        const { listing, to } = recipientFor(input.listingId);
        if (!listing) return send(res, 404, { error: "That listing isn't in the catalog anymore." });
        if (!to) return send(res, 422, { error: "This property hasn't published an email. Call or text them instead.", code: "no_email" });
        const m = compose(input);
        if (m.error) return send(res, 400, { error: m.error });
        const apiKey = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM;
        if (!apiKey || !from) return send(res, 503, { error: "Direct sending isn't set up yet.", code: "not_configured", to });
        const t = now(), day = new Date(t).toISOString().slice(0, 10);
        if (daily.day !== day) daily = { day, count: 0 };
        const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "?").split(",")[0].trim();
        if (daily.count >= LIMITS.perDay || !allow(perIp, ip, LIMITS.ipPerHour, t) || !allow(perSender, m.email, LIMITS.senderPerHour, t))
            return send(res, 429, { error: "Too many messages right now. Try again in an hour, or call the property." });
        daily.count++;
        const what = m.unit ? `${m.unit} at ${listing.name}` : listing.name;
        const subject = `${m.kind === "tour" ? "Tour request" : "Inquiry"}: ${what}`.slice(0, 200);
        const lines = [m.message, "",
            m.kind === "tour" && m.tourWhen ? `Preferred tour time: ${m.tourWhen}` : null,
            m.moveIn ? `Move-in: ${m.moveIn}` : null,
            m.unit ? `Unit: ${m.unit}` : null,
            `From: ${m.name} <${m.email}>${m.phone ? ` · ${m.phone}` : ""}`,
            `Listing: ${listing.name}${listing.address ? `, ${listing.address}` : ""}`, "",
            "Reply to this email to answer the student directly.",
            "Sent through Hokie Housing, an independent student housing search for Virginia Tech."].filter((x) => x !== null);
        const text = lines.join("\n");
        const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${lines.map((l) => (l ? esc(l) : "&nbsp;")).join("<br>")}</div>`;
        try {
            const id = await deliver({ to, from, replyTo: m.email, subject, text, html }, { apiKey, fetchImpl });
            // The student's copy also tells the real owner of that address if someone used it without asking.
            await deliver({ to: m.email, from, replyTo: to, subject: `Sent: ${subject}`, text: `Your message was sent to ${listing.manager || listing.name}. Their reply will come to this address.\n\n---\n${text}`,
                html: `<p>Your message was sent to ${esc(listing.manager || listing.name)}. Their reply will come to this address.</p><hr>${html}` }, { apiKey, fetchImpl }).catch(() => null);
            return send(res, 200, { sent: true, id, toName: listing.manager || listing.name });
        } catch {
            daily.count--;
            return send(res, 502, { error: "The message couldn't be sent. Try again, or call the property.", code: "send_failed", to });
        }
    };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.compose = compose;
module.exports.recipientFor = recipientFor;
module.exports.LIMITS = LIMITS;
