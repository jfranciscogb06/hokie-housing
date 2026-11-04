const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const Search = require('../housing-search'), Eligibility = require('../eligibility'), Catalog = require('../catalog'), Contacts = require('../contact-history');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(x => x[1]).join('\n');
function app({ fetchImpl = async () => { throw Error('unexpected fetch'); }, filter, ref } = {}) {
    const events = [], opens = [];
    const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
        useState: initial => [filter && initial?.max === 9999 && 'audience' in initial ? filter : typeof initial === 'function' ? initial() : initial, () => {}],
        useEffect() {}, useMemo: f => f(), useRef: () => ({ current: ref || null }) };
    const document = { getElementById() {} };
    const ctx = vm.createContext({ HousingSearch: Search, HousingEligibility: Eligibility, HousingCatalog: Catalog, HousingContacts: Contacts,
        React, ReactDOM: { createRoot: () => ({ render() {} }) }, window: { open: (...args) => opens.push(args), matchMedia: () => ({ matches: false }) }, document, console, URL, URLSearchParams, fetch: fetchImpl,
        props: { l: { id: 'fixture', name: 'Fixture property', price: 700, phone: '(540) 123-4567' }, kind: 'info', user: { name: 'Alex', email: 'alex@vt.edu' }, onClose() {}, onSent: (...args) => events.push({ event: 'sent', args }), onContact: (...args) => events.push({ event: 'contact', args }) } });
    vm.runInContext(fs.readFileSync(require.resolve('../data/listings.js'), 'utf8'), ctx); vm.runInContext(source, ctx);
    return { ctx, events, opens, document };
}
function elements(tree) { return Array.isArray(tree) ? tree.flatMap(elements) : tree && typeof tree === 'object' ? [tree, ...(tree.children || []).flatMap(elements)] : []; }
test('the selected floor plan takes priority over a different plan with the same bedrooms', () => {
    const a = app();
    a.ctx.photoFixture = { photos: ['exterior'], photosByBeds: { '4': ['four-bed-room'] }, planPhotos: { '4': 'generic-four-bed-plan' } };
    const result = vm.runInContext('photosFor(photoFixture, 4, {name:"D2",image:"specific-D2-plan"})', a.ctx);
    assert.equal(result.list[0], 'specific-D2-plan');
    assert.equal(result.list[1], 'four-bed-room');
    assert.equal(result.tag, 'D2 floor plan');
    assert.equal(new Set(result.list).size, result.list.length);
});
for (const signedIn of [false, true]) test(`${signedIn ? 'Signed-in students' : 'Guests'} open a Gmail draft without accessing accounts or sending mail`, () => {
    const a = app();
    vm.runInContext('useRecipient = () => ({to:"leasing@example.com",ready:true}); supabaseClient = () => {throw Error("Contact must not access accounts")};', a.ctx);
    if (signedIn) a.ctx.props.user.id = 'signed-in-fixture';
    const form = elements(vm.runInContext('InquiryModal(props)', a.ctx)).find(e => e.type === 'form');
    form.props.onSubmit({ preventDefault() {} });
    assert.equal(a.opens.length, 1); assert.equal(a.events.length, 1);
    assert.equal(a.events[0].args[2].transport, 'gmail'); assert.equal(a.events[0].args[2].outcome, 'opened');
    const url = new URL(a.opens[0][0]);
    assert.equal(url.searchParams.get('to'), 'leasing@example.com');
    assert.equal(url.searchParams.get('su'), 'Inquiry: Fixture property');
    assert.match(url.searchParams.get('body'), /Alex/);
});
test('one Text click records exactly one action, matching the composed text URL', () => {
    const a = app(); vm.runInContext('useRecipient = () => ({to:null,ready:true});', a.ctx);
    const text = elements(vm.runInContext('InquiryModal(props)', a.ctx)).find(e => e.type === 'a' && e.props.href?.startsWith('sms:'));
    text.props.onClick();
    assert.equal(a.events.length, 1); assert.equal(a.events[0].event, 'contact');
    assert.equal(a.events[0].args[1], 'text'); assert.equal(a.events[0].args[2], text.props.href);
    assert.equal(new URL(text.props.href).searchParams.get('body').endsWith('\nAlex'), true);
});
test('Explore excludes the real over-budget plan while matching the map and card prices', () => {
    const a = app({ filter: { max: 800, beds: 4, walk: 9999, furnished: false, utilities: false, pets: false, bus: 0, lease: 0, audience: '' } });
    const raw = JSON.parse(fs.readFileSync(require.resolve('../data/listings.json'))).listings;
    a.ctx.fixtures = [raw.find(l => l.name === 'Uptown Village'), { id: 'affordable', name: 'Affordable fixture', price: 500, beds: 4, baths: 4, walk: 20, photos: ['image'], plans: [{ beds: 4, baths: 4, price: 500, basis: 'bed' }] }];
    vm.runInContext('useAISearch = () => ({parsed:HousingSearch.local("4 bedrooms entire apartment under $4000"),status:"local"});', a.ctx);
    const tree = vm.runInContext('Explore({listings:fixtures,saved:[],compare:[],interests:{},initialQuery:"4 bedrooms entire apartment under $4000"})', a.ctx);
    const nodes = elements(tree), cardType = vm.runInContext('ListingCard', a.ctx), mapType = vm.runInContext('MapView', a.ctx);
    const cards = nodes.filter(e => e.type === cardType);
    assert.equal(cards.length, 1); assert.equal(cards[0].props.l.id, 'affordable'); assert.equal(cards[0].props.matchingPlans[0].price, 500);
    const map = nodes.find(e => e.type === mapType);
    assert.equal(map.props.listings.length, 1); assert.equal(map.props.listings[0].mapPrice, 500);
});
test('dialog Escape closes and Tab skips the offscreen honeypot', () => {
    let focused = 0, closed = 0, prevented = 0;
    const first = { tabIndex: 0, disabled: false, getAttribute: () => null, getClientRects: () => [1], focus: () => focused++ };
    const honey = { ...first, tabIndex: -1, getAttribute: () => 'true' };
    const a = app({ ref: { querySelectorAll: () => [first, honey] } }); a.document.activeElement = first;
    a.ctx.dialogProps = { label: 'Request info', onClose: () => closed++ };
    const panel = vm.runInContext('DialogPanel(dialogProps)', a.ctx);
    panel.props.onKeyDown({ key: 'Tab', shiftKey: false, preventDefault: () => prevented++ });
    assert.equal(prevented, 1); assert.equal(focused, 1);
    panel.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); assert.equal(closed, 1);
});
