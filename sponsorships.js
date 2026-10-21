// Homepage-only paid placements. Campaign configuration and metrics stay server-side.
const fs = require('node:fs'), path = require('node:path');
const MAX_SLOTS = 2;
function validate(campaigns) {
    if (!Array.isArray(campaigns)) throw new Error('Campaigns must be an array.');
    const ids = new Set();
    for (const c of campaigns) {
        if (!c || !/^[a-z0-9-]{1,80}$/.test(c.id) || ids.has(c.id)) throw new Error('Campaign IDs must be unique lowercase IDs.');
        ids.add(c.id);
        if (typeof c.listingId !== 'string' || !c.listingId || typeof c.advertiser !== 'string' || !c.advertiser.trim() || c.advertiser.length > 160) throw new Error('Each campaign needs a listing ID and advertiser.');
        if (c.coverPhoto != null && (typeof c.coverPhoto !== 'string' || c.coverPhoto.length > 2048)) throw new Error('Invalid cover photo.');
        if (!['draft', 'active', 'paused'].includes(c.status)) throw new Error('Invalid campaign status.');
        if (c.status === 'active' && (!Number.isFinite(Date.parse(c.startsAt)) || !Number.isFinite(Date.parse(c.endsAt)) || Date.parse(c.startsAt) >= Date.parse(c.endsAt))) throw new Error('Active campaigns need a valid start and end date.');
    }
    return campaigns;
}
function select(campaigns, listings, { now = Date.now(), preview = false } = {}) {
    validate(campaigns);
    const catalog = new Map(listings.map(l => [String(l.id), l])), used = new Set();
    return campaigns.filter(c => {
        if (!catalog.has(c.listingId) || used.has(c.listingId)) return false;
        const eligible = preview ? c.status === 'draft' : c.status === 'active' && Date.parse(c.startsAt) <= now && now < Date.parse(c.endsAt);
        if (!eligible) return false;
        used.add(c.listingId);
        return true;
    }).slice(0, MAX_SLOTS).map(c => {
        const l = catalog.get(c.listingId), allowed = [...(l.photos || []), ...Object.values(l.photosByBeds || {}).flat()];
        return { id: c.id, listingId: c.listingId, advertiser: c.advertiser, preview, coverPhoto: allowed.includes(c.coverPhoto) ? c.coverPhoto : l.photos?.[0] || null };
    });
}
function readCampaigns(file) { return validate(JSON.parse(fs.readFileSync(file, 'utf8')).campaigns); }
function saveCampaigns(file, campaigns) {
    validate(campaigns);
    fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 1, campaigns }, null, 2) + '\n');
    fs.renameSync(file + '.tmp', file);
}
function activate(campaigns, id, { now = Date.now(), days = 30 } = {}) {
    validate(campaigns);
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('Days must be between 1 and 366.');
    const campaign = campaigns.find(c => c.id === id);
    if (!campaign) throw new Error('Campaign not found.');
    const end = now + days * 86400000;
    const overlapping = campaigns.filter(c => c.id !== id && c.status === 'active' && Date.parse(c.startsAt) < end && Date.parse(c.endsAt) > now);
    if (overlapping.some(c => c.listingId === campaign.listingId)) throw new Error('This listing already has an overlapping campaign.');
    const points = [now, ...overlapping.map(c => Math.max(now, Date.parse(c.startsAt)))];
    if (points.some(t => overlapping.filter(c => Date.parse(c.startsAt) <= t && t < Date.parse(c.endsAt)).length >= MAX_SLOTS)) throw new Error('Both homepage slots are already booked. Pause a campaign before activating another.');
    return campaigns.map(c => c.id === id ? { ...c, status: 'active', startsAt: new Date(now).toISOString(), endsAt: new Date(end).toISOString() } : c);
}
function stats(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { days: {} }; throw e; } }
function countEvent(file, campaignId, event, now = Date.now()) {
    const data = stats(file), day = new Date(now).toISOString().slice(0, 10);
    const row = ((data.days[day] ||= {})[campaignId] ||= { views: 0, clicks: 0 });
    row[event === 'view' ? 'views' : 'clicks']++;
    // Keep 90 days of aggregate counts. No names, emails, addresses, or raw event log.
    Object.keys(data.days).filter(d => Date.parse(d) < now - 90 * 86400000).forEach(d => delete data.days[d]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data) + '\n');
    fs.renameSync(file + '.tmp', file);
}
function summary(file) {
    const totals = {};
    for (const rows of Object.values(stats(file).days)) for (const [id, row] of Object.entries(rows)) {
        const t = totals[id] ||= { views: 0, clicks: 0 };
        t.views += row.views; t.clicks += row.clicks;
    }
    return totals;
}
function createHandler({ campaignsPath = path.join(__dirname, 'sponsorships/campaigns.json'), catalogPath = path.join(__dirname, 'data/listings.json'), statsPath = path.join(__dirname, '.local/sponsor-stats.json') } = {}) {
    const buckets = new Map();
    return async function handle(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(body ? JSON.stringify(body) : undefined); };
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return send(403, { error: 'Same-origin requests only.' });
        try {
            const campaigns = readCampaigns(campaignsPath), listings = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).listings;
            if (url.pathname === '/api/sponsors' && req.method === 'GET') {
                // Draft previews are available only on a loopback development server.
                const isLocal = /^\[?::1\]?$|^127\./.test(req.socket.localAddress || '');
                const preview = url.searchParams.get('preview') === '1' && isLocal;
                return send(200, { campaigns: select(campaigns, listings, { preview }), preview });
            }
            if (url.pathname !== '/api/sponsors/event' || req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
            const address = req.socket.remoteAddress || 'local', now = Date.now();
            // A bounded, in-memory abuse limit; IP addresses are not written to the metrics file.
            if (buckets.size > 5000) for (const [ip, bucket] of buckets) if (now - bucket.at > 60000) buckets.delete(ip);
            const bucket = buckets.get(address);
            if (!bucket && buckets.size >= 5000) return send(429, { error: 'Too many events.' });
            if (bucket && now - bucket.at < 60000 && bucket.count >= 60) return send(429, { error: 'Too many events.' });
            if (!bucket || now - bucket.at >= 60000) buckets.set(address, { at: now, count: 1 }); else bucket.count++;
            let body = '', oversized = false;
            for await (const chunk of req) { if (oversized) continue; if (Buffer.byteLength(body) + chunk.length > 1024) { oversized = true; continue; } body += chunk; }
            if (oversized) return send(413, { error: 'Event too large.' });
            let event; try { event = JSON.parse(body); } catch { return send(400, { error: 'Invalid event.' }); }
            if (!event || !['view', 'click'].includes(event.type) || typeof event.campaignId !== 'string') return send(400, { error: 'Invalid event.' });
            if (!select(campaigns, listings, { now }).some(c => c.id === event.campaignId)) return send(400, { error: 'Campaign is not live.' });
            countEvent(statsPath, event.campaignId, event.type, now);
            return send(204);
        } catch { return send(503, { error: 'Sponsored placements are unavailable.' }); }
    };
}
module.exports = { MAX_SLOTS, validate, select, readCampaigns, saveCampaigns, activate, countEvent, summary, createHandler };
