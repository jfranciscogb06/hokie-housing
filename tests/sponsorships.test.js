const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { Readable } = require('node:stream');
const S = require('../sponsorships');
const now = Date.parse('2026-10-13T12:00:00Z');
const catalog = [{ id: 'house-a' }, { id: 'house-b' }, { id: 'house-c' }];
const draft = (id = 'campaign-a', listingId = 'house-a') => ({ id, listingId, advertiser: 'Property manager', status: 'draft', startsAt: null, endsAt: null });
const active = (id = 'campaign-a', listingId = 'house-a', start = now - 1000, end = now + 1000) => ({ ...draft(id, listingId), status: 'active', startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() });
test('only live, unexpired catalog campaigns appear; draft previews cannot imply payment', () => {
    const campaigns = [draft(), active('campaign-b', 'house-b'), active('removed', 'missing'), active('expired', 'house-c', now - 1000, now), { ...active('paused', 'house-c'), status: 'paused' }];
    assert.deepEqual(S.select(campaigns, catalog, { now }).map(c => c.id), ['campaign-b']);
    const previews = S.select(campaigns, catalog, { now, preview: true });
    assert.equal(previews.length, 1); assert.equal(previews[0].preview, true);
    assert.equal(S.select([active()], catalog, { now: now + 1000 }).length, 0);
    assert.equal(S.select([active()], catalog, { now: now - 1001 }).length, 0);
    assert.equal(S.select([active(), active('duplicate-house')], catalog, { now }).length, 1);
    const photos = [{ id: 'house-a', photos: ['photos/house-a/exterior.jpg'], photosByBeds: { 4: ['photos/house-a/model.jpg'] } }];
    assert.equal(S.select([{ ...active(), coverPhoto: 'photos/house-a/model.jpg' }], photos, { now })[0].coverPhoto, 'photos/house-a/model.jpg');
    assert.equal(S.select([{ ...active(), coverPhoto: 'https://unrelated.test/photo.jpg' }], photos, { now })[0].coverPhoto, 'photos/house-a/exterior.jpg');
});
test('activation enforces two slots, valid terms, and no overlapping duplicate property', () => {
    let campaigns = S.activate([draft(), draft('campaign-b', 'house-b'), draft('campaign-c', 'house-c')], 'campaign-a', { now, days: 30 });
    campaigns = S.activate(campaigns, 'campaign-b', { now, days: 30 });
    assert.equal(S.select(campaigns, catalog, { now }).length, 2);
    assert.throws(() => S.activate(campaigns, 'campaign-c', { now }), /booked/);
    assert.throws(() => S.activate([active(), draft('duplicate-house')], 'duplicate-house', { now }), /overlapping/);
    assert.throws(() => S.activate([draft()], 'campaign-a', { now, days: 0 }));
    assert.throws(() => S.activate([draft()], 'campaign-a', { now, days: 1.5 }));
    assert.throws(() => S.validate([{ ...active(), endsAt: 'invalid' }]));
    assert.throws(() => S.validate([draft(), draft()]));
    campaigns = campaigns.map(c => c.id === 'campaign-a' ? { ...c, status: 'paused' } : c);
    assert.equal(S.select(S.activate(campaigns, 'campaign-c', { now }), catalog, { now }).length, 2);
});
test('API isolates preview and private metrics, rejects cross-origin and inactive events', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hokie-sponsors-test-'));
    const campaignsPath = path.join(folder, 'campaigns.json'), catalogPath = path.join(folder, 'catalog.json'), statsPath = path.join(folder, 'private/stats.json');
    S.saveCampaigns(campaignsPath, [draft(), active('live', 'house-b', Date.now() - 10000, Date.now() + 10000)]);
    fs.writeFileSync(catalogPath, JSON.stringify({ listings: catalog }));
    const handle = S.createHandler({ campaignsPath, catalogPath, statsPath });
    async function call(url, method = 'GET', body = '', localAddress = '127.0.0.1', origin) {
        const req = Readable.from([Buffer.from(body)]);
        Object.assign(req, { url, method, headers: { host: 'localhost:8788', ...(origin ? { origin } : {}) }, socket: { localAddress, remoteAddress: '127.0.0.1' } });
        const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body ? JSON.parse(body) : null; } };
        await handle(req, res); return res;
    }
    try {
        assert.equal((await call('/api/sponsors')).body.campaigns[0].id, 'live');
        assert.equal((await call('/api/sponsors?preview=1')).body.campaigns[0].preview, true);
        assert.equal((await call('/api/sponsors?preview=1', 'GET', '', '10.0.0.1')).body.campaigns[0].id, 'live');
        assert.equal((await call('/api/sponsors/event', 'POST', JSON.stringify({ campaignId: 'campaign-a', type: 'click' }))).status, 400);
        assert.equal(fs.existsSync(statsPath), false);
        assert.equal((await call('/api/sponsors/event', 'POST', '{bad')).status, 400);
        assert.equal((await call('/api/sponsors/event', 'POST', 'x'.repeat(1025))).status, 413);
        assert.equal((await call('/api/sponsors/event', 'POST', '{}', '127.0.0.1', 'https://unrelated.test')).status, 403);
        for (const type of ['view', 'click']) assert.equal((await call('/api/sponsors/event', 'POST', JSON.stringify({ campaignId: 'live', type }))).status, 204);
        assert.deepEqual(S.summary(statsPath), { live: { views: 1, clicks: 1 } });
        assert(!fs.readFileSync(statsPath, 'utf8').includes('127.0.0.1'));
        S.countEvent(statsPath, 'old', 'view', Date.now() - 100 * 86400000);
        S.countEvent(statsPath, 'live', 'view');
        assert.equal(S.summary(statsPath).old, undefined);
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
