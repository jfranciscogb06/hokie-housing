const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { execFileSync } = require('node:child_process');
const { storagePaths, ensureCampaigns } = require('../storage');
const S = require('../sponsorships'), { clientIp } = require('../api/client-ip');
test('server and operator use the same persistent files, without reseeding live campaigns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-storage-'));
    const source = fs.readFileSync(path.join(__dirname, '../sponsorships/campaigns.json'), 'utf8');
    try {
        const env = { ...process.env, DATA_DIR: dir }, paths = ensureCampaigns(storagePaths({ env }));
        const campaigns = S.readCampaigns(paths.campaignsPath);
        S.saveCampaigns(paths.campaignsPath, S.activate(campaigns, campaigns[0].id));
        S.countEvent(paths.statsPath, campaigns[0].id, 'view');
        ensureCampaigns(paths);
        assert.equal(S.readCampaigns(paths.campaignsPath)[0].status, 'active');
        const cwd = path.join(__dirname, '..');
        const report = execFileSync(process.execPath, ['scripts/sponsors.js', 'stats'], { cwd, env, encoding: 'utf8' });
        assert(report.includes(campaigns[0].id));
        const list = execFileSync(process.execPath, ['scripts/sponsors.js', 'list'], { cwd, env, encoding: 'utf8' });
        assert(list.includes('active'));
        execFileSync(process.execPath, ['scripts/sponsors.js', 'pause', campaigns[0].id], { cwd, env });
        assert.equal(S.readCampaigns(paths.campaignsPath)[0].status, 'paused');
        assert.equal(fs.readFileSync(paths.seedPath, 'utf8'), source);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('client IP uses the socket by default and only explicitly trusted proxy hops', () => {
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '192.0.2.99, 203.0.113.10, 10.0.0.5' } };
    assert.equal(clientIp(req, 0), '127.0.0.1');
    assert.equal(clientIp(req, 1), '10.0.0.5');
    assert.equal(clientIp(req, 2), '203.0.113.10');
    assert.equal(clientIp(req, 4), '127.0.0.1');
    assert.equal(clientIp(req, NaN), '127.0.0.1');
    req.headers['x-forwarded-for'] = 'invalid, 203.0.113.10';
    assert.equal(clientIp(req, 1), '127.0.0.1');
});
