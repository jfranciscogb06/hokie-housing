const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const Search = require("../housing-search"), Eligibility = require("../eligibility"), Catalog = require("../catalog"), api = require("../api/search");
const raw = JSON.parse(fs.readFileSync(require.resolve("../data/listings.json"))).listings;
const listings = raw.map(l => ({ ...l, eligibility: Eligibility.of(l) }));
test("natural commute searches use driving data, not an accidental walk filter", () => {
    for (const q of ["5min drive away from campus", "within 5 minutes driving from campus", "five minute drive from campus", "drive to campus in 5 minutes"]) {
        const p = Search.local(q);
        assert.equal(p.spec.maxDrive, 5, q);
        assert.equal(p.spec.maxWalk, null, q);
        assert.equal(p.text, "", q);
        const matches = listings.filter(p.filter);
        assert(matches.length > 0);
        assert(matches.every(l => l.driveMin <= 5));
        assert(matches.some(l => l.walk > 25));
    }
    const p = Search.local("10 minute walk to campus under $1000");
    assert.equal(p.spec.maxWalk, 10);
    assert.equal(p.spec.maxPrice, 1000);
    assert.equal(p.text, "");
    assert.equal(p.filter({ walk: null, price: 700 }), false);
    assert.equal(Search.local("5 min drive").filter({ driveMin: null }), false);
});
test("combined budget, exact beds, amenities, negations and number words", () => {
    const p = Search.local("find me two bedrooms with a gym for an undergrad under $1,500");
    assert.equal(p.spec.maxPrice, 1500); assert.equal(p.spec.minBeds, 2); assert.equal(p.spec.maxBeds, 2);
    assert.equal(p.spec.audience, "undergrad"); assert.deepEqual(p.spec.amenities, ["gym"]); assert.equal(p.text, "");
    assert.equal(Search.local("no pets and unfurnished under 1000").spec.pets, false);
    assert.equal(Search.local("no pets and unfurnished under 1000").spec.furnished, false);
    assert.equal(Search.local("at least 3 bedrooms").spec.maxBeds, null);
    assert.equal(Search.local("between 2 and 3 bedrooms").spec.minPrice, null);
    assert.equal(Search.local("5 min walk to a bus stop").spec.maxBusWalk, 5);
    assert(Search.local("5 minute bus ride to campus").warnings.length);
    assert.equal(Search.local("5 minute bus ride to campus").spec.maxWalk, null);
    assert.equal(Search.local("hub under 1500").text, "hub");
});
test("rent and bedrooms must match a single floor plan; unknown rent is excluded", () => {
    const p = Search.local("3 bedrooms under $1000");
    const l = { plans: [{ beds: 0, price: 800 }, { beds: 3, price: 1800 }] };
    assert.equal(p.filter(l), false);
    l.plans.push({ beds: 3, price: 900 }); assert.equal(p.filter(l), true);
    assert.deepEqual(p.matchingPlans(l), [l.plans[2]]);
    assert.equal(Search.local("under $1000").filter({ price: 0 }), false);
    assert.equal(Search.local("under $1000 per bed").filter({ price: 800, perBed: false }), false);
});
test("description restrictions override broad tags; unknown eligibility stays unknown", () => {
    for (const desc of ["Undergrads not permitted.", "Undergraduates are not allowed.", "No undergrads permitted", "Grad students and faculty only", "Only for graduate students", "Not open to undergrads"]) {
        const e = Eligibility.of({ desc, audience: { undergrad: true, grad: true } });
        assert.equal(e.undergrad, false, desc); assert.equal(e.conflict, true, desc); assert(e.evidence);
    }
    for (const desc of ["Undergrad friendly.", "No restrictions on undergraduates.", "No undergrad restrictions.", "Undergraduates welcome.", "Our graduate students love it", "Not only for graduate students"]) {
        const e = Eligibility.of({ desc });
        assert.notEqual(e.undergrad, false, desc);
    }
    assert.equal(Eligibility.of({ desc: "A lovely house" }).undergrad, null);
    assert.equal(Eligibility.of({ desc: "Undergrad friendly. Undergrads not allowed." }).undergrad, false);
    const p = Search.local("undergrad-friendly");
    assert.equal(p.filter({ eligibility: Eligibility.of({}) }), false);
    const matches = listings.filter(p.filter);
    assert(matches.length > 0); assert(matches.every(l => l.eligibility.undergrad === true));
    assert(listings.filter(l => l.eligibility.conflict).length >= 159);
});
test("only validated model data becomes a predicate", () => {
    assert.throws(() => Search.compile({ ...Search.empty(), maxDrive: -1 }));
    assert.throws(() => Search.compile({ ...Search.empty(), filter: "evil()" }));
    assert.throws(() => Search.compile({ ...Search.empty(), amenities: ["invented"] }));
    assert.throws(() => Search.compile({ ...Search.empty(), maxDrive: "5" }));
});
test("Responses adapter sends schema, handles valid output, refusal, failures and invalid data", async () => {
    const spec = { ...Search.empty(), maxDrive: 5 };
    const fetchImpl = async (url, opts) => {
        assert.equal(url, "https://api.openai.com/v1/responses");
        const body = JSON.parse(opts.body);
        assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
        assert.deepEqual(body.text.format.schema, Search.schema);
        assert.equal(body.input, "five minutes by car");
        return { ok: true, json: async () => ({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(spec) }] }] }) };
    };
    assert.deepEqual(await api.interpret("five minutes by car", { apiKey: "test-key", model: "test-model", fetchImpl }), spec);
    for (const data of [{ status: "incomplete" }, { status: "completed", output: [{ content: [{ type: "refusal", refusal: "No" }] }] }, { status: "completed", output: [{ content: [{ type: "output_text", text: '{"maxDrive":"bogus"}' }] }] }]) {
        await assert.rejects(api.interpret("x", { apiKey: "test", model: "test", fetchImpl: async () => ({ ok: true, json: async () => data }) }));
    }
    await assert.rejects(api.interpret("x", { apiKey: "test", model: "test", fetchImpl: async () => ({ ok: false }) }));
});
test("endpoint rejects invalid input and handles missing keys without leaking secrets", async () => {
    async function call(req) { const res = { setHeader() {}, end(body) { this.body = JSON.parse(body); } }; await api(req, res); return res; }
    assert.equal((await call({ method: "GET", headers: {} })).statusCode, 405);
    assert.equal((await call({ method: "POST", headers: {}, body: { query: "" } })).statusCode, 400);
    assert.equal((await call({ method: "POST", headers: { origin: "https://elsewhere.test", host: "local.test" }, body: { query: "x" } })).statusCode, 403);
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try { assert.equal((await call({ method: "POST", headers: {}, body: { query: "5 min drive" } })).body.code, "not_configured"); }
    finally { if (previous !== undefined) process.env.OPENAI_API_KEY = previous; }
});
test("entire app parses and runs with the shared modules", () => {
    const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
    const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x => x[1]).join("\n");
    const React = { createElement: (type, props, ...children) => ({ type, props, children }), useState: v => [v, () => {}], useEffect() {}, useMemo: f => f(), useRef: () => ({ current: null }) };
    const ctx = vm.createContext({ HousingSearch: Search, HousingEligibility: Eligibility, HousingCatalog: Catalog, React, ReactDOM: { createRoot: () => ({ render() {} }) }, window: {}, document: { getElementById() {} }, console });
    vm.runInContext(fs.readFileSync(require.resolve("../data/listings.js"), "utf8"), ctx);
    vm.runInContext(source, ctx);
    const recipient = "leasing+students@example.com", subject = "Tour: 4x4 & balcony", body = "Hi!\nInterested in the 4-bedroom plan.\nIs rent $900/bed?";
    const compose = new URL(vm.runInContext(`gmailCompose(${JSON.stringify(recipient)}, ${JSON.stringify(subject)}, ${JSON.stringify(body)})`, ctx));
    assert.equal(compose.origin, "https://mail.google.com");
    assert.equal(compose.searchParams.get("view"), "cm");
    assert.equal(compose.searchParams.get("to"), recipient);
    assert.equal(compose.searchParams.get("su"), subject);
    assert.equal(compose.searchParams.get("body"), body);
    assert.equal(vm.runInContext("LISTINGS.length", ctx), raw.length);
    assert.equal(vm.runInContext("parseQuery('5min drive away from campus').spec.maxDrive", ctx), 5);
    assert(vm.runInContext("answerAI('sublease under $1000').picks.every(l => l.sublet && l.price <= 1000)", ctx));
    assert(!vm.runInContext("answerAI('talk to a human').escalate", ctx));
    assert.equal(vm.runInContext("answerAI('hub under $500').picks.length", ctx), 0);
});
test("'walk to campus' phrasing is a commute filter, never leftover name text", () => {
    for (const q of ["walk to campus", "walking to campus", "short walk to class", "walk to school", "4 bed under 1200 per bed walk to campus"]) {
        const p = Search.local(q);
        assert.equal(p.spec.maxWalk, 25, q);
        assert.equal(p.text, "", q);
    }
    const p = Search.local("4 bed under 1200 per bed walk to campus");
    assert(listings.filter(l => p.filter(l) && Search.matchesText(l, p.text)).length > 0);
});
