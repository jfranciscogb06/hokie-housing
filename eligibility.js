/* Explicit description restrictions override the portal's broad audience tags. */
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else root.HousingEligibility = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    const undergrad = "undergrad(?:uate)?s?(?: students?)?";
    const denied = new RegExp(`\\b(?:no\\s+${undergrad}(?!\\s+(?:restrictions?|limitations?))|${undergrad}\\s+(?:are\\s+)?(?:not|never)\\s+(?:permitted|allowed|accepted|eligible|welcome)|not\\s+(?:open|available)\\s+to\\s+${undergrad}|${undergrad}\\s+(?:are\\s+)?prohibited)\\b`, "i");
    const gradOnly = /(?<!not )\b(?:grad(?:uate)?\s*(?:students?)?(?:\s*(?:and|or|\/)\s*(?:faculty(?:\/staff)?|staff))?\s+only|only\s+(?:for\s+)?grad(?:uate)?\s*(?:students?)?(?:\s*(?:and|or|\/)\s*(?:faculty|staff))?|faculty(?:\s*(?:and|or|\/)\s*staff)?\s+only)\b/i;
    const welcomed = new RegExp(`\\b(?:${undergrad}[-\\s]+friendly|(?:open\\s+to|accepts?|welcomes?)\\s+${undergrad}|${undergrad}\\s+(?:are\\s+)?(?:allowed|permitted|welcome|accepted|eligible))\\b`, "i");
    function of(l) {
        const values = Object.fromEntries(["undergrad", "grad", "faculty"].map(k => [k, typeof l.audience?.[k] === "boolean" ? l.audience[k] : null]));
        const description = (l.desc || "").replace(/\s+/g, " ");
        const restriction = description.match(denied) || description.match(gradOnly);
        const positive = description.match(welcomed);
        if (restriction) values.undergrad = false;
        else if (positive) values.undergrad = true;
        return { ...values, evidence: restriction?.[0] || positive?.[0] || null,
            source: restriction || positive ? "description" : l.audience ? "portal audience tags" : null,
            conflict: !!(restriction && (l.audience?.undergrad === true || positive)) };
    }
    return { of, patterns: { denied: denied.source, gradOnly: gradOnly.source, welcomed: welcomed.source } };
});
