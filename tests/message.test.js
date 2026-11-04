const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const { Readable } = require("node:stream");
const Message = require("../api/message");
const listings = JSON.parse(fs.readFileSync(require.resolve("../data/listings.json"))).listings;
const contacts = JSON.parse(fs.readFileSync(require.resolve("../data/contacts.json"))).managers;
const withEmail = listings.find(l => contacts[l.manager]);
const noEmail = listings.find(l => !l.email && !contacts[l.manager]);

function call(handler, body, { method = "POST", headers = {}, ip = "10.0.0.1" } = {}) {
    const req = Readable.from([typeof body === "string" ? body : JSON.stringify(body)]);
    Object.assign(req, { method, headers: { host: "localhost:8788", ...(body && typeof body === "object" ? { authorization: `Bearer user:${body.email}` } : {}), ...headers }, socket: { remoteAddress: ip } });
    return new Promise((resolve, reject) => {
        const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, writeHead(s, h) { this.status = s; Object.assign(this.headers, h || {}); },
            end(b) { resolve({ status: this.status, body: b ? JSON.parse(b) : null }); } };
        Promise.resolve(handler(req, res)).catch(reject);
    });
}
const good = (extra = {}) => ({ listingId: withEmail.id, kind: "info", name: "Alex Hokie", email: "alex@vt.edu", message: "Is the 2 bed still available for fall?", ...extra });
function user(email = "alex@vt.edu") {
    return { id: email, email, email_confirmed_at: "2026-10-01T00:00:00Z", identities: [{ provider: "google", identity_data: { email, email_verified: true } }] };
}
function mailer() {
    const sent = [];
    const fetchImpl = async (url, opts) => { if (url.endsWith("/auth/v1/user")) return { ok: true, json: async () => user(opts.headers.Authorization.replace("Bearer user:", "")) }; sent.push({ url, ...JSON.parse(opts.body) }); return { ok: true, json: async () => ({ id: "msg_" + sent.length }) }; };
    return { sent, fetchImpl };
}
function configured(fn) {
    return async () => {
        const keys = ["RESEND_API_KEY", "MAIL_FROM", "SUPABASE_URL", "SUPABASE_ANON_KEY", "TRUST_PROXY_HOPS"];
        const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
        Object.assign(process.env, { RESEND_API_KEY: "re_test", MAIL_FROM: "Hokie Housing <messages@example.edu>", SUPABASE_URL: "https://project.supabase.co", SUPABASE_ANON_KEY: "public-test-key", TRUST_PROXY_HOPS: "0" });
        try { await fn(); } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
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
    assert.equal(bot.status, 400);
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
    const h = Message.createHandler({ fetchImpl: async (url) => url.endsWith("/auth/v1/user") ? { ok: true, json: async () => user("fail@vt.edu") } : { ok: false, status: 500 } });
    const r = await call(h, good({ email: "fail@vt.edu" }), { ip: "10.7.7.7" });
    assert.equal(r.status, 502); assert.equal(r.body.code, "send_failed");
}));


test("malformed JSON values and non-string fields return 400 without sending", configured(async () => {
    const m = mailer(), h = Message.createHandler({ fetchImpl: m.fetchImpl });
    for (const input of [null, [], 3, true, '"text"', good({ listingId: { toString: 1 } }), good({ email: {} }), good({ message: [] }), good({ website: {} })]) {
        assert.equal((await call(h, input)).status, 400, JSON.stringify(input));
    }
    assert.equal((await call(h, " ".repeat(8001))).status, 400);
    assert.equal(m.sent.length, 0);
}));

test("mail keys alone cannot enable direct sending without server auth configuration", configured(async () => {
    delete process.env.SUPABASE_URL;
    const m = mailer(), r = await call(Message.createHandler({ fetchImpl: m.fetchImpl }), good());
    assert.equal(r.status, 503); assert.equal(r.body.code, "not_configured"); assert.equal(m.sent.length, 0);
}));

test("missing, expired, unconfirmed or mismatched identities cannot send mail", configured(async () => {
    const m = mailer();
    assert.equal((await call(Message.createHandler({ fetchImpl: m.fetchImpl }), good(), { headers: { authorization: "" } })).body.code, "verification_required");
    const invalidUsers = [null, { ...user(), email_confirmed_at: null }, user("other@gmail.com"), { ...user(), identities: [] }, { ...user(), identities: [{ provider: "google", identity_data: { email: "other@vt.edu", email_verified: true } }] }];
    for (const identity of invalidUsers) {
        const h = Message.createHandler({ fetchImpl: async url => {
            assert(url.endsWith("/auth/v1/user")); return identity ? { ok: true, json: async () => identity } : { ok: false, status: 401 };
        } });
        assert.equal((await call(h, good())).body.code, "verification_required");
    }
    const mismatch = await call(Message.createHandler({ fetchImpl: async () => ({ ok: true, json: async () => user("owner@vt.edu") }) }), good());
    assert.equal(mismatch.status, 403); assert.equal(mismatch.body.code, "email_mismatch");
    assert.equal(m.sent.length, 0);
}));

test("forged forwarded headers cannot bypass the default per-IP limit", configured(async () => {
    const m = mailer(), h = Message.createHandler({ fetchImpl: m.fetchImpl });
    for (let i = 0; i < Message.LIMITS.ipPerHour; i++) {
        assert.equal((await call(h, good({ email: `student${i}@vt.edu` }), { headers: { "x-forwarded-for": `198.51.100.${i}` } })).status, 200);
    }
    assert.equal((await call(h, good({ email: "extra@vt.edu" }), { headers: { "x-forwarded-for": "198.51.100.99" } })).status, 429);
    assert.equal(m.sent.length, Message.LIMITS.ipPerHour * 2);
}));

test("auth outage fails closed and a failed student copy is reported accurately", configured(async () => {
    const unavailable = Message.createHandler({ fetchImpl: async () => { throw Error("offline"); } });
    assert.equal((await call(unavailable, good())).body.code, "verification_unavailable");
    let mail = 0;
    const copyFails = Message.createHandler({ fetchImpl: async url => {
        if (url.endsWith("/auth/v1/user")) return { ok: true, json: async () => user() };
        return ++mail === 1 ? { ok: true, json: async () => ({ id: "accepted" }) } : { ok: false, status: 503 };
    } });
    const r = await call(copyFails, good());
    assert.equal(r.status, 200); assert.equal(r.body.outcome, "submitted"); assert.equal(r.body.copySent, false);
}));
