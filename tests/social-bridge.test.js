'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SP = require('../src/posting/socialPost');

const EM = { title: ['<:purplestar:1>'], desc: ['<:heart:2>'], byName: {} };
const tmpStore = () => SP.createPostsStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'posts-')), 'posts.json') });
const REC = { club: 'locus_ioe', label: 'Locus', caption: 'Hackathon 2026\nJoin us at Lab 2', hints: { title: 'Hackathon 2026', link: 'https://forms.gle/x', date: null, location: null }, url: 'https://www.instagram.com/p/abc/', image: 'https://cdn.example/a.jpg', savedAt: Date.now(), bridged: false };
const mkBot = () => ({ cache: { pendingEvents: [], postedEvents: [], skippedEvents: [] }, saves: 0, saveCache() { this.saves++; }, sanitizeEventFields() {} });
const mkInt = (customId) => ({ customId, out: [], reply(o) { this.out.push(o); return Promise.resolve(); } });

test('buildPayload has no components (clean #clubs post)', () => {
    const item = { shortcode: 'abc', caption: 'Hi', url: 'https://www.instagram.com/p/abc/' };
    const p = SP.buildPayload(item, { club: { username: 'locus_ioe', label: 'L' }, emojis: EM });
    assert.equal(p.components, undefined);
    const q = SP.buildPayload({ caption: 'Hi' }, { club: { username: 'locus_ioe', label: 'L' }, emojis: EM });
    assert.equal(q.components, undefined);
});

test('posts store: put/get/markBridged, atomic file, corrupt file untouched', () => {
    const st = tmpStore();
    assert.equal(st.get('abc'), null);
    st.put('abc', { ...REC });
    assert.equal(st.get('abc').club, 'locus_ioe');
    assert.equal(st.markBridged('abc'), true);
    assert.equal(st.get('abc').bridged, true);
    assert.equal(fs.existsSync(st.file + '.tmp'), false);
    fs.writeFileSync(st.file, '{not json');
    assert.throws(() => st.put('x', { ...REC }));
    assert.equal(fs.readFileSync(st.file, 'utf8'), '{not json');
});

test('recordPost stores hints/caption/image; skips items without shortcode', () => {
    const st = tmpStore();
    assert.equal(SP.recordPost({ caption: 'x' }, { username: 'c' }, st), false);
    SP.recordPost({ shortcode: 'zz', caption: 'Cap', hints: { type: 'hackathon' }, url: 'https://i/p/zz/', thumbnailUrl: 'https://cdn/x.jpg' }, { username: 'c', label: 'C' }, st);
    const r = st.get('zz');
    assert.equal(r.hints.type, 'hackathon');
    assert.equal(r.image, 'https://cdn/x.jpg');
    assert.equal(r.bridged, false);
});

test('buildEventFromPost maps fields, source, nulls and warnings', () => {
    const ev = SP.buildEventFromPost(REC, 'abc');
    assert.equal(ev.id, 'ig_abc');
    assert.equal(ev.source, 'instagram-locus_ioe');
    assert.equal(ev.title, 'Hackathon 2026');
    assert.equal(ev.registrationUrl, 'https://forms.gle/x');
    assert.equal(ev.url, 'https://www.instagram.com/p/abc/');
    assert.equal(ev.date, null);
    assert.equal(ev.location, null);
    assert.equal(ev.dataQualityWarnings.length, 2);
});

test('bridgeToReview: first click queues, second click is a no-op, unknown post replies expired', async () => {
    const store = tmpStore();
    store.put('abc', { ...REC });
    const bot = mkBot();
    const a = mkInt('igrev:abc:locus_ioe');
    await SP.bridgeToReview(bot, a, { store });
    assert.equal(bot.cache.pendingEvents.length, 1);
    assert.equal(bot.cache.pendingEvents[0].id, 'ig_abc');
    assert.equal(a.out[0].flags, 64);
    assert.match(a.out[0].content, /Sent "Hackathon 2026" to review.*Missing: date, location/);
    const b = mkInt('igrev:abc:locus_ioe');
    await SP.bridgeToReview(bot, b, { store });
    assert.equal(bot.cache.pendingEvents.length, 1);
    assert.match(b.out[0].content, /Already in review/);
    const c = mkInt('igrev:nope:locus_ioe');
    await SP.bridgeToReview(bot, c, { store });
    assert.match(c.out[0].content, /expired/);
    assert.equal(bot.cache.pendingEvents.length, 1);
});

test('postItems auto-queues a posted item into pending once, even when posted twice', async () => {
    const store = tmpStore();
    const bot = mkBot();
    const markers = { reserve: () => true, confirm() {}, release() {} };
    const io = { getDp: async () => null, getName: () => null, readLocal: async () => null, download: async () => { throw new Error('x'); }, ogImage: async () => { throw new Error('x'); } };
    const sent = [];
    const senderFor = async () => ({ avatarURL: undefined, send: async (p) => { sent.push(p); } });
    const item = { shortcode: 'qq1', caption: 'Hackathon 2026\nLab 2', hints: { title: 'Hackathon 2026' }, url: 'https://www.instagram.com/p/qq1/' };
    const opts = { channelId: '1', clubs: [{ username: 'c', label: 'C', enabled: true }], markers, io, senderFor, bot, postsStore: store, delayMs: 0 };
    const r1 = await SP.postItems({}, [item], opts);
    assert.equal(r1.posted, 1);
    assert.equal(r1.queued, 1);
    assert.equal(bot.cache.pendingEvents.length, 1);
    assert.equal(bot.cache.pendingEvents[0].id, 'ig_qq1');
    assert.equal(bot.cache.pendingEvents[0].source, 'instagram-c');
    assert.equal(sent[0].components, undefined);
    const r2 = await SP.postItems({}, [item], opts);
    assert.equal(r2.posted, 1);
    assert.equal(r2.queued, 0);
    assert.equal(bot.cache.pendingEvents.length, 1);
});
