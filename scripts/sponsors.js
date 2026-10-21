#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Sponsors = require('../sponsorships');
const root = path.join(__dirname, '..'), file = path.join(root, 'sponsorships/campaigns.json');
const [command = 'list', id, ...args] = process.argv.slice(2);
const help = `Homepage sponsorships (operator tool; no public write endpoint):\n  npm run sponsors -- list\n  npm run sponsors -- add LISTING_ID --advertiser "Property manager" [--photo CATALOG_PHOTO]\n  npm run sponsors -- activate CAMPAIGN_ID --days 30\n  npm run sponsors -- pause CAMPAIGN_ID\n  npm run sponsors -- stats\n\nCreate a draft, arrange payment directly, then activate its placement. Dates are stored in UTC.\nLocal preview: http://localhost:8788/?previewSponsors=1\n`;
function option(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
try {
    if (['help', '--help', '-h'].includes(command)) { console.log(help); process.exit(0); }
    let campaigns = Sponsors.readCampaigns(file);
    if (command === 'list') console.table(campaigns.map(c => ({ id: c.id, advertiser: c.advertiser, listing: c.listingId, status: c.status === 'active' && Date.parse(c.endsAt) <= Date.now() ? 'expired' : c.status, starts: c.startsAt || '—', ends: c.endsAt || '—' })));
    else if (command === 'stats') { console.table(Sponsors.summary(path.join(root, '.local/sponsor-stats.json'))); console.log('90-day aggregate placement views and profile clicks; these are not unique visitors.'); }
    else if (command === 'add') {
        const advertiser = option('--advertiser');
        const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/listings.json'), 'utf8')).listings;
        if (!catalog.some(l => String(l.id) === id)) throw new Error('Listing ID is not in the catalog.');
        if (!advertiser) throw new Error('Supply --advertiser "Property manager".');
        const coverPhoto = option('--photo'), l = catalog.find(l => String(l.id) === id);
        if (coverPhoto && ![...(l.photos || []), ...Object.values(l.photosByBeds || {}).flat()].includes(coverPhoto)) throw new Error('Choose a photo from this listing’s catalog gallery or bedroom photos.');
        const c = { id: crypto.randomUUID(), listingId: id, advertiser, status: 'draft', startsAt: null, endsAt: null, ...(coverPhoto ? { coverPhoto } : {}) };
        Sponsors.saveCampaigns(file, [...campaigns, c]); console.log(`Draft created: ${c.id}`);
    } else if (command === 'activate') {
        const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data/listings.json'), 'utf8')).listings;
        if (!catalog.some(l => String(l.id) === campaigns.find(c => c.id === id)?.listingId)) throw new Error('Campaign listing is no longer in the catalog.');
        campaigns = Sponsors.activate(campaigns, id, { days: Number(option('--days') || 30) });
        Sponsors.saveCampaigns(file, campaigns); console.log(`Placement activated until ${campaigns.find(c => c.id === id).endsAt}.`);
    } else if (command === 'pause') {
        if (!campaigns.some(c => c.id === id)) throw new Error('Campaign not found.');
        Sponsors.saveCampaigns(file, campaigns.map(c => c.id === id ? { ...c, status: 'paused' } : c)); console.log('Placement paused.');
    } else throw new Error('Unknown command. Use npm run sponsors -- help.');
} catch (e) { console.error(e.message); process.exitCode = 1; }
