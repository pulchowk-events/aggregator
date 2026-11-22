'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SE = require('../src/posting/socialEnrich');
const SP = require('../src/posting/socialPost');

const HOUR = 3600000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const IGJ = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const EXP = Buffer.from([0x89, 0x50, 0x4e, 0x47, 7, 7]);
const IMG_URL = 'https://cdn.example.org/og.jpg';
const quiet = () => {};
const same = (u) => u;
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-'));
const OG = (title, image) => '<html><head><meta property="og:title" content="' + title + '"><meta property="og:image" content="' + image + '"></head><body>x</body></html>';

function mkCache() {
    const file = path.join(tmpDir(), 'cache.json');
    const c = { t: 1700000000000 };
    c.now = () => c.t;
    return { file, c, cache: SE.createCache({ file, now: c.now }) };
}
function mkIo(over = {}) {
    const io = { calls: { html: [], img: [] } };
    io.fetchHtml = async (u) => {
        io.calls.html.push(u);
        if (over.html) return over.html(u);
        return { html: OG('Expo Title', IMG_URL), finalUrl: u };
    };
    io.fetchImage = async (u) => {
        io.calls.img.push(u);
        if (over.img) return over.img(u);
        return PNG;
    };
    return io;
}
const rsp = (status, headers = {}, body = '') => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const h = {};
    for (const k of Object.keys(headers)) h[k.toLowerCase()] = headers[k];
    return {
        status, ok: status >= 200 && status < 300,
        headers: { get: (k) => (h[String(k).toLowerCase()] !== undefined ? h[String(k).toLowerCase()] : null) },
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    };
};
const pubLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const HTML_H = { 'content-type': 'text/html; charset=utf-8' };

test('isPublicIp: private, loopback, link-local, CGNAT, mapped and unique-local are rejected', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(SE.isPublicIp(ip), true, ip);
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.1.2.3', 'not-an-ip']) assert.equal(SE.isPublicIp(ip), false, ip);
});

test('checkUrl: scheme, credentials, ports, local names and literal private IPs', () => {
    assert.equal(SE.checkUrl('https://example.org/a').href, 'https://example.org/a');
    assert.equal(SE.checkUrl('http://example.org:80/x').hostname, 'example.org');
    for (const bad of ['ftp://example.org/', 'file:///etc/passwd', 'http://user:pw@example.org/', 'http://example.org:8080/', 'http://localhost/', 'http://127.0.0.1/', 'https://[::1]/', 'http://2130706433/', 'http://foo.internal/', 'http://10.0.0.1/', 'not a url']) {
        assert.throws(() => SE.checkUrl(bad), Error, bad);
    }
});

test('fetchHtmlSafe: host resolving to a private address is refused before any request', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return rsp(200, HTML_H, '<html></html>'); };
    await assert.rejects(SE.fetchHtmlSafe('https://example.org/', { fetchImpl, lookup: async () => [{ address: '10.0.0.1', family: 4 }] }), /non-public/);
    await assert.rejects(SE.fetchHtmlSafe('https://example.org/', { fetchImpl, lookup: async () => [{ address: '93.184.216.34' }, { address: '192.168.0.9' }] }), /non-public/);
    assert.equal(calls, 0);
});

test('fetchHtmlSafe: redirects are re-validated (private host, file scheme, bad port)', async () => {
    const lookup = async (h) => (h === 'internal.example' ? [{ address: '192.168.0.5' }] : [{ address: '93.184.216.34' }]);
    for (const [loc, re] of [['http://internal.example/admin', /non-public/], ['file:///etc/passwd', /scheme/], ['http://127.0.0.1:8080/', /port|non-public/]]) {
        let calls = 0;
        const fetchImpl = async () => { calls++; return rsp(302, { location: loc }); };
        await assert.rejects(SE.fetchHtmlSafe('https://example.org/', { fetchImpl, lookup }), re, loc);
        assert.equal(calls, 1, loc);
    }
});

test('fetchHtmlSafe: at most 3 redirects', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return rsp(302, { location: '/next' }); };
    await assert.rejects(SE.fetchHtmlSafe('https://example.org/', { fetchImpl, lookup: pubLookup }), /redirect/);
    assert.equal(calls, 4);
});

test('fetchHtmlSafe: non-html content-type and HTTP errors are rejected', async () => {
    await assert.rejects(SE.fetchHtmlSafe('https://example.org/', { fetchImpl: async () => rsp(200, { 'content-type': 'application/pdf' }, 'x'), lookup: pubLookup }), /content-type/);
    await assert.rejects(SE.fetchHtmlSafe('https://example.org/', { fetchImpl: async () => rsp(404, HTML_H, ''), lookup: pubLookup }), /HTTP 404/);
});

test('fetchHtmlSafe: html is truncated at 512 KB, not rejected', async () => {
    const big = '<meta property="og:title" content="T">' + 'x'.repeat(600 * 1024);
    const r = await SE.fetchHtmlSafe('https://example.org/', { fetchImpl: async () => rsp(200, HTML_H, big), lookup: pubLookup });
    assert.equal(r.html.length, 512 * 1024);
    assert.ok(r.html.indexOf('og:title') >= 0);
});

test('fetchHtmlSafe: follows a public redirect and reports the final url', async () => {
    let n = 0;
    const fetchImpl = async () => { n++; return n === 1 ? rsp(301, { location: 'https://www.example.org/final' }) : rsp(200, HTML_H, OG('T', IMG_URL)); };
    const r = await SE.fetchHtmlSafe('https://example.org/start', { fetchImpl, lookup: pubLookup });
    assert.equal(r.finalUrl, 'https://www.example.org/final');
    assert.ok(r.html.indexOf('og:title') >= 0);
});

test('fetchImageSafe: image only, size capped, non-empty', async () => {
    const ok = await SE.fetchImageSafe('https://cdn.example.org/a.png', { fetchImpl: async () => rsp(200, { 'content-type': 'image/png' }, PNG), lookup: pubLookup });
    assert.ok(ok.equals(PNG));
    await assert.rejects(SE.fetchImageSafe('https://cdn.example.org/a.png', { fetchImpl: async () => rsp(200, HTML_H, 'x'), lookup: pubLookup }), /content-type/);
    await assert.rejects(SE.fetchImageSafe('https://cdn.example.org/a.png', { fetchImpl: async () => rsp(200, { 'content-type': 'image/png', 'content-length': '9999999' }, PNG), lookup: pubLookup }), /too large/);
    await assert.rejects(SE.fetchImageSafe('https://cdn.example.org/a.png', { fetchImpl: async () => rsp(200, { 'content-type': 'image/png' }, Buffer.alloc(0)), lookup: pubLookup }), /empty/);
});

test('fetchHtmlSafe: per-hop timeout aborts the request', async () => {
    const fetchImpl = (u, o) => new Promise((resolve, reject) => {
        o.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
    await assert.rejects(SE.fetchHtmlSafe('https://example.org/', { fetchImpl, lookup: pubLookup, timeoutMs: 30 }), /timeout/);
});

test('parseOg: attribute order, quotes, entities, relative image, fallbacks', () => {
    const a = SE.parseOg('<meta content="Hello &amp; Welcome" property="og:title"><meta content=\'/img/p.png\' property=\'og:image\'>', 'https://example.org/a/b');
    assert.deepEqual(a, { title: 'Hello & Welcome', image: 'https://example.org/img/p.png' });
    const b = SE.parseOg('<title> My   Page </title><meta name="twitter:image" content="https://x.org/t.jpg">', 'https://example.org/');
    assert.deepEqual(b, { title: 'My Page', image: 'https://x.org/t.jpg' });
    assert.deepEqual(SE.parseOg('<html></html>', 'https://example.org/'), { title: null, image: null });
    const c = SE.parseOg('<meta property="twitter:image" content="https://x.org/t.jpg"><meta property="og:image" content="https://x.org/og.jpg">', 'https://example.org/');
    assert.equal(c.image, 'https://x.org/og.jpg');
    assert.equal(SE.parseOg('<meta property="og:title" content="It&#39;s &#x27;ok&#x27;">', 'https://e.org/').title, "It's 'ok'");
});

test('pickLink: hints.link first, scheme-less links, punctuation, Instagram and denied hosts skipped', () => {
    assert.equal(SE.pickLink({ caption: 'Register Now : bit.ly/Online_Project_Expo\nmore' }), 'https://bit.ly/Online_Project_Expo');
    assert.equal(SE.pickLink({ caption: 'Details at https://example.org/a.' }), 'https://example.org/a');
    assert.equal(SE.pickLink({ caption: 'visit www.example.org/page now' }), 'https://www.example.org/page');
    assert.equal(SE.pickLink({ hints: { link: 'https://example.org/h' }, caption: 'https://example.org/c' }), 'https://example.org/h');
    assert.equal(SE.pickLink({ hints: { link: 'https://forms.gle/x' }, caption: 'go https://example.org/e' }), 'https://example.org/e');
    assert.equal(SE.pickLink({ caption: 'https://www.instagram.com/p/abc/ and instagram.com/p/zzz/' }), null);
    assert.equal(SE.pickLink({ caption: 'https://docs.google.com/forms/d/1/viewform https://linktr.ee/club' }), null);
    assert.equal(SE.pickLink({ caption: 'mail info@example.org/x or say hello e.g. this' }), null);
    assert.equal(SE.pickLink({}), null);
});

test('enrichLink: title + image + bytes; one html fetch per unique link, persisted across restarts', async () => {
    const { file, c, cache } = mkCache();
    const io = mkIo();
    const deps = { io, cache, sanitizeImage: same, log: quiet };
    const a = await SE.enrichLink('https://example.org/event', deps);
    assert.equal(a.title, 'Expo Title');
    assert.equal(a.image, IMG_URL);
    assert.ok(a.bytes.equals(PNG));
    await SE.enrichLink('https://example.org/event#frag', deps);
    assert.equal(io.calls.html.length, 1);
    const cache2 = SE.createCache({ file, now: c.now });
    const b = await SE.enrichLink('https://example.org/event', { io, cache: cache2, sanitizeImage: same, log: quiet });
    assert.equal(b.title, 'Expo Title');
    assert.equal(io.calls.html.length, 1);
});

test('enrichLink: failures are negative-cached for 6h, then retried', async () => {
    const { c, cache } = mkCache();
    const io = mkIo({ html: async () => { throw new Error('boom'); } });
    const deps = { io, cache, sanitizeImage: same, log: quiet };
    const u = 'https://example.org/neg';
    assert.equal(await SE.enrichLink(u, deps), null);
    assert.equal(await SE.enrichLink(u, deps), null);
    assert.equal(io.calls.html.length, 1);
    c.t += 5 * HOUR;
    assert.equal(await SE.enrichLink(u, deps), null);
    assert.equal(io.calls.html.length, 1);
    c.t += 2 * HOUR;
    assert.equal(await SE.enrichLink(u, deps), null);
    assert.equal(io.calls.html.length, 2);
});

test('enrichLink: hits expire after 7 days', async () => {
    const { c, cache } = mkCache();
    const io = mkIo();
    const deps = { io, cache, sanitizeImage: same, log: quiet };
    const u = 'https://example.org/ttl';
    await SE.enrichLink(u, deps);
    c.t += 6 * 24 * HOUR;
    await SE.enrichLink(u, deps);
    assert.equal(io.calls.html.length, 1);
    c.t += 2 * 24 * HOUR;
    await SE.enrichLink(u, deps);
    assert.equal(io.calls.html.length, 2);
});

test('enrichLink: corrupt cache file is never overwritten; enrichment still works', async () => {
    const { file, cache } = mkCache();
    fs.writeFileSync(file, 'not json{');
    const io = mkIo();
    const deps = { io, cache, sanitizeImage: same, log: quiet };
    const r = await SE.enrichLink('https://example.org/corrupt', deps);
    assert.equal(r.title, 'Expo Title');
    await SE.enrichLink('https://example.org/corrupt', deps);
    assert.equal(io.calls.html.length, 2);
    assert.equal(fs.readFileSync(file, 'utf8'), 'not json{');
    assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('enrichLink: Instagram links and hard-denied hosts are never fetched', async () => {
    const { cache } = mkCache();
    const io = mkIo();
    const deps = { io, cache, sanitizeImage: same, log: quiet };
    for (const u of ['https://www.instagram.com/p/abc/', 'https://l.instagram.com/?u=x', 'instagram.com/p/x/', 'https://forms.gle/abc', 'https://docs.google.com/forms/d/x', 'https://linktr.ee/club']) {
        assert.equal(await SE.enrichLink(u, deps), null, u);
    }
    assert.equal(io.calls.html.length, 0);
});

test('enrichLink: shortener is followed, but denied when it (or a form host) is the FINAL host', async () => {
    let r = await SE.enrichLink('https://bit.ly/ok1', { io: mkIo({ html: (u) => ({ html: OG('Real', IMG_URL), finalUrl: 'https://events.example.org/real' }) }), cache: mkCache().cache, sanitizeImage: same, log: quiet });
    assert.equal(r.title, 'Real');
    for (const fin of ['https://bit.ly/stuck', 'https://tinyurl.com/stuck', 'https://t.co/stuck', 'https://docs.google.com/forms/d/e/1/viewform', 'https://forms.gle/z', 'https://linktr.ee/club']) {
        const io = mkIo({ html: () => ({ html: OG('Form', IMG_URL), finalUrl: fin }) });
        r = await SE.enrichLink('https://bit.ly/x' + Math.random().toString(36).slice(2), { io, cache: mkCache().cache, sanitizeImage: same, log: quiet });
        assert.equal(r, null, fin);
        assert.equal(io.calls.img.length, 0, fin);
    }
});

test('enrichLink: concurrent calls for one link share a single html fetch', async () => {
    const { cache } = mkCache();
    const io = mkIo({ html: async (u) => { await new Promise((r) => setTimeout(r, 20)); return { html: OG('Slow', IMG_URL), finalUrl: u }; } });
    const deps = { io, cache, sanitizeImage: same, log: quiet };
    const rs = await Promise.all([SE.enrichLink('https://example.org/dedupe', deps), SE.enrichLink('https://example.org/dedupe', deps)]);
    assert.equal(io.calls.html.length, 1);
    assert.equal(rs[0].title, 'Slow');
    assert.equal(rs[1].title, 'Slow');
});

test('enrichLink: image failure keeps the title; sanitizer rejection drops the image', async () => {
    let io = mkIo({ img: async () => { throw new Error('img boom'); } });
    let r = await SE.enrichLink('https://example.org/imgfail', { io, cache: mkCache().cache, sanitizeImage: same, log: quiet });
    assert.equal(r.title, 'Expo Title');
    assert.equal(r.bytes, null);
    io = mkIo();
    r = await SE.enrichLink('https://example.org/sanitize', { io, cache: mkCache().cache, sanitizeImage: () => null, log: quiet });
    assert.equal(r.title, 'Expo Title');
    assert.equal(r.image, null);
    assert.equal(r.bytes, null);
    assert.equal(io.calls.img.length, 0);
});

test('enrichLink: page without og data is null and negative-cached', async () => {
    const { cache } = mkCache();
    const io = mkIo({ html: (u) => ({ html: '<html><head></head></html>', finalUrl: u }) });
    const deps = { io, cache, sanitizeImage: same, log: quiet };
    assert.equal(await SE.enrichLink('https://example.org/none', deps), null);
    assert.equal(await SE.enrichLink('https://example.org/none', deps), null);
    assert.equal(io.calls.html.length, 1);
});

test('enrichSafe: hard timeout resolves null quickly even if the fetch hangs', async () => {
    const io = mkIo({ html: () => new Promise(() => {}) });
    const t0 = Date.now();
    const r = await SE.enrichSafe('https://example.org/hang', { io, cache: mkCache().cache, sanitizeImage: same, log: quiet }, 30);
    assert.equal(r, null);
    assert.ok(Date.now() - t0 < 1500);
});

test('enrichForItem: kill switch, missing fetchHtml, no link and enrich:false all skip', async () => {
    const item = { caption: 'see https://example.org/gate' };
    const base = (io, extra) => Object.assign({ enrichCache: mkCache().cache, enrichSanitize: same, enrichLog: quiet }, extra || {});
    let io = mkIo();
    assert.equal((await SE.enrichForItem(item, io, base(io))).title, 'Expo Title');
    io = mkIo();
    assert.equal(await SE.enrichForItem(item, io, base(io, { env: { IG_ENRICH: '0' } })), null);
    assert.equal(await SE.enrichForItem(item, io, base(io, { enrich: false })), null);
    assert.equal(await SE.enrichForItem({ caption: 'no link here' }, io, base(io)), null);
    assert.equal(io.calls.html.length, 0);
    assert.equal(await SE.enrichForItem(item, { download: async () => IGJ }, base(io)), null);
});

// ---------------------------------------------------------------- postItems integration (injected io, no network)
const club = { username: 'locus_ioe', label: 'Locus', displayName: 'Locus IOE', enabled: true };
const NOW = Date.parse('2026-11-21T12:00:00Z');
const mkItem = (over = {}) => Object.assign({ shortcode: 'abc', url: 'https://www.instagram.com/p/abc/', caption: 'locus_ioe on Instagram: "Online Expo\nRegister: https://example.org/expo"', takenAt: '2026-11-20T10:00:00Z', thumbnailUrl: 'https://cdn.example/ig.jpg' }, over);
function fakeMarkers() {
    const seen = new Set();
    return {
        reserve: (k, c) => { const id = k + '|' + c; if (seen.has(id)) return false; seen.add(id); return true; },
        confirm: () => {},
        release: (k, c) => { seen.delete(k + '|' + c); }
    };
}
function rigPost(over = {}) {
    const sent = [];
    const dir = tmpDir();
    const pstore = SP.createPostsStore({ file: path.join(dir, 'posts.json') });
    const ec = SE.createCache({ file: path.join(dir, 'ec.json') });
    const io = Object.assign(mkIo(over), { getDp: async () => IGJ, getName: () => null, readLocal: async () => null, download: async () => IGJ, ogImage: async () => IGJ });
    io.fetchImage = async (u) => { io.calls.img.push(u); return EXP; };
    const opts = Object.assign({
        channelId: 'c1', markers: fakeMarkers(), delayMs: 0, clubs: [club], io, now: NOW,
        senderFor: async () => ({ avatarURL: 'https://cdn.test/av.png', send: async (p) => { sent.push(p); } }),
        postsStore: pstore, enrichCache: ec, enrichSanitize: same, enrichLog: quiet
    }, over.opts || {});
    return { sent, pstore, io, opts };
}

test('postItems: link og:image replaces the IG thumbnail; og:title goes to the record, not the post', async () => {
    const r = rigPost();
    const res = await SP.postItems(null, [mkItem()], r.opts);
    assert.equal(res.posted, 1);
    assert.deepEqual(r.io.calls.html, ['https://example.org/expo']);
    assert.ok(r.sent[0].files[0].attachment.equals(EXP));
    assert.ok(r.sent[0].content.indexOf('Expo Title') < 0);
    assert.equal(r.pstore.get('abc').linkTitle, 'Expo Title');
});

test('postItems: enrichment failure never blocks the post and falls back to the IG thumbnail', async () => {
    const r = rigPost({ html: async () => { throw new Error('site down'); } });
    const res = await SP.postItems(null, [mkItem()], r.opts);
    assert.equal(res.posted, 1);
    assert.equal(res.failed, 0);
    assert.ok(r.sent[0].files[0].attachment.equals(IGJ));
    assert.equal(r.pstore.get('abc').linkTitle, undefined);
});

test('postItems: Instagram-only link, denied final host, kill switch and hints.link', async () => {
    let r = rigPost();
    await SP.postItems(null, [mkItem({ caption: 'locus_ioe on Instagram: "Hello https://www.instagram.com/p/zzz/"' })], r.opts);
    assert.equal(r.io.calls.html.length, 0);
    assert.ok(r.sent[0].files[0].attachment.equals(IGJ));

    r = rigPost({ html: () => ({ html: OG('Form', IMG_URL), finalUrl: 'https://docs.google.com/forms/d/e/1/viewform' }) });
    await SP.postItems(null, [mkItem()], r.opts);
    assert.ok(r.sent[0].files[0].attachment.equals(IGJ));
    assert.equal(r.pstore.get('abc').linkTitle, undefined);

    r = rigPost({ opts: { env: { IG_ENRICH: '0' } } });
    await SP.postItems(null, [mkItem()], r.opts);
    assert.equal(r.io.calls.html.length, 0);
    assert.ok(r.sent[0].files[0].attachment.equals(IGJ));

    r = rigPost();
    await SP.postItems(null, [mkItem({ caption: 'locus_ioe on Instagram: "Hello"', hints: { link: 'https://example.org/via-hint' } })], r.opts);
    assert.deepEqual(r.io.calls.html, ['https://example.org/via-hint']);
    assert.ok(r.sent[0].files[0].attachment.equals(EXP));
});

test('postItems: a duplicate post (marker already reserved) triggers no enrichment fetch', async () => {
    const r = rigPost();
    await SP.postItems(null, [mkItem()], r.opts);
    assert.equal(r.io.calls.html.length, 1);
    const res = await SP.postItems(null, [mkItem()], r.opts);
    assert.equal(res.skipped, 1);
    assert.equal(r.io.calls.html.length, 1);
});

test('buildEventFromPost: linkTitle is used only when hints.title is empty', () => {
    const rec = { club: 'locus_ioe', label: 'Locus', caption: 'First line\nrest', hints: {}, linkTitle: 'Expo Title', url: 'https://www.instagram.com/p/abc/', image: null };
    assert.equal(SP.buildEventFromPost(rec, 'abc').title, 'Expo Title');
    assert.equal(SP.buildEventFromPost(Object.assign({}, rec, { hints: { title: 'Hint T' } }), 'abc').title, 'Hint T');
    assert.equal(SP.buildEventFromPost(Object.assign({}, rec, { linkTitle: undefined }), 'abc').title, 'First line');
});
