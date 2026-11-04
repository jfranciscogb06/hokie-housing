const { isIP } = require('node:net');
// Forwarded headers are untrusted unless the operator specifies the exact number
// of trusted proxy hops and prevents access that bypasses those proxies.
function clientIp(req, hops = Number(process.env.TRUST_PROXY_HOPS || 0)) {
    const peer = req.socket?.remoteAddress || 'unknown';
    if (!Number.isInteger(hops) || hops < 1 || hops > 10) return peer;
    const header = req.headers['x-forwarded-for'];
    if (typeof header !== 'string' || header.length > 2048) return peer;
    const chain = header.split(',').map(s => s.trim());
    if (chain.length < hops || chain.some(s => !isIP(s))) return peer;
    return chain[chain.length - hops];
}
module.exports = { clientIp };
