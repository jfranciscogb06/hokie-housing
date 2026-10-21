const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const { Readable } = require("node:stream");
const Message = require("../api/message");
const listings = JSON.parse(fs.readFileSync(require.resolve("../data/listings.json"))).listings;
const contacts = JSON.parse(fs.readFileSync(require.resolve("../data/contacts.json"))).managers;
const withEmail = listings.find(l => contacts[l.manager]);
const noEmail = listings.find(l => !l.email && !contacts[l.manager]);

function call(handler, body, { method = "POST", headers = {}, ip = "10.0.0.1" } = {}) {
    const req = Readable.from([typeof body === "string" ? body : JSON.stringify(body)]);
    Object.assign(req, { method, headers: { host: "localhost:8788", ...headers }, socket: { remoteAddress: ip } });
    return new Promise(resolve => {
        const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(s, h) { this.status = s; Object.assign(this.headers, h || {}); },
            end(b) { resolve({ status: this.status, body: b ? JSON.parse(b) : null }); } };
        handler(req, res);
    });
}
const good = (extra = {}) => ({ listingId: withEmail.id, kind: "info", name: "Alex Hokie", email: "alex@vt.edu", message: "Is the 2 bed still available for fall?", ...extra });
function mailer() {
    const sent = [];
    const fetchImpl = async (url, opts) => { sent.push({ url, ...JSON.parse(opts.body) }); return { ok: true, json: async () => ({ id: "msg_" + sent.length }) }; };
    return { sent, fetchImpl };
}
function configured(fn) {
    return async () => {
        const saved = { k: process.env.RESEND_API_KEY, f: process.env.MAIL_FROM };
        process.env.RESEND_API_KEY = "re_test"; process.env.MAIL_FROM = "Hokie Housing <messages@example.edu>";
        try { await fn(); } finally {
            if (saved.k === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved.k;
            if (saved.f === undefined) delete process.env.MAIL_FROM; else process.env.MAIL_FROM = saved.f;
        }
    };
}

test("the directory gives most listings a real recipient", () => {
    assert(withEmail && noEmail);
    const covered = listings.filter(l => l.email || contacts[l.manager]).length;
    assert(covered >= listings.length * 0.4, `${covered}/${listings.length}`);
    for (const c of Object.values(contacts)) assert.match(c.email, /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/);
});

test("sends to the property from the directory, replies go to the student, student gets a copy", configured(async () => {
    const m = mailer(), h = Message.createHandler({ fetchImpl: m.fetchImpl });
    const r = await call(h, good({ to: "victim@example.com", unit: "4x4 Balcony (4 bed / 4 bath)" }));
    assert.equal(r.status, 200); assert.equal(r.body.sent, true);
    assert.equal(m.sent.length, 2);
    const [toProperty, copy] = m.sent;
    assert.deepEqual(toProperty.to, [contacts[withEmail.manager].email]);   // never the client-supplied "to"
    assert.equal(toProperty.reply_to, "alex@vt.edu");
    assert.match(toProperty.subject, /Inquiry: 4x4 Balcony/);
    assert.match(toProperty.text, /Is the 2 bed still available/);
    assert.deepEqual(copy.to, ["alex@vt.edu"]);
}));

test("rejects bad input before sending anything", configured(async () => {
    const m = mailer(), h = Message.createHandler({ fetchImpl: m.fetchImpl });
    assert.equal((await call(h, good({ email: "alex@gmail.com" }))).status, 400);
    assert.equal((await call(h, good({ name: "" }))).status, 400);
    assert.equal((await call(h, good({ message: "hi" }))).status, 400);
    assert.equal((await call(h, good({ listingId: "nope" }))).status, 404);
    assert.equal((await call(h, good({ listingId: noEmail.id }))).body.code, "no_email");
    assert.equal((await call(h, good(), { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await call(h, "{not json")).status, 400);
    assert.equal((await call(h, good(), { method: "GET" })).status, 405);
    const bot = await call(h, good({ website: "http://spam" }));
    assert.equal(bot.status, 200);
    assert.equal(m.sent.length, 0);
}));

test("header injection in name/subject fields is flattened", () => {
    const c = Message.compose(good({ name: "Alex\r\nBcc: everyone@example.com", unit: "2 bed\nX-Evil: 1" }));
    assert(!/[\r\n]/.test(c.name)); assert(!/[\r\n]/.test(c.unit));
});

test("rate limits per sender and per IP", configured(async () => {
    const m = mailer(), h = Message.createHandler({ fetchImpl: m.fetchImpl });
    let last;
    for (let i = 0; i < Message.LIMITS.senderPerHour + 1; i++) last = await call(h, good({ email: "same@vt.edu" }), { ip: "10.9.9." + i });
    assert.equal(last.status, 429);
    for (let i = 0; i < Message.LIMITS.ipPerHour + 1; i++) last = await call(h, good({ email: `s${i}@vt.edu` }), { ip: "10.8.8.8" });
    assert.equal(last.status, 429);
}));

test("without mail settings the page is told to fall back to a draft, with the recipient", async () => {
    delete process.env.RESEND_API_KEY;
    const m = mailer(), h = Message.createHandler({ fetchImpl: m.fetchImpl });
    const r = await call(h, good());
    assert.equal(r.status, 503); assert.equal(r.body.code, "not_configured");
    assert.equal(r.body.to, contacts[withEmail.manager].email);
    assert.equal(m.sent.length, 0);
});

test("a mail-service failure reports send_failed so the page can fall back", configured(async () => {
    const h = Message.createHandler({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
    const r = await call(h, good({ email: "fail@vt.edu" }), { ip: "10.7.7.7" });
    assert.equal(r.status, 502); assert.equal(r.body.code, "send_failed");
}));
