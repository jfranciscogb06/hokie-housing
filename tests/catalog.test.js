const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const Catalog = require("../catalog"), Search = require("../housing-search");
const raw = JSON.parse(fs.readFileSync(require.resolve("../data/listings.json"))).listings;
const listings = Catalog.normalize(raw);
test("generic unit names become the street address; named places keep their name", () => {
    assert.equal(Catalog.isGenericName("3 Bedroom 2 Bath Townhouse"), true);
    assert.equal(Catalog.isGenericName("4 Bedroom, 3.5 Bath Townhouse with 1 car garage"), true);
    assert.equal(Catalog.isGenericName("Hub Blacksburg"), false);
    assert.equal(Catalog.isGenericName("Turner NW - Steps from Campus"), false);
    const renamed = listings.filter(l => l.genericName);
    assert(renamed.length > 100);
    assert(renamed.every(l => /\d/.test(l.name) && l.listingName && !Catalog.isGenericName(l.name)));
    // The original wording stays searchable.
    const p = Search.local("townhouse");
    assert(renamed.some(l => Search.matchesText(l, "townhouse")) || p.spec.type === "Townhouse");
});
test("sublets inside a community are grouped under it and collapse in results", () => {
    const hub = listings.find(l => l.name === "Hub Blacksburg" && (l.plans || []).length >= 3);
    assert(hub && hub.childIds && hub.childIds.length >= 1);
    const kids = listings.filter(l => l.parentId);
    assert(kids.every(k => k.sublet || k.shared));
    assert(kids.every(k => listings.find(p => p.id === k.parentId && !p.sublet && !p.shared)));
    const both = [hub, ...hub.childIds.map(id => listings.find(l => l.id === id))];
    const collapsed = Catalog.collapse(both);
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0].groupedCount, hub.childIds.length);
    assert.equal(Catalog.collapse(both, { keepChildren: true }).length, both.length);
    // A sublet whose community is filtered out still shows on its own.
    const lone = Catalog.collapse(both.slice(1));
    assert.equal(lone.length, both.length - 1);
});
test("listings without photos sort after ones with photos, keeping order otherwise", () => {
    const a = { id: "a", photos: [] }, b = { id: "b", photos: ["x"] }, c = { id: "c", photos: ["y"] };
    assert.deepEqual(Catalog.photosFirst([a, b, c]).map(l => l.id), ["b", "c", "a"]);
});
