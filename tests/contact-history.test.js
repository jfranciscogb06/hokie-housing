const { test } = require('node:test'), assert = require('node:assert/strict');
const Contacts = require('../contact-history');
test('accepted emails, drafts, calls and texts have distinct history labels and actions', () => {
    const accepted = { kind: 'inquiry', transport: 'email', outcome: 'submitted', to: 'leasing@example.com', subject: 'Inquiry: A place', body: 'Original inquiry' };
    assert.equal(Contacts.describe(accepted).label, 'Email submitted');
    assert.equal(Contacts.describe(accepted).action, 'Write follow-up');
    const next = new URL(Contacts.contactUrl(accepted));
    assert.equal(next.searchParams.get('su'), 'Re: Inquiry: A place');
    assert.equal(next.searchParams.get('body'), '');
    assert.equal(Contacts.describe({ ...accepted, transport: 'gmail', outcome: 'opened' }).label, 'Gmail draft opened');
    const text = { kind: 'text', transport: 'sms', to: '(540) 123-4567', body: 'Is it available?\nAlex' };
    assert.equal(Contacts.describe(text).label, 'Text draft opened');
    assert.equal(new URL(Contacts.contactUrl(text)).searchParams.get('body'), text.body);
    assert.equal(Contacts.describe({ kind: 'phone' }).action, 'Call again');
    assert.equal(Contacts.contactUrl({ kind: 'website', contactUrl: 'javascript:alert(1)' }), null);
});
test('old direct-send records migrate without turning genuine drafts into sent emails', () => {
    const sent = Contacts.normalize({ id: 1, kind: 'tour', via: 'Sent by Hokie Housing', to: 'leasing@example.com' });
    assert.equal(sent.outcome, 'submitted'); assert.equal(sent.transport, 'email');
    assert.equal(Contacts.describe(sent).label, 'Email submitted');
    const draft = Contacts.normalize({ kind: 'tour', via: 'Gmail' });
    assert.equal(draft.outcome, 'opened'); assert.equal(draft.transport, 'gmail');
    assert.deepEqual(Contacts.rows(Contacts.rows([sent, draft])), Contacts.rows([sent, draft]));
});
test('only the duplicate SMS/phone pair is removed, preserving intentional calls and multiple texts', () => {
    const at = '2026-10-27T12:00:00Z';
    const records = [
        { id: 1, kind: 'phone', listingId: 'a', contactUrl: 'sms:5401234567?&body=Hi', at },
        { id: 2, kind: 'inquiry', listingId: 'a', to: '5401234567', body: 'Hi', via: 'Text', at },
        { id: 3, kind: 'phone', listingId: 'a', contactUrl: 'tel:5401234567', at },
        { id: 4, kind: 'text', transport: 'sms', listingId: 'a', to: '5401234567', body: 'A second text', at },
    ];
    const rows = Contacts.rows(records);
    assert.deepEqual(rows.map(r => r.id), [2, 3, 4]);
    assert.equal(Contacts.describe(rows[0]).label, 'Text draft opened');
    assert.equal(Contacts.contactUrl(rows[2]), 'sms:5401234567?&body=A%20second%20text');
    assert.equal(records.length, 4);
});
