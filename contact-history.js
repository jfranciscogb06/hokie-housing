(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.HousingContacts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function normalize(m) {
        const transport = m.transport || (m.via === 'Sent by Hokie Housing' ? 'email' : m.via === 'Text' || m.kind === 'text' || /^sms:/i.test(m.contactUrl || '') ? 'sms' : m.kind === 'phone' ? 'phone' : m.kind === 'website' ? 'website' : m.via === 'mail app' ? 'mail-app' : 'gmail');
        const outcome = m.outcome || (m.via === 'Sent by Hokie Housing' ? 'submitted' : 'opened');
        let body = m.body || '';
        if (m.kind === 'phone' && transport === 'sms') {
            try { body = new URL(m.contactUrl).searchParams.get('body') || body; } catch {}
        }
        return { ...m, kind: transport === 'sms' ? 'text' : m.kind, transport, outcome, body,
            via: ({ email: 'Email', gmail: 'Gmail', sms: 'Text', phone: 'Phone', website: 'Website', 'mail-app': 'Mail app' })[transport] || m.via };
    }
    function rows(records) {
        if (!Array.isArray(records)) return [];
        // Older Text clicks recorded a phone action and a second inquiry. Migrate
        // only matching pairs, preserving separate intentional calls/texts.
        return records.filter(m => m && typeof m === 'object').filter(m => !(m.kind === 'phone' && /^sms:/i.test(m.contactUrl || '') && records.some(n => n && n !== m && n.via === 'Text' && n.listingId === m.listingId && Math.abs(Date.parse(n.at) - Date.parse(m.at)) < 1000))).map(normalize);
    }
    function describe(record) {
        const m = normalize(record), submitted = m.transport === 'email' && m.outcome === 'submitted';
        const label = submitted ? 'Email submitted' : ({ gmail: 'Gmail draft opened', sms: 'Text draft opened', phone: 'Call opened', website: 'Website opened', 'mail-app': 'Email draft opened' })[m.transport] || 'Contact opened';
        return { label, tone: submitted ? 'green' : m.transport === 'website' ? 'faint' : 'maroon',
            detail: submitted ? 'Accepted by the email service. Inbox delivery has not been confirmed.' : 'Opened on this device; completion has not been confirmed.',
            action: submitted ? 'Write follow-up' : ({ gmail: 'Open Gmail draft', sms: 'Open text draft', phone: 'Call again', website: 'Open website', 'mail-app': 'Open mail app' })[m.transport] || 'Open contact',
            toast: submitted ? 'Message submitted' : label };
    }
    function contactUrl(record) {
        const m = normalize(record);
        if (m.contactUrl) {
            try { if (['http:', 'https:', 'tel:', 'sms:', 'mailto:'].includes(new URL(m.contactUrl).protocol)) return m.contactUrl; } catch {}
        }
        if (m.transport === 'sms' || m.transport === 'phone') {
            const phone = String(m.to || '').replace(/[^\d+]/g, '');
            return phone ? m.transport === 'sms' ? `sms:${phone}?&body=${encodeURIComponent(m.body)}` : `tel:${phone}` : null;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.to || '')) return null;
        const submitted = m.transport === 'email' && m.outcome === 'submitted';
        const subject = submitted ? `Re: ${(m.subject || '').replace(/^Re:\s*/i, '')}` : m.subject || '';
        const body = submitted ? '' : m.body;
        return m.transport === 'mail-app' ? `mailto:${encodeURIComponent(m.to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(m.to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    }
    return { normalize, rows, describe, contactUrl };
});
