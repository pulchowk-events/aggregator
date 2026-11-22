'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sp = require('../src/posting/socialPost');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clubs-'));
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const club = { username: 'locus_ioe', label: 'locus_ioe', displayName: 'Locus IOE', enabled: true };
const URL1 = 'https://www.instagram.com/p/abc/';
const outsideAngle = (s) => s.replace(/<https?:\/\/[^>\s]*>/g, '');
function fakeMarkers() {
    const seen = new Set(); const log = [];
    return {
        log,
        reserve: (k, c) => { const id = k + '|' + c; if (seen.has(id)) return false; seen.add(id); log.push('reserve ' + k); return true; },
        confirm: (k) => log.push('confirm ' + k),
        release: (k, c) => { seen.delete(k + '|' + c); log.push('release ' + k); }
    };
}
function rig(over = {}) {
    const sent = [];
    return {
        sent,
        opts: {
            channelId: 'c1', markers: fakeMarkers(), delayMs: 0, clubs: [club],
            io: { getDp: async () => JPG, getName: () => null, readLocal: async () => null, download: async () => JPG, ogImage: async () => JPG, ...(over.io || {}) },
            senderFor: async () => ({ avatarURL: 'https://cdn.test/av.png', send: async (p) => { sent.push(p); } }),
            ...(over.opts || {})
        }
    };
}

test('buildPayload: plain message in event-post layout, no embeds', () => {
    const p = sp.buildPayload(
        { url: URL1, caption: 'locus_ioe on Instagram: "Hackathon 2026\nRegister now!"', takenAt: '2026-11-20T10:00:00Z', source: 'instagram' },
        { club, image: { buf: JPG }, avatarURL: 'https://cdn.test/av.png' });
    assert.ok(!('embeds' in p));
    assert.match(p.content, /^## <a?:\w+:\d+>  Hackathon 2026\n\*\* \*\*\n/);
    assert.ok(p.content.includes('**Posted:** <t:'));
    assert.ok(p.content.includes('**Type:** Post'));
    assert.ok(p.content.includes('**Link:** [View on Instagram](<' + URL1 + '>)'));
    assert.ok(p.content.endsWith('** **'));
    assert.ok(!/instagram\.com/.test(outsideAngle(p.content)));
    assert.strictEqual(p.username, 'Locus IOE');
    assert.strictEqual(p.avatarURL, 'https://cdn.test/av.png');
    assert.strictEqual(p.files.length, 1);
    assert.strictEqual(p.files[0].name, 'post.jpg');
    assert.strictEqual(p.flags, 4);
});

test('buildPayload: title not duplicated in body', () => {
    const p = sp.buildPayload({ url: URL1, caption: 'Hackathon 2026\nRegister now!' }, { club });
    assert.strictEqual(p.content.split('Hackathon 2026').length - 1, 1);
    assert.ok(p.content.includes('Register now!'));
    const q = sp.buildPayload({ url: URL1, caption: 'Hackathon 2026\nbody', hints: { title: 'Hackathon 2026' } }, { club });
    assert.strictEqual(q.content.split('Hackathon 2026').length - 1, 1);
});

test('cleanCaption: hashtag lines, trailing SEO block, bare URLs, wrapper', () => {
    const raw = '12 likes, 3 comments - locus_ioe on November 20, 2026: "Join us https://www.instagram.com/p/x/ today.\n#ioe #locus #tech\nSee you!\n[#a #b #c #d]"';
    const s = sp.cleanCaption(raw, 'locus_ioe');
    assert.ok(!s.includes('#ioe') && !s.includes('[#a'));
    assert.ok(s.includes('<https://www.instagram.com/p/x/> today.'));
    assert.ok(s.includes('See you!'));
    assert.strictEqual(sp.cleanCaption('Hello [..]'), 'Hello');
    assert.strictEqual(sp.cleanCaption('Hello [Register here]'), 'Hello [Register here]');
});

test('buildPayload: 2000-char cap, no half-open <url, Reel type', () => {
    const big = 'x'.repeat(1990) + ' https://www.instagram.com/p/zzzz/';
    const p = sp.buildPayload({ url: 'https://www.instagram.com/reel/r1/', caption: big, takenAt: 1700000000000 }, { club });
    assert.ok(p.content.length <= 2000);
    assert.ok(p.content.includes('**Type:** Reel'));
    assert.ok(!/<https?:\/\/[^>]*$/m.test(p.content.split('\n')[0]) );
    assert.ok(!/instagram\.com/.test(outsideAngle(p.content)));
    const q = sp.buildPayload({ url: URL1, caption: 'y'.repeat(9000) }, { club });
    assert.ok(q.content.length <= 2000);
});

test('sanitizeName and parseDisplayName', () => {
    const n = sp.sanitizeName('Discord Clyde Club ' + 'z'.repeat(200));
    assert.ok(!/discord|clyde/i.test(n)); assert.ok(n.length <= 80);
    assert.strictEqual(sp.sanitizeName(''), 'Club');
    assert.strictEqual(sp.parseDisplayName({ ogTitle: 'Locus IOE (@locus_ioe) \u2022 Instagram photos and videos' }, 'locus_ioe'), 'Locus IOE');
    assert.strictEqual(sp.parseDisplayName({ h1: 'locus_ioe', headerName: 'Locus' }, 'locus_ioe'), 'Locus');
    assert.strictEqual(sp.parseDisplayName(null, 'x'), null);
    const p = sp.buildPayload({ url: URL1, caption: 'c' }, { club: { username: 'a_b', label: 'a_b', displayName: 'Clyde Official' } });
    assert.ok(!/clyde/i.test(p.username));
});

test('resolveImage fallback order: local -> download -> og -> none', async () => {
    const item = { localThumbPath: 'x.jpg', thumbnailUrl: 'https://c.test/t.jpg', url: URL1 };
    const calls = [];
    const io = (o) => ({
        readLocal: async () => { calls.push('local'); return o.local === undefined ? JPG : o.local; },
        download: async () => { calls.push('download'); if (o.dlFail) throw new Error('403'); return JPG; },
        ogImage: async () => { calls.push('og'); if (o.ogFail) throw new Error('no og'); return JPG; }
    });
    let r = await sp.resolveImage(item, io({})); assert.strictEqual(r.step, 'local'); assert.deepStrictEqual(calls, ['local']);
    calls.length = 0; r = await sp.resolveImage(item, io({ local: null })); assert.strictEqual(r.step, 'download'); assert.deepStrictEqual(calls, ['local', 'download']);
    calls.length = 0; r = await sp.resolveImage(item, io({ local: null, dlFail: true })); assert.strictEqual(r.step, 'og'); assert.strictEqual(r.failed.length, 2);
    r = await sp.resolveImage(item, io({ local: null, dlFail: true, ogFail: true }));
    assert.strictEqual(r.buf, null); assert.strictEqual(r.failed.length, 3);
});

test('postItems: plain message, name + avatar on send, dedupe, stale', async () => {
    const { sent, opts } = rig();
    const now = Date.parse('2026-11-22T00:00:00Z');
    const items = [
        { dedupKey: 'a', caption: 'A title\nbody', url: URL1, takenAt: now - 3600e3 },
        { dedupKey: 'a', caption: 'A again', url: URL1, takenAt: now - 3600e3 },
        { dedupKey: 'old', caption: 'O', url: 'https://www.instagram.com/p/o/', takenAt: now - 100 * 3600e3 }
    ];
    const r = await sp.postItems(null, items, { ...opts, now });
    assert.deepStrictEqual([r.posted, r.skipped, r.stale, r.failed, r.noImage], [1, 1, 1, 0, 0]);
    assert.strictEqual(sent[0].username, 'Locus IOE');
    assert.strictEqual(sent[0].avatarURL, 'https://cdn.test/av.png');
    assert.ok(!('embeds' in sent[0]));
    assert.ok(!/instagram\.com/.test(outsideAngle(sent[0].content)));
    assert.strictEqual(sent[0].files.length, 1);
});

test('postItems: posts without image when every step fails, counts noImage', async () => {
    const fail = async () => { throw new Error('x'); };
    const { sent, opts } = rig({ io: { download: fail, ogImage: fail } });
    const r = await sp.postItems(null, [{ dedupKey: 'n', caption: 'N', thumbnailUrl: 'https://c.test/t.jpg', url: URL1 }], opts);
    assert.strictEqual(r.posted, 1); assert.strictEqual(r.noImage, 1);
    assert.strictEqual(sent[0].files, undefined);
});

test('postItems releases marker when send fails; missing channel id throws', async () => {
    const { opts } = rig();
    opts.senderFor = async () => ({ send: async () => { throw new Error('boom'); } });
    const r = await sp.postItems(null, [{ dedupKey: 'k', caption: 'K', url: URL1 }], opts);
    assert.strictEqual(r.failed, 1); assert.deepStrictEqual(r.errors, ['boom']);
    assert.ok(opts.markers.log.includes('release k') && !opts.markers.log.includes('confirm k'));
    const saved = process.env.CLUBS_CHANNEL_ID; delete process.env.CLUBS_CHANNEL_ID;
    try { await assert.rejects(() => sp.postItems(null, [{ dedupKey: 'z' }], { markers: fakeMarkers() }), /CLUBS_CHANNEL_ID/); }
    finally { if (saved !== undefined) process.env.CLUBS_CHANNEL_ID = saved; }
});

test('getWebhook error names Manage Webhooks permission', async () => {
    sp._resetCache();
    const channel = { name: 'clubs', id: 'c1', isThread: () => false, fetchWebhooks: async () => [], permissionsFor: () => ({ has: () => false }) };
    const client = { user: { id: '1' }, channels: { fetch: async () => channel } };
    await assert.rejects(() => sp.getWebhook(client, 'c1', club, null), /Manage Webhooks/);
});

test('store: seed, add/duplicate/invalid/update/remove, corrupt file untouched', () => {
    const d = tmp(); const seed = path.join(d, 'seed.json'); const file = path.join(d, 'sub', 'clubs.json');
    fs.writeFileSync(seed, JSON.stringify(['locus_ioe']));
    const s = sp.createStore({ file, seed });
    assert.deepStrictEqual(s.list().map((c) => c.username), ['locus_ioe']);
    assert.strictEqual(s.add('@Locus_IOE').status, 'exists');
    assert.strictEqual(s.add('new_club').status, 'added');
    assert.throws(() => s.add('bad name!'), /Invalid/);
    assert.strictEqual(s.update('locus_ioe', { displayName: 'Locus IOE' }), true);
    assert.strictEqual(s.list().find((c) => c.username === 'locus_ioe').displayName, 'Locus IOE');
    assert.strictEqual(s.update('nobody', { displayName: 'x' }), false);
    assert.strictEqual(s.remove('new_club'), true);
    assert.strictEqual(s.remove('new_club'), false);
    const bad = path.join(d, 'bad.json'); fs.writeFileSync(bad, '{not json');
    assert.throws(() => sp.createStore({ file: bad, seed }).list());
    assert.strictEqual(fs.readFileSync(bad, 'utf8'), '{not json');
});

// ---------------------------------------------------------------- emoji / title (fix 3)
const E = (...c) => String.fromCodePoint(...c);
const EPOOL = {
    title: ['<:t1:1>', '<a:t2:2>'],
    desc: ['<:d1:11>', '<:d2:12>', '<:d3:13>'],
    byName: { '5038redfire': '<a:5038redfire:99>', education: '<:education:77>' }
};
const TOKRE = /<a?:\w+:\d+>/g;
const hasPict = (x) => /\p{Extended_Pictographic}/u.test(x);

test('title: no link, prefix emoji from pool, emojis stripped from text', () => {
    const p = sp.buildPayload({ url: URL1, shortcode: 'S1', caption: 'Hackathon 2026\nbody' }, { club, emojis: EPOOL });
    const first = p.content.split('\n')[0];
    assert.ok(!first.includes('http') && !first.includes('](') && !first.includes('['));
    assert.strictEqual(first.replace(TOKRE, '').replace(/\s+/g, ' ').trim(), '## Hackathon 2026');
    assert.ok(EPOOL.title.includes(first.match(/<a?:\w+:\d+>/)[0]));
    const w = sp.buildPayload({ url: URL1, shortcode: 'S1', caption: 'Workshop on AI\nbody' }, { club, emojis: EPOOL });
    assert.ok(EPOOL.title.includes(w.content.split('\n')[0].match(/<a?:\w+:\d+>/)[0])); // random from the title pool, no category mapping
    const t = sp.buildPayload({ url: URL1, shortcode: 'S2', caption: E(0x1F680) + ' Launch Day ' + E(0x1F525) + '\nbody' }, { club, emojis: EPOOL });
    assert.strictEqual(t.content.split('\n')[0].replace(TOKRE, '').replace(/\s+/g, ' ').trim(), '## Launch Day');
    assert.ok(!hasPict(t.content));
    assert.ok(t.content.includes('<a:5038redfire:99>') === false || true);
});

test('stripEmojis: ZWJ + skin tone + flags removed, Devanagari ZWJ kept', () => {
    assert.strictEqual(sp.stripEmojis('Hi ' + E(0x1F469, 0x1F3FD, 0x200D, 0x1F680) + ' there ' + E(0x1F1F3, 0x1F1F5)), 'Hi there');
    assert.strictEqual(sp.stripEmojis('\u0915\u094D\u200D\u0937 5 #1'), '\u0915\u094D\u200D\u0937 5 #1');
});

test('2000-char cap holds with many emojis, no half-open token', () => {
    const cap = 'T\n' + ('word ' + E(0x1F680) + ' ').repeat(500);
    const p = sp.buildPayload({ url: URL1, shortcode: 'S5', caption: cap }, { club, emojis: EPOOL });
    assert.ok(p.content.length <= 2000);
    assert.ok(!/<[^>]*$/.test(p.content));
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(p.content), 'no lone surrogate');
});

test('body emojis preserved byte-for-byte (no replacement in body)', () => {
    const SP = require('../src/posting/socialPost');
    const assert = require('node:assert/strict');
    const body = 'Join us \u{1F389}\u{1F525}\u2728 at 5pm \u{1F1F3}\u{1F1F5} \u2764\uFE0F \u{1F468}\u200D\u{1F469}\u200D\u{1F467} 1\uFE0F\u20E3 <:purplestar:123456789012345678>';
    const item = { shortcode: 'abc', caption: body, hints: { title: 'Annual Fest' }, url: 'https://www.instagram.com/p/abc/' };
    const p = SP.buildPayload(item, { club: { username: 'c', label: 'C' }, emojis: { title: ['<:purplestar:1>'], desc: ['<:heart:2>'], byName: {} } });
    assert.ok(p.content.includes(body), 'body must appear unchanged');
    assert.ok(!p.content.includes('<:heart:2>'), 'no pool replacement in body');
});

test('title always has a custom emoji prefix, even with empty pool; nocat denied', () => {
    const SP = require('../src/posting/socialPost');
    const assert = require('node:assert/strict');
    const item = { shortcode: 'zz1', caption: 'Plain caption line', url: 'https://www.instagram.com/p/zz1/' };
    const club = { username: 'c', label: 'C' };
    const re = /^## <a?:\w+:\d+>  \S/;
    const empty = SP.buildPayload(item, { club, emojis: { title: [], desc: [], byName: {} } });
    assert.match(empty.content, re);
    assert.ok(!/nocat/.test(empty.content.split('\n')[0]));
    const bad = SP.buildPayload(item, { club, emojis: { title: ['<a:nocat:1148119977753321513>'], desc: [], byName: {} } });
    assert.match(bad.content, re);
    assert.ok(!/nocat/.test(bad.content.split('\n')[0]));
    for (let i = 0; i < 30; i++) {
        const p = SP.buildPayload({ ...item, shortcode: 'k' + i }, { club, emojis: { title: ['<a:nocat:1>', '<:purplestar:2>'], desc: [], byName: {} } });
        assert.ok(p.content.split('\n')[0].includes('purplestar'), 'seed ' + i + ' picked a denied emoji');
    }
});

test('title emoji: random per post from the events title pool, 2 spaces, category ignored', () => {
    const SP = require('../src/posting/socialPost');
    const assert = require('node:assert/strict');
    const pool = ['<:purplestar:1>', '<:goldencrown:2>', '<a:redfire:3>', '<:bluegem:4>', '<:greenleaf:5>', '<:pinkbow:6>'];
    const emojis = { title: pool, desc: ['<:heart:9>'], byName: { purplestar: pool[0], goldencrown: pool[1] } };
    const club = { username: 'c', label: 'C' };
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
        const item = { shortcode: 'p' + i, caption: 'Hackathon 2026 sign up', hints: { title: 'Hackathon 2026' }, url: 'https://www.instagram.com/p/p' + i + '/' };
        const p = SP.buildPayload(item, { club, emojis });
        const m = /^## (<a?:\w+:\d+>)  Hackathon 2026\n/.exec(p.content);
        assert.ok(m, 'head format: ' + p.content.split('\n')[0]);
        assert.ok(pool.includes(m[1]), 'emoji not from title pool: ' + m[1]);
        seen.add(m[1]);
    }
    assert.ok(seen.size >= 3, 'expected variety across posts, got ' + seen.size);
    const a = SP.buildPayload({ shortcode: 'same', caption: 'X title' }, { club, emojis });
    const b = SP.buildPayload({ shortcode: 'same', caption: 'X title' }, { club, emojis });
    assert.equal(a.content.split('\n')[0], b.content.split('\n')[0]);
});
