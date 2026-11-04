// Structural checks for the generated catalog. This does not verify source claims.
const fs = require('node:fs'), vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const raw = JSON.parse(fs.readFileSync(path.join(root, 'data/listings.json'), 'utf8'));
const errors = [], warnings = [], ids = new Set();
const listings = raw.listings;
if (!Array.isArray(listings) || !listings.length) throw Error('Catalog is empty or invalid.');
if (raw.meta?.count !== listings.length) errors.push('Catalog count does not match its records.');
if (!Number.isFinite(Date.parse(raw.meta?.updatedAt))) errors.push('Catalog update timestamp is invalid.');
function photo(value, label) {
    if (typeof value !== 'string' || !(/^https:\/\//.test(value) || /^photos\/[\w/-]+\.(jpg|jpeg|png|webp)$/.test(value))) errors.push(label + ': invalid photo reference');
}
for (const l of listings) {
    if (!l.id || ids.has(l.id)) errors.push('Missing or duplicate listing ID: ' + l.id);
    ids.add(l.id);
    if (!l.name || !l.sourceUrl || !/^https:\/\//.test(l.sourceUrl)) errors.push(l.id + ': missing name or source');
    if (!Number.isFinite(l.lat) || !Number.isFinite(l.lng) || Math.abs(l.lat)>90 || Math.abs(l.lng)>180) errors.push(l.id + ': invalid coordinates');
    if (l.price != null && (!Number.isFinite(l.price) || l.price<0)) errors.push(l.id + ': invalid rent');
    if (!(l.photos || []).length) warnings.push(l.id + ': source supplied no gallery photos');
    for (const src of l.photos || []) photo(src, l.id);
    for (const group of Object.values(l.photosByBeds || {})) for (const src of group) photo(src, l.id);
    for (const src of Object.values(l.planPhotos || {})) if (src) photo(src, l.id);
    for (const p of l.plans || []) {
        if (p.price != null && (!Number.isFinite(p.price) || p.price<0)) errors.push(l.id + ': invalid floor-plan rent');
        if (p.priceTotal && p.beds>1 && Math.abs(p.priceTotal/p.beds-p.price)>1) errors.push(l.id + ': per-person price does not match whole-unit rent');
        if (p.image) photo(p.image, l.id);
    }
}
const browser = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(root, 'data/listings.js'), 'utf8'), browser, { timeout: 2000 });
if (JSON.stringify(browser.window.HOKIE_LISTINGS) !== JSON.stringify(listings) || JSON.stringify(browser.window.HOKIE_META) !== JSON.stringify(raw.meta)) errors.push('Browser and server catalogs differ.');
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), catalogUpdatedAt: raw.meta.updatedAt, listings: listings.length, errors, warnings }, null, 2));
if (errors.length) process.exitCode = 1;
