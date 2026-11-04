const { test } = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { createServer } = require('../server');
async function withServer(fn, handlers) {
    const server = createServer(handlers);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try { await fn(`http://127.0.0.1:${server.address().port}`); }
    finally { await new Promise(resolve => server.close(resolve)); }
}
test('legacy message endpoint cannot send mail and the server stays healthy', async () => {
    await withServer(async base => {
        for (const body of ['null', '[]', '42', '{"listingId":{"toString":1}}', 'false']) {
            const r = await fetch(base + '/api/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
            assert.equal(r.status, 410); assert.equal((await r.json()).code, 'gmail_only');
            assert.equal((await fetch(base + '/')).status, 200);
        }
        assert.equal((await fetch(base + '/contact-history.js')).status, 200);
        assert.equal((await fetch(base + '/storage.js')).status, 404);
        assert.equal((await fetch(base + '/data/raw/placards.json')).status, 404);
        assert.equal((await fetch(base + '/data/scrape.log')).status, 404);
        assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true });
    });
});
test('unexpected rejected route promises return a generic 500 without killing the server', async () => {
    await withServer(async base => {
        const r = await fetch(base + '/api/message', { method: 'POST', body: '{}' });
        assert.equal(r.status, 500);
        assert(!JSON.stringify(await r.json()).includes('private detail'));
        assert.equal((await fetch(base + '/')).status, 200);
    }, { message: async () => { throw Error('private detail'); } });
});
test('public configuration publishes only a validated support address', async () => {
    const previous = process.env.SUPPORT_EMAIL;
    try {
        process.env.SUPPORT_EMAIL = 'support@example.com';
        await withServer(async base => {
            let body = await (await fetch(base + '/site-config.js')).text();
            assert.equal(body, 'window.HOUSING_CONFIG = {"contactEmail":"support@example.com"};');
            process.env.SUPPORT_EMAIL = 'not-an-email<script>';
            body = await (await fetch(base + '/site-config.js')).text();
            assert.equal(body, 'window.HOUSING_CONFIG = {"contactEmail":""};');
        });
    } finally {
        if (previous === undefined) delete process.env.SUPPORT_EMAIL;
        else process.env.SUPPORT_EMAIL = previous;
    }
});
