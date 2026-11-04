// Direct mail requires a server-verified, confirmed VT Google identity. Guests
// and installations without mail/auth configuration receive a Gmail draft fallback.
const fs = require('node:fs'), path = require('node:path');
const { clientIp } = require('./client-ip');
const root = path.join(__dirname, '..');
const LIMITS = { ipPerHour: 6, senderPerHour: 4, perDay: 300 };
function load(file) {
    const full = path.join(root, file), m = fs.statSync(full).mtimeMs;
    load.cache ||= {};
    if (load.cache[file]?.m !== m) load.cache[file] = { m, data: JSON.parse(fs.readFileSync(full, 'utf8')) };
    return load.cache[file].data;
}
function recipientFor(listingId) {
    const listing = load('data/listings.json').listings.find(l => String(l.id) === String(listingId));
    if (!listing) return { listing: null, to: null };
    const hit = listing.email ? { email: listing.email } : load('data/contacts.json').managers?.[listing.manager];
    return { listing, to: hit?.email || null };
}
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const oneLine = (v, max) => clean(v, max).replace(/[\r\n]+/g, ' ');
const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function validBody(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    if (typeof input.listingId !== 'string' || !/^[\w-]{1,80}$/.test(input.listingId)) return false;
    return ['name', 'email', 'message', 'kind', 'phone', 'moveIn', 'tourWhen', 'unit', 'website'].every(k => input[k] === undefined || typeof input[k] === 'string');
}
function compose(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Invalid message.' };
    const name = oneLine(input.name, 80), email = oneLine(input.email, 120).toLowerCase();
    const message = clean(input.message, 2000), kind = input.kind === 'tour' ? 'tour' : 'info';
    if (name.length < 2) return { error: 'Add your name.' };
    if (!/^[^\s@]+@vt\.edu$/.test(email)) return { error: 'Use your @vt.edu email so the property can reply.' };
    if (message.length < 10) return { error: 'Write a short message.' };
    return { name, email, message, kind, phone: oneLine(input.phone, 30), moveIn: oneLine(input.moveIn, 40), tourWhen: oneLine(input.tourWhen, 60), unit: oneLine(input.unit, 160) };
}
function allow(map, key, max, now) {
    if (map.size >= 10000) for (const [k, e] of map) if (now - e.start >= 3600000) map.delete(k);
    const e = map.get(key);
    if (!e && map.size >= 10000) return false;
    if (!e || now - e.start >= 3600000) { map.set(key, { start: now, count: 1 }); return true; }
    if (e.count >= max) return false;
    e.count++; return true;
}
function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}
async function readJson(req) {
    const chunks = []; let size = 0, tooLarge = false;
    for await (const chunk of req) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += b.length;
        if (size > 8000) { tooLarge = true; continue; }
        chunks.push(b);
    }
    if (tooLarge) throw new Error('too large');
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function verifiedUser(token, { fetchImpl, url, key }) {
    const base = new URL(url);
    if (base.protocol !== 'https:') throw new Error('Invalid auth configuration');
    const r = await fetchImpl(new URL('/auth/v1/user', base).href, {
        headers: { apikey: key, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { if (r.status === 401 || r.status === 403) return null; throw new Error('Auth unavailable'); }
    const user = await r.json(), email = typeof user?.email === 'string' ? user.email.toLowerCase() : '';
    const google = (user?.identities || []).some(i => i.provider === 'google' && i.identity_data?.email_verified === true && String(i.identity_data.email || '').toLowerCase() === email);
    if (!user?.id || !user.email_confirmed_at || !google || !/^[^\s@]+@vt\.edu$/.test(email)) return null;
    return { id: user.id, email };
}
async function deliver({ to, from, replyTo, subject, text, html }, { apiKey, fetchImpl }) {
    const r = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, text, html }),
    });
    if (!r.ok) throw new Error('Mail unavailable');
    return (await r.json()).id || null;
}
function createHandler({ fetchImpl = fetch, now = () => Date.now() } = {}) {
    const perIp = new Map(), perSender = new Map(); let daily = { day: '', count: 0 };
    return async function handler(req, res) {
        try {
            if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { error: 'Use POST.' }); }
            if (req.headers.origin) {
                try { const origin = new URL(req.headers.origin); if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) return send(res, 403, { error: 'Send messages from this site.' }); }
                catch { return send(res, 403, { error: 'Invalid origin.' }); }
            }
            let input;
            try { input = await readJson(req); } catch { return send(res, 400, { error: 'Invalid message.' }); }
            if (!validBody(input) || input.website) return send(res, 400, { error: 'Invalid message.' });
            const { listing, to } = recipientFor(input.listingId);
            if (!listing) return send(res, 404, { error: "That listing isn't in the catalog anymore." });
            if (!to) return send(res, 422, { error: "This property hasn't published an email. Call or text them instead.", code: 'no_email' });
            const m = compose(input);
            if (m.error) return send(res, 400, { error: m.error });
            const apiKey = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM;
            const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
            if (!apiKey || !from || !url || !key) return send(res, 503, { error: 'Open this message in Gmail.', code: 'not_configured', to });
            const authorization = req.headers.authorization;
            const token = typeof authorization === 'string' && authorization.length <= 8192 ? authorization.match(/^Bearer ([^\s]+)$/i)?.[1] : null;
            if (!token) return send(res, 401, { error: 'Use Gmail or sign in with your VT account.', code: 'verification_required', to });
            const t = now(), day = new Date(t).toISOString().slice(0, 10);
            if (daily.day !== day) daily = { day, count: 0 };
            if (daily.count >= LIMITS.perDay || !allow(perIp, clientIp(req), LIMITS.ipPerHour, t)) return send(res, 429, { error: 'Too many messages. Try again in an hour, or call the property.' });
            let identity;
            try { identity = await verifiedUser(token, { fetchImpl, url, key }); }
            catch { return send(res, 503, { error: 'Open this message in Gmail.', code: 'verification_unavailable', to }); }
            if (!identity) return send(res, 401, { error: 'Use Gmail or sign in with a verified VT Google account.', code: 'verification_required', to });
            if (identity.email !== m.email) return send(res, 403, { error: 'Use the email of your signed-in VT account.', code: 'email_mismatch' });
            if (!allow(perSender, identity.id, LIMITS.senderPerHour, t)) return send(res, 429, { error: 'Too many messages. Try again in an hour, or call the property.' });
            daily.count++;
            const what = m.unit ? `${m.unit} at ${listing.name}` : listing.name;
            const subject = oneLine(`${m.kind === 'tour' ? 'Tour request' : 'Inquiry'}: ${what}`, 200);
            const lines = [m.message, '', m.kind === 'tour' && m.tourWhen ? `Preferred tour time: ${m.tourWhen}` : null,
                m.moveIn ? `Move-in: ${m.moveIn}` : null, m.unit ? `Unit: ${m.unit}` : null,
                `From: ${m.name} <${identity.email}>${m.phone ? ` · ${m.phone}` : ''}`, `Listing: ${listing.name}${listing.address ? `, ${listing.address}` : ''}`, '',
                'Reply to this email to answer the student directly.', 'Sent through Blacksburg Housing, an independent student housing search for Virginia Tech.'].filter(x => x !== null);
            const text = lines.join('\n'), html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${lines.map(l => l ? esc(l) : '&nbsp;').join('<br>')}</div>`;
            try {
                const id = await deliver({ to, from, replyTo: identity.email, subject, text, html }, { apiKey, fetchImpl });
                const copySent = await deliver({ to: identity.email, from, replyTo: to, subject: `Sent: ${subject}`, text: `Your message was submitted to ${listing.manager || listing.name}.\n\n${text}`,
                    html: `<p>Your message was submitted to ${esc(listing.manager || listing.name)}.</p><hr>${html}` }, { apiKey, fetchImpl }).then(() => true).catch(() => false);
                return send(res, 200, { sent: true, outcome: 'submitted', id, to, toName: listing.manager || listing.name, copySent });
            } catch { daily.count--; return send(res, 502, { error: "The message couldn't be sent. Try Gmail or call the property.", code: 'send_failed', to }); }
        } catch { return send(res, 500, { error: 'Unable to process the message. Try again later.' }); }
    };
}
module.exports = createHandler();
Object.assign(module.exports, { createHandler, compose, recipientFor, LIMITS });
