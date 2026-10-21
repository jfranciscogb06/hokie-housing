/* Shared by the browser and the AI endpoint. Model output is data, never code. */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.HousingSearch = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const numeric = { minPrice: 100000, maxPrice: 100000, minBeds: 20, maxBeds: 20, minBaths: 20,
        maxWalk: 240, maxDrive: 240, maxBusWalk: 60, minRating: 5, maxLease: 60 };
    const flags = ["furnished", "pets", "utilities", "sublet", "shared"];
    const amenities = {
        pool: /pool/i, gym: /gym|fitness/i, laundry: /washer|dryer|laundry/i,
        "in-unit laundry": /(?:washer|dryer|laundry).*(?:in.unit)|in.unit.*(?:washer|dryer|laundry)/i,
        parking: /parking|garage/i, dishwasher: /dishwasher/i, balcony: /balcony|patio/i,
        hardwood: /hardwood/i, "walk-in closet": /walk.?in closet/i,
        "air conditioning": /air condition|central air/i, accessible: /accessible|accessibility/i,
        internet: /internet|wi.fi/i, "ev charging": /ev charging|electric vehicle/i,
    };
    const sorts = ["price-asc", "price-desc", "walk", "drive", "rating"];
    const properties = Object.fromEntries(Object.entries(numeric).map(([k, max]) => [k, { type: ["number", "null"], minimum: 0, maximum: max }]));
    flags.forEach(k => properties[k] = { type: ["boolean", "null"] });
    Object.assign(properties, {
        rentBasis: { type: ["string", "null"], enum: [null, "bed", "unit"] },
        audience: { type: ["string", "null"], enum: [null, "undergrad", "grad", "faculty"] },
        type: { type: ["string", "null"], enum: [null, "Apartment", "House", "Townhouse", "Loft", "Studio"] },
        amenities: { type: "array", items: { type: "string", enum: Object.keys(amenities) }, maxItems: 14 },
        excludeAmenities: { type: "array", items: { type: "string", enum: Object.keys(amenities) }, maxItems: 14 },
        text: { type: "string", maxLength: 200 },
        sort: { type: ["string", "null"], enum: [null, ...sorts] },
        unsupported: { type: "array", items: { type: "string", maxLength: 120 }, maxItems: 6 },
    });
    const schema = { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
    const empty = () => Object.fromEntries(Object.keys(properties).map(k => [k,
        ["amenities", "excludeAmenities", "unsupported"].includes(k) ? [] : k === "text" ? "" : null]));
    function validate(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid search");
        const out = empty();
        for (const [k, spec] of Object.entries(properties)) {
            const v = value[k];
            if (v === undefined) throw new Error("Missing search field");
            if (spec.enum) {
                if (!spec.enum.includes(v)) throw new Error("Invalid search choice");
            } else if (k in numeric) {
                if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > numeric[k])) throw new Error("Invalid search number");
            } else if (flags.includes(k)) {
                if (v !== null && typeof v !== "boolean") throw new Error("Invalid search flag");
            } else if (Array.isArray(out[k])) {
                if (!Array.isArray(v) || v.length > spec.maxItems || v.some(x => typeof x !== "string" || (spec.items.enum ? !spec.items.enum.includes(x) : x.length > 120))) throw new Error("Invalid search list");
            } else if (typeof v !== "string" || v.length > 200) throw new Error("Invalid search text");
            out[k] = v;
        }
        // Unknown properties cannot introduce a model-generated executable predicate.
        if (Object.keys(value).some(k => !properties[k])) throw new Error("Unknown search field");
        return out;
    }
    const knownNumber = n => typeof n === "number" && Number.isFinite(n);
    function matchingPlans(l, s) {
        const plans = l.plans && l.plans.length ? l.plans : [l];
        return plans.filter(p => {
            if (s.minBeds !== null && (!knownNumber(p.beds) || p.beds < s.minBeds)) return false;
            if (s.maxBeds !== null && (!knownNumber(p.beds) || p.beds > s.maxBeds)) return false;
            if (s.minBaths !== null && (!knownNumber(p.baths) || p.baths < s.minBaths)) return false;
            if ((s.minPrice !== null || s.maxPrice !== null) && (!knownNumber(p.price) || p.price <= 0)) return false;
            return (s.minPrice === null || p.price >= s.minPrice) && (s.maxPrice === null || p.price <= s.maxPrice);
        });
    }
    function compile(value) {
        const s = validate(value), facets = [];
        if (s.minPrice !== null) facets.push(`rent ≥ $${s.minPrice}`);
        if (s.maxPrice !== null) facets.push(`rent ≤ $${s.maxPrice}`);
        if (s.rentBasis) facets.push(s.rentBasis === "bed" ? "per-bed rent" : "whole-unit rent");
        if (s.audience) facets.push(({ undergrad: "undergrad-friendly", grad: "grad students eligible", faculty: "faculty/staff eligible" })[s.audience]);
        if (s.minBeds !== null) facets.push(s.minBeds === s.maxBeds ? `${s.minBeds} bedrooms` : `${s.minBeds}+ bedrooms`);
        if (s.maxBeds !== null && s.maxBeds !== s.minBeds) facets.push(`up to ${s.maxBeds} bedrooms`);
        if (s.minBaths !== null) facets.push(`${s.minBaths}+ bathrooms`);
        if (s.maxWalk !== null) facets.push(`≤ ${s.maxWalk} min walk to campus`);
        if (s.maxDrive !== null) facets.push(`≤ ${s.maxDrive} min drive to campus`);
        if (s.maxBusWalk !== null) facets.push(`BT stop ≤ ${s.maxBusWalk} min walk`);
        if (s.minRating !== null) facets.push(`rated ${s.minRating}+`);
        if (s.maxLease !== null) facets.push(`lease ≤ ${s.maxLease} months`);
        if (s.type) facets.push(s.type.toLowerCase());
        const names = { furnished: "furnished", pets: "pet friendly", utilities: "utilities included", sublet: "sublease", shared: "shared unit" };
        flags.forEach(k => { if (s[k] !== null) facets.push((s[k] ? "" : "without ") + names[k]); });
        facets.push(...s.amenities, ...s.excludeAmenities.map(a => `without ${a}`));
        if (s.sort) facets.push(({ "price-asc": "cheapest first", "price-desc": "highest rent first", walk: "shortest walk first", drive: "shortest drive first", rating: "top rated first" })[s.sort]);
        const filter = l => {
            if (s.maxWalk !== null && (!knownNumber(l.walk) || l.walk > s.maxWalk)) return false;
            if (s.maxDrive !== null && (!knownNumber(l.driveMin) || l.driveMin > s.maxDrive)) return false;
            if (s.maxBusWalk !== null && (!l.busStop || !knownNumber(l.busStop.walkMin) || l.busStop.walkMin > s.maxBusWalk)) return false;
            if (s.minRating !== null && (!l.reviews || !knownNumber(l.rating) || l.rating < s.minRating)) return false;
            if (s.maxLease !== null && (!knownNumber(l.lease) || l.lease <= 0 || l.lease > s.maxLease)) return false;
            if (s.type && (s.type === "Studio" ? !(l.beds === 0 || (l.plans || []).some(p => p.beds === 0)) : l.type !== s.type)) return false;
            if (s.rentBasis && (typeof l.perBed !== "boolean" || l.perBed !== (s.rentBasis === "bed"))) return false;
            if (s.audience && l.eligibility?.[s.audience] !== true) return false;
            if (flags.some(k => s[k] !== null && l[k] !== s[k])) return false;
            const am = (l.amenities || []).join(" ");
            if (s.amenities.some(a => !amenities[a].test(am)) || s.excludeAmenities.some(a => amenities[a].test(am))) return false;
            // Check rent, beds and baths against the SAME floor plan, rather than a
            // community's cheapest studio plus its largest, more expensive plan.
            const hasPlanCriteria = [s.minPrice, s.maxPrice, s.minBeds, s.maxBeds, s.minBaths].some(v => v !== null);
            if (!hasPlanCriteria) return true;
            return matchingPlans(l, s).length > 0;
        };
        return { spec: s, facets, filter, matchingPlans: l => matchingPlans(l, s), text: s.text, sort: s.sort, beds: s.minBeds, warnings: s.unsupported };
    }
    function matchesText(l, text) {
        if (!text) return true;
        const hay = `${l.name} ${l.area} ${l.type} ${l.address || ""} ${l.manager || ""}`.toLowerCase().replace(/[’']/g, "");
        return text.toLowerCase().replace(/[’']/g, "").split(/\s+/).filter(Boolean).every(w => hay.includes(w));
    }
    function sortListings(list, sort) {
        const n = v => knownNumber(v) ? v : Infinity;
        return [...list].sort((a, b) => {
            if (sort === "price-asc") return n(a.price > 0 ? a.price : null) - n(b.price > 0 ? b.price : null);
            if (sort === "price-desc") return n(b.price > 0 ? b.price : null) - n(a.price > 0 ? a.price : null);
            if (sort === "drive") return n(a.driveMin) - n(b.driveMin);
            if (sort === "walk") return n(a.walk) - n(b.walk);
            return (b.rating || 0) - (a.rating || 0) || n(a.walk) - n(b.walk);
        });
    }
    function local(q) {
        const s = empty();
        let rest = " " + (q || "").toLowerCase().replace(/[’']/g, "").replace(/(\d),(\d{3})/g, "$1$2").replace(/-/g, " ") + " ";
        const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30 };
        rest = rest.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty)\b(?=\s*(?:min|bed|bath|br\b|bd\b))/g, w => words[w]);
        const take = (re, apply) => { const m = rest.match(re); if (m) { apply(m); rest = rest.replace(re, " "); } return m; };
        take(/\bundergrad(?:uate)?s?(?: students?)?(?: friendly| eligible| welcome)?\b/, () => s.audience = "undergrad");
        take(/\bgrad(?:uate)?(?: students?)?(?: friendly| eligible| welcome)?\b/, () => s.audience = "grad");
        take(/\b(?:faculty|staff)(?: friendly| eligible)?\b/, () => s.audience = "faculty");
        const campus = "(?:\\s*(?:away\\s*)?(?:from|to|of)\\s*(?:(?:the|vt)\\s*)?(?:campus|school|burruss(?: hall)?|virginia tech))?";
        const minute = "(?:min(?:ute)?s?)";
        const prefix = "(?:within|under|less than|at most|no more than|up to|about|around)?\\s*";
        const suffix = "(?:\\s*(?:or less|or under|max(?:imum)?))?";
        const modes = [["maxDrive", "(?:drive|driving|by car|car ride)"], ["maxWalk", "(?:walk|walking|on foot)"], ["maxBusWalk", "(?:walk (?:to|from) (?:a |the )?(?:bus|bt) stop)"]];
        // Specific bus-stop walks before generic walks; the bus field means WALK
        // to a stop, never an invented bus ride duration.
        for (const [field, mode] of [modes[2], modes[0], modes[1]]) {
            take(new RegExp(prefix + "(\\d+)\\s*" + minute + "\\s*" + mode + suffix + campus), m => s[field] = +m[1]);
            if (s[field] === null) take(new RegExp(mode + "(?:\\s*(?:to|from) (?:campus|school))?\\s*(?:within|under|less than|of|in|up to)?\\s*(\\d+)\\s*" + minute + suffix + campus), m => s[field] = +m[1]);
        }
        take(/\b(\d+)\s*(?:min(?:ute)?s?)\s*(?:bus ride|by bus|bus commute)(?:\s*(?:to|from) campus)?\b/, () => s.unsupported.push("Bus ride times are not in the catalog; try walking distance to a BT stop."));
        take(/\b(?:between\s*)?(\d+)\s*(?:and|to)\s*(\d+)\s*(?:bed(?:room)?s?|br|bd)\b/, m => { s.minBeds = +m[1]; s.maxBeds = +m[2]; });
        take(/\bbetween\s*\$?(\d{3,5})\s*(?:and|to)\s*\$?(\d{3,5})\b/, m => { s.minPrice = +m[1]; s.maxPrice = +m[2]; });
        take(/\b(?:under|below|less than|at most|no more than|up to|max(?:imum)?(?: budget)?|budget(?: of| is)?)\s*\$?\s*(\d{3,5})\b|\$\s*(\d{3,5})(?:\s*(?:or less|max))?\b/, m => s.maxPrice = +(m[1] || m[2]));
        take(/\b(?:over|above|at least|more than)\s*\$?\s*(\d{3,5})\b/, m => s.minPrice = +m[1]);
        take(/(?:\/|\bper |\ba )(?:bed|person|roommate)\b/, () => s.rentBasis = "bed");
        take(/\b(?:whole unit|whole apartment|total rent|per unit)\b/, () => s.rentBasis = "unit");
        take(/\b(?:at least|minimum|no fewer than)\s*(\d+)\s*(?:bed(?:room)?s?|br|bd)\b|\b(\d+)\s*\+\s*(?:bed(?:room)?s?|br|bd)\b/, m => s.minBeds = +(m[1] || m[2]));
        if (s.minBeds === null) take(/\b(?:exactly\s*)?(\d+)\s*(?:bed(?:room)?s?|br|bd)\b/, m => { s.minBeds = +m[1]; s.maxBeds = +m[1]; });
        take(/\b(\d+(?:\.\d+)?)\s*bath(?:room)?s?\b/, m => s.minBaths = +m[1]);
        take(/\bstudio(?:s)?\b/, () => { s.minBeds = 0; s.maxBeds = 0; });
        take(/\b(apartments?|houses?|townhouses?|townhomes?|lofts?)\b/, m => s.type = /town/.test(m[1]) ? "Townhouse" : /house/.test(m[1]) ? "House" : /loft/.test(m[1]) ? "Loft" : "Apartment");
        const flagPatterns = { pets: "(?:pet(?:s)?(?: friendly| allowed| ok)?|dog(?:s)?(?: friendly| allowed| ok)?|cat(?:s)?(?: friendly| allowed| ok)?)", furnished: "furnished", utilities: "(?:utilities(?: included)?|all inclusive)", sublet: "(?:sublet|sublease)", shared: "(?:shared(?: unit)?|room in)" };
        for (const [k, pattern] of Object.entries(flagPatterns)) {
            take(new RegExp("\\b(?:no|without|not|un)\\s*(" + pattern + ")\\b"), () => s[k] = false);
            if (s[k] === null) take(new RegExp("\\b" + pattern + "\\b"), () => s[k] = true);
        }
        const aliases = { gym: "(?:gym|fitness(?: center| room)?)", pool: "pool", "in-unit laundry": "(?:in unit (?:laundry|washer(?: and dryer)?)|(?:washer(?: and dryer)?|laundry) in (?:the )?unit)", laundry: "(?:laundry|washer(?: and dryer)?|dryer)", parking: "(?:parking|garage)", dishwasher: "dishwasher", balcony: "(?:balcony|patio)", hardwood: "hardwood(?: floors)?", "walk-in closet": "walk in closets?", "air conditioning": "(?:air conditioning|central air|ac)", accessible: "(?:wheelchair accessible|accessible)", internet: "(?:internet|wifi|wi fi)", "ev charging": "ev charging" };
        for (const [k, pattern] of Object.entries(aliases)) {
            take(new RegExp("\\b(?:no|without)\\s*" + pattern + "\\b"), () => s.excludeAmenities.push(k));
            if (!s.excludeAmenities.includes(k)) take(new RegExp("\\b" + pattern + "\\b"), () => s.amenities.push(k));
        }
        take(/\b(?:closest|shortest|fastest)\s*(?:drive|driving|by car)\b/, () => s.sort = "drive");
        take(/\b(?:closest|shortest walk|nearest)\b/, () => s.sort = "walk");
        take(/\b(?:cheap(?:est)?|affordable|budget friendly|lowest rent)\b/, () => s.sort = "price-asc");
        take(/\b(?:best|top|highest)(?: rated)?\b/, () => s.sort = "rating");
        take(/\b(?:rated|rating(?: of)?)\s*(\d(?:\.\d+)?)\s*(?:\+|or (?:more|higher)|stars?)?/, m => s.minRating = +m[1]);
        take(/\b(\d+)\s*months?(?:\s*lease)?\b/, m => s.maxLease = +m[1]);
        if (s.maxWalk === null && s.maxDrive === null) take(/\b(?:near|close to|walkable to|walking distance (?:from|to)|(?:a |short )?walk(?:ing)?(?: distance)? (?:to|from))\s*(?:the )?(?:campus|vt|school|burruss|class(?:es)?)\b/, () => s.maxWalk = 25);
        take(/\b(?:on (?:a |the )?)?(?:bus|bt)(?: route| stop)?\b/, () => { if (s.maxBusWalk === null) s.maxBusWalk = 8; });
        take(/\b(?:quiet|safe|safest|crime|noise|bike|biking|available now|move in|august|september)\b/, m => s.unsupported.push(`“${m[0].trim()}” needs more information than the catalog provides.`));
        rest = rest.replace(/\b(?:find|show|get|give|search|looking|look|for|me|us|i|im|id|like|want|need|a|an|the|some|any|with|and|in|that|is|are|please|place|places|listing|listings|rental|rentals|to|rent|vt|virginia tech|campus|school|from|away|within|only|minutes|minute|per|month|monthly|mo|can|you|do|have|something)\b/g, " ");
        s.text = rest.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
        try { return compile(s); } catch { return compile({ ...empty(), text: q.slice(0, 200), unsupported: ["Try a smaller budget or commute value."] }); }
    }
    return { schema, empty, validate, compile, local, matchesText, sortListings };
});
