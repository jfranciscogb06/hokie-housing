/* Catalog cleanup applied when listings load (browser) and in tests (Node).
   - Generic titles ("3 Bedroom 2 Bath Townhouse") are replaced by the street address.
   - Sublets/rooms inside a community are linked to it, so results can show the
     community once with "N sublets here" instead of repeating it.
   - Listings without photos sort after ones with photos. */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.HousingCatalog = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    // Words that describe a unit rather than name a place.
    const GENERIC = new Set(("bed bedroom bedrooms bath bathroom bathrooms baths br ba half full townhouse townhome townhomes " +
        "house home homes duplex triplex condo condominium apartment apartments apt unit units room rooms with and the for " +
        "in on of at near a an private garage car one two three four five six level story single family " +
        "blacksburg christiansburg va virginia spacious updated renovated cozy charming beautiful bright large lovely " +
        "new newly great nice quiet sunny available now leasing lease rent rental basement loft studio plus " +
        "deck yard fenced off street parking").split(" "));
    const isGenericName = (name) => {
        const words = String(name || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
        return words.length > 0 && words.every((w) => GENERIC.has(w));
    };
    const street = (address) => String(address || "").split(",")[0].replace(/\s+/g, " ").trim();
    const streetKey = (address) => street(address).toLowerCase()
        .replace(/\b(?:apt|unit|suite|ste|#)\s*\S+/g, "").replace(/[^a-z0-9 ]/g, " ")
        .replace(/\b(?:street|st)\b/g, "st").replace(/\b(?:road|rd)\b/g, "rd").replace(/\b(?:drive|dr)\b/g, "dr")
        .replace(/\b(?:lane|ln)\b/g, "ln").replace(/\b(?:boulevard|blvd)\b/g, "blvd").replace(/\b(?:avenue|ave)\b/g, "ave")
        .replace(/\b(?:northwest|nw|northeast|ne|southwest|sw|southeast|se)\b/g, "").replace(/\s+/g, " ").trim();
    const miles = (a, b) => {
        if (a.lat == null || b.lat == null) return Infinity;
        const dy = (a.lat - b.lat) * 69, dx = (a.lng - b.lng) * 54.9;
        return Math.sqrt(dx * dx + dy * dy);
    };
    // Distinctive name of a community: drop generic/marketing words. "The Edge Apartments and Townhomes" -> "edge".
    const nameKey = (name) => String(name || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/)
        .filter((w) => w.length > 2 && !GENERIC.has(w) && !/^(?:apartmets|communities|community|living|suites)$/.test(w)).slice(0, 2).join(" ");

    function normalize(listings) {
        const out = listings.map((l) => {
            const generic = isGenericName(l.name) && !!street(l.address) && !/^[^0-9]*,/.test(l.address || "") && /\d/.test(street(l.address));
            return generic ? { ...l, listingName: l.name, name: street(l.address), genericName: true } : { ...l };
        });
        // Communities: non-sublet, non-shared listings with several floor plans.
        const communities = out.filter((l) => !l.sublet && !l.shared && (l.plans || []).length >= 3);
        for (const c of communities) c._key = nameKey(c.name);
        for (const l of out) {
            if (!(l.sublet || l.shared) || (l.plans || []).length >= 3) continue;
            const sk = streetKey(l.address);
            const hay = String((l.listingName || l.name) || "").toLowerCase();
            let best = null, bestD = Infinity;
            for (const c of communities) {
                if (c.id === l.id) continue;
                const d = miles(l, c);
                if (d > 0.35) continue;
                const sameStreet = sk && sk === streetKey(c.address);
                const named = c._key && c._key.length >= 3 && new RegExp(`\\b${c._key.replace(/ /g, "\\s+")}\\b`).test(hay);
                if ((sameStreet || named) && d < bestD) { best = c; bestD = d; }
            }
            if (best) l.parentId = best.id;
        }
        const children = {};
        for (const l of out) if (l.parentId) (children[l.parentId] ||= []).push(l.id);
        for (const l of out) { delete l._key; if (children[l.id]) l.childIds = children[l.id]; }
        return out;
    }

    /* Collapse grouped sublets into their community when both are in a result set,
       unless the search is specifically for sublets/shared rooms. */
    function collapse(results, { keepChildren = false } = {}) {
        if (keepChildren) return results;
        const ids = new Set(results.map((l) => l.id));
        const counts = {};
        const kept = results.filter((l) => {
            if (l.parentId && ids.has(l.parentId)) { counts[l.parentId] = (counts[l.parentId] || 0) + 1; return false; }
            return true;
        });
        return kept.map((l) => (counts[l.id] ? { ...l, groupedCount: counts[l.id] } : l));
    }

    // Stable: keeps the given sort, moves photo-less listings to the end.
    const photosFirst = (list) => [...list.filter((l) => l.photos && l.photos.length), ...list.filter((l) => !(l.photos && l.photos.length))];

    return { normalize, collapse, photosFirst, isGenericName, street, streetKey, nameKey };
});
