'use strict';
// Offline tests for src/integrations/websiteSync/clubImages.js and the enrich step in clubs.js.
// No network: the supabase client is a fake with a storage API injected through require.cache,
// global.fetch is stubbed per test, local files and downloads go through an injected io.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;
const P = (...a) => path.join(ROOT, 'src', ...a);
const BUCKET = 'club-posts';
const ABUCKET = 'club-avatars';
const BASE = 'http://fake.invalid';
const PUB = BASE + '/storage/v1/object/public/' + BUCKET + '/';
const PUBA = BASE + '/storage/v1/object/public/' + ABUCKET + '/';
const MB5 = 5 * 1024 * 1024;

function makeFake(o) {
    const opts = o || {};
    const uploads = [];
    return {
        uploads,
        storage: {
            from(bucket) {
                return {
                    upload(p, buf, uo) {
                        if (opts.throwUpload) throw new Error('network down');
                        uploads.push({ bucket, path: p, size: buf.length, contentType: uo && uo.contentType, upsert: uo && uo.upsert });
                        if (opts.failUpload) return Promise.resolve({ data: null, error: { message: 'bucket not found' } });
                        return Promise.resolve({ data: { path: p }, error: null });
                    }
                };
            }
        },
        from() { return { upsert() { return Promise.resolve({ error: null }); } }; }
    };
}

function stub(request, exportsObj) {
    const p = require.resolve(request);
    const m = new Module(p);
    m.filename = p; m.loaded = true; m.exports = exportsObj;
    require.cache[p] = m;
    return p;
}

function setup(opts) {
    const o = opts || {};
    Object.keys(require.cache).forEach((k) => { if (k.startsWith(SRC_PREFIX)) delete require.cache[k]; });
    const fake = makeFake(o);
    const sbPath = stub('@supabase/supabase-js', { createClient: () => fake });
    const alPath = stub(P('core', 'auditLogger'), { auditLog: () => {} });

    const env = require(P('config', 'env'));
    const configured = o.configured !== false;
    env.WEBSITE_SUPABASE_URL = configured ? BASE : '';
    env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY = configured ? 'fake-key' : '';
    env.WEBSITE_SYNC_ENABLED = true;
    env.WEBSITE_SYNC_DRY_RUN = !!o.dryRun;
    delete process.env.WEBSITE_CLUBS_CONFIRM_HOST;
    if (o.confirmHost === 'unset') delete env.WEBSITE_CLUBS_CONFIRM_HOST; else env.WEBSITE_CLUBS_CONFIRM_HOST = o.confirmHost || 'fake.invalid';
    env.DEV_MODE = !!o.devMode;
    delete process.env.WEBSITE_CLUBS_IMAGES_ENABLED;
    delete process.env.WEBSITE_CLUBS_BUCKET;
    delete env.WEBSITE_CLUBS_BUCKET;
    delete process.env.WEBSITE_CLUBS_SYNC_ENABLED;
    if (o.imagesEnabled) env.WEBSITE_CLUBS_IMAGES_ENABLED = true; else delete env.WEBSITE_CLUBS_IMAGES_ENABLED;
    env.WEBSITE_CLUBS_SYNC_ENABLED = true;

    const engine = require(P('integrations', 'websiteSync', 'engine'));
    const images = require(P('integrations', 'websiteSync', 'clubImages'));
    const clubs = require(P('integrations', 'websiteSync', 'clubs'));

    const origFetch = global.fetch;
    const logs = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a) => { logs.push(a.join(' ')); };
    console.warn = (...a) => { logs.push(a.join(' ')); };
    console.error = (...a) => { logs.push(a.join(' ')); };

    return {
        fake, env, engine, images, clubs, logs,
        restore() {
            console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
            global.fetch = origFetch;
            delete require.cache[sbPath];
            delete require.cache[alPath];
        }
    };
}

async function run(opts, fn) {
    const h = setup(opts);
    try { await fn(h); } finally { h.restore(); }
}

const buf = (n) => Buffer.alloc(n, 1);
function mkIo(local, remote) {
    const io = { reads: [], dirs: [], downloads: [] };
    io.readLocal = (p) => {
        const b = path.basename(p);
        io.reads.push(b); io.dirs.push(path.basename(path.dirname(p)));
        return (local && local[b]) || null;
    };
    io.download = async (url) => {
        io.downloads.push(url);
        const r = remote && remote[url];
        if (!r) throw new Error('HTTP 404');
        return r;
    };
    return io;
}
function resp(o) {
    const b = o.body || Buffer.alloc(0);
    const hd = o.headers || {};
    return {
        ok: o.ok !== false, status: o.status || 200,
        headers: { get: (k) => (hd[String(k).toLowerCase()] == null ? null : hd[String(k).toLowerCase()]) },
        arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length)
    };
}
const NULLS = { imageUrl: null, imagePath: null };
const REC = (over) => Object.assign({
    club: 'locus_ioe', label: 'LOCUS, IOE Pulchowk',
    caption: 'Online Project Exhibition | LOCUS', hints: null,
    url: 'https://www.instagram.com/p/Sc1/', image: 'https://example.invalid/a.webp', postedAt: 1792331524000
}, over || {});
const CLUB = { username: 'locus_ioe', label: 'locus_ioe', displayName: 'LOCUS, IOE Pulchowk' };

// ------------------------------------------------------------ source order
test('source order: local thumb first, webp then jpg then jpeg then png, no download', () => run({}, async (h) => {
    const io = mkIo({ 'Sc1.png': buf(10) }, { 'https://cdn.invalid/x.jpg': { buf: buf(5), contentType: 'image/jpeg' } });
    const r = await h.images.uploadPostImage('Sc1', 'locus_ioe', io, 'https://cdn.invalid/x.jpg');
    assert.deepEqual(io.reads, ['Sc1.webp', 'Sc1.jpg', 'Sc1.jpeg', 'Sc1.png']);
    assert.ok(io.dirs.every((d) => d === 'thumbs'));
    assert.equal(io.downloads.length, 0);
    assert.equal(r.imagePath, 'locus_ioe/Sc1.png');
    assert.equal(r.imageUrl, PUB + 'locus_ioe/Sc1.png');
    assert.equal(h.fake.uploads.length, 1);
    assert.deepEqual(h.fake.uploads[0], { bucket: BUCKET, path: 'locus_ioe/Sc1.png', size: 10, contentType: 'image/png', upsert: true });
}));

test('source order: webp wins when several local files exist; path and content-type per extension', () => run({}, async (h) => {
    const io = mkIo({ 'Sc2.webp': buf(3), 'Sc2.jpg': buf(4) });
    const r = await h.images.uploadPostImage('Sc2', 'locus_ioe', io, null);
    assert.deepEqual(io.reads, ['Sc2.webp']);
    assert.equal(r.imagePath, 'locus_ioe/Sc2.webp');
    assert.equal(h.fake.uploads[0].contentType, 'image/webp');
    const r2 = await h.images.uploadPostImage('Sc3', { username: 'locus_ioe' }, mkIo({ 'Sc3.jpeg': buf(2) }), null);
    assert.equal(r2.imagePath, 'locus_ioe/Sc3.jpeg');
    assert.equal(h.fake.uploads[1].contentType, 'image/jpeg');
    const r3 = await h.images.uploadPostImage('Sc4', 'locus_ioe', mkIo({ 'Sc4.jpg': buf(2) }), null);
    assert.equal(r3.imagePath, 'locus_ioe/Sc4.jpg');
    assert.equal(h.fake.uploads[2].contentType, 'image/jpeg');
}));

test('source order: no local file -> one CDN fetch, extension from the real content-type', () => run({}, async (h) => {
    const url = 'https://cdn.invalid/p/a.jpg';
    const io = mkIo({}, { [url]: { buf: buf(9), contentType: 'image/webp' } });
    const r = await h.images.uploadPostImage('Cd1', 'locus_ioe', io, url);
    assert.deepEqual(io.downloads, [url]);
    assert.equal(r.imagePath, 'locus_ioe/Cd1.webp');
    assert.equal(h.fake.uploads[0].contentType, 'image/webp');
}));

test('source order: neither local nor CDN -> nulls, nothing uploaded', () => run({}, async (h) => {
    const io = mkIo({}, {});
    assert.deepEqual(await h.images.uploadPostImage('None1', 'locus_ioe', io, null), NULLS);
    assert.deepEqual(await h.images.uploadPostImage('None2', 'locus_ioe', io, 'not-a-url'), NULLS);
    assert.equal(h.fake.uploads.length, 0);
    assert.equal(io.downloads.length, 0);
}));

test('CDN download failure -> nulls and one log line, no throw', () => run({}, async (h) => {
    const io = mkIo({}, {});
    const r = await h.images.uploadPostImage('Cd2', 'locus_ioe', io, 'https://cdn.invalid/missing.jpg');
    assert.deepEqual(r, NULLS);
    assert.equal(h.fake.uploads.length, 0);
    assert.ok(h.logs.some((l) => l.indexOf('[clubImages]') >= 0 && l.indexOf('Cd2') >= 0));
}));

// ------------------------------------------------------------ size cap and non-image
test('size cap: 5 MB exactly is fine, one byte over is rejected, content-length is honoured', () => run({}, async (h) => {
    global.fetch = async () => resp({ body: buf(MB5 + 1), headers: { 'content-type': 'image/jpeg' } });
    await assert.rejects(() => h.images.defaultIo.download('https://cdn.invalid/big.jpg'), /bad image size/);
    global.fetch = async () => resp({ body: buf(10), headers: { 'content-type': 'image/jpeg', 'content-length': String(6 * 1024 * 1024) } });
    await assert.rejects(() => h.images.defaultIo.download('https://cdn.invalid/big2.jpg'), /too large/);
    global.fetch = async () => resp({ body: buf(MB5), headers: { 'content-type': 'image/webp' } });
    const d = await h.images.defaultIo.download('https://cdn.invalid/ok.webp');
    assert.equal(d.buf.length, MB5);
    assert.equal(d.contentType, 'image/webp');
    global.fetch = async () => resp({ body: buf(MB5 + 1), headers: { 'content-type': 'image/jpeg' } });
    const io = { readLocal: () => null, download: h.images.defaultIo.download };
    assert.deepEqual(await h.images.uploadPostImage('Big1', 'locus_ioe', io, 'https://cdn.invalid/big.jpg'), NULLS);
    assert.equal(h.fake.uploads.length, 0);
}));

test('non-image responses are rejected: html, svg, http error, bad custom io result', () => run({}, async (h) => {
    global.fetch = async () => resp({ body: buf(10), headers: { 'content-type': 'text/html; charset=utf-8' } });
    await assert.rejects(() => h.images.defaultIo.download('https://cdn.invalid/p'), /not an image/);
    global.fetch = async () => resp({ body: buf(10), headers: { 'content-type': 'image/svg+xml' } });
    await assert.rejects(() => h.images.defaultIo.download('https://cdn.invalid/s.svg'), /unsupported image type/);
    global.fetch = async () => resp({ ok: false, status: 404, body: buf(1), headers: { 'content-type': 'image/jpeg' } });
    await assert.rejects(() => h.images.defaultIo.download('https://cdn.invalid/gone.jpg'), /HTTP 404/);
    const url = 'https://cdn.invalid/liar.jpg';
    const io = mkIo({}, { [url]: { buf: buf(10), contentType: 'text/html' } });
    assert.deepEqual(await h.images.uploadPostImage('Bad1', 'locus_ioe', io, url), NULLS);
    assert.equal(h.fake.uploads.length, 0);
}));

// ------------------------------------------------------------ DRY_RUN / DEV_MODE
test('DRY_RUN: no upload, would-be path and url returned and printed', () => run({ dryRun: true }, async (h) => {
    const io = mkIo({ 'Sc1.webp': buf(10), 'locus_ioe.jpg': buf(4) });
    const r = await h.images.uploadPostImage('Sc1', 'locus_ioe', io, null);
    assert.deepEqual(r, { imageUrl: PUB + 'locus_ioe/Sc1.webp', imagePath: 'locus_ioe/Sc1.webp' });
    assert.equal(await h.images.uploadAvatar('locus_ioe', io), PUBA + 'locus_ioe.jpg');
    const io2 = mkIo({}, {});
    const c = await h.images.uploadPostImage('Cdn1', 'locus_ioe', io2, 'https://cdn.invalid/p/a.png?x=1');
    assert.equal(c.imagePath, 'locus_ioe/Cdn1.png');
    assert.equal(io2.downloads.length, 0, 'dry run does not fetch the CDN');
    assert.equal(h.fake.uploads.length, 0);
    const printed = h.logs.join('\n');
    assert.ok(printed.indexOf('DRY RUN') >= 0);
    assert.ok(printed.indexOf('locus_ioe/Sc1.webp') >= 0);
    assert.ok(printed.indexOf('club-avatars/locus_ioe.jpg') >= 0);
}));

test('DEV_MODE: no upload, would-be path and url returned and printed', () => run({ devMode: true }, async (h) => {
    const io = mkIo({ 'Sc1.jpg': buf(10), 'locus_ioe.jpg': buf(4) });
    const r = await h.images.uploadPostImage('Sc1', 'locus_ioe', io, null);
    assert.equal(r.imagePath, 'locus_ioe/Sc1.jpg');
    assert.equal(r.imageUrl, PUB + 'locus_ioe/Sc1.jpg');
    assert.equal(await h.images.uploadAvatar('locus_ioe', io), PUBA + 'locus_ioe.jpg');
    assert.equal(h.fake.uploads.length, 0);
    assert.ok(h.logs.join('\n').indexOf('DEV_MODE') >= 0);
}));

// ------------------------------------------------------------ failures never throw
test('failure = nulls: storage error, storage throw, bad names, not configured', async () => {
    await run({ failUpload: true }, async (h) => {
        const io = mkIo({ 'Sc1.webp': buf(5), 'locus_ioe.jpg': buf(5) });
        assert.deepEqual(await h.images.uploadPostImage('Sc1', 'locus_ioe', io, null), NULLS);
        assert.equal(await h.images.uploadAvatar('locus_ioe', io), null);
        assert.ok(h.logs.some((l) => l.indexOf('bucket not found') >= 0));
    });
    await run({ throwUpload: true }, async (h) => {
        const io = mkIo({ 'Sc1.webp': buf(5), 'locus_ioe.jpg': buf(5) });
        assert.deepEqual(await h.images.uploadPostImage('Sc1', 'locus_ioe', io, null), NULLS);
        assert.equal(await h.images.uploadAvatar('locus_ioe', io), null);
    });
    await run({}, async (h) => {
        const io = mkIo({ 'x.webp': buf(5) });
        assert.deepEqual(await h.images.uploadPostImage('../etc', 'locus_ioe', io, null), NULLS);
        assert.deepEqual(await h.images.uploadPostImage('', 'locus_ioe', io, null), NULLS);
        assert.deepEqual(await h.images.uploadPostImage('Sc1', '', io, null), NULLS);
        assert.equal(await h.images.uploadAvatar('', io), null);
        assert.equal(io.reads.length, 0, 'bad names never touch the filesystem');
    });
    await run({ configured: false }, async (h) => {
        const io = mkIo({ 'Sc1.webp': buf(5), 'locus_ioe.jpg': buf(5) });
        assert.deepEqual(await h.images.uploadPostImage('Sc1', 'locus_ioe', io, null), NULLS);
        assert.equal(await h.images.uploadAvatar('locus_ioe', io), null);
        assert.equal(h.fake.uploads.length, 0);
    });
});

// ------------------------------------------------------------ avatar
test('avatar: data/instagram/dp/<club>.jpg -> club-avatars/<club>.jpg, public url returned', () => run({}, async (h) => {
    const io = mkIo({ 'locus_ioe.jpg': buf(7) });
    const url = await h.images.uploadAvatar('locus_ioe', io);
    assert.equal(url, PUBA + 'locus_ioe.jpg');
    assert.deepEqual(io.dirs, ['dp']);
    assert.deepEqual(h.fake.uploads[0], { bucket: ABUCKET, path: 'locus_ioe.jpg', size: 7, contentType: 'image/jpeg', upsert: true });
    assert.equal(await h.images.uploadAvatar({ username: 'locus_ioe' }, mkIo({ 'locus_ioe.jpg': buf(2) })), url);
    assert.equal(await h.images.uploadAvatar('no_dp_club', mkIo({})), null);
    assert.equal(h.fake.uploads.length, 2);
}));

// ------------------------------------------------------------ enrich step in clubs.js
test('enrich: off by default, same row object back, no reads, no uploads', () => run({}, async (h) => {
    const io = mkIo({ 'Sc1.webp': buf(5), 'locus_ioe.jpg': buf(5) });
    const row = h.clubs.postToRow(REC(), 'Sc1', CLUB, {});
    assert.equal(await h.clubs.enrichPostRow(row, REC(), io), row);
    const crow = h.clubs.clubToRow(CLUB, null);
    assert.equal(await h.clubs.enrichClubRow(crow, io), crow);
    assert.equal(h.clubs.imagesEnabled(), false);
    assert.equal(io.reads.length, 0);
    assert.equal(h.fake.uploads.length, 0);
}));

test('enrich: on sets image_url/image_path and avatar_url on copies, keeps existing values', () => run({ imagesEnabled: true }, async (h) => {
    const io = mkIo({ 'Sc1.webp': buf(5), 'locus_ioe.jpg': buf(5) });
    const row = h.clubs.postToRow(REC(), 'Sc1', CLUB, {});
    const out = await h.clubs.enrichPostRow(row, REC(), io);
    assert.equal(out.image_url, PUB + 'locus_ioe/Sc1.webp');
    assert.equal(out.image_path, 'locus_ioe/Sc1.webp');
    assert.ok(!('image_url' in row), 'input row not mutated');
    const crow = h.clubs.clubToRow(CLUB, null);
    const cout = await h.clubs.enrichClubRow(crow, io);
    assert.equal(cout.avatar_url, PUBA + 'locus_ioe.jpg');
    assert.ok(!('avatar_url' in crow), 'input club row not mutated');
    const before = io.reads.length;
    const kept = h.clubs.clubToRow(CLUB, 'https://x.invalid/dp.jpg');
    assert.equal(await h.clubs.enrichClubRow(kept, io), kept);
    const have = h.clubs.postToRow(REC(), 'Sc1', CLUB, { imageUrl: 'https://x.invalid/i.webp', imagePath: 'p/i.webp' });
    assert.equal(await h.clubs.enrichPostRow(have, REC(), io), have);
    assert.equal(io.reads.length, before, 'already-filled rows are not re-read');
}));

test('enrich: CDN url from the record is used when there is no local file; failures keep the row', async () => {
    await run({ imagesEnabled: true }, async (h) => {
        const url = 'https://example.invalid/a.webp';
        const io = mkIo({}, { [url]: { buf: buf(6), contentType: 'image/webp' } });
        const row = h.clubs.postToRow(REC(), 'Sc9', CLUB, {});
        const out = await h.clubs.enrichPostRow(row, REC({ image: url }), io);
        assert.deepEqual(io.downloads, [url]);
        assert.equal(out.image_path, 'locus_ioe/Sc9.webp');
    });
    await run({ imagesEnabled: true, failUpload: true }, async (h) => {
        const row = h.clubs.postToRow(REC(), 'Sc1', CLUB, {});
        const out = await h.clubs.enrichPostRow(row, REC(), mkIo({ 'Sc1.webp': buf(5) }));
        assert.equal(out, row);
        assert.ok(!('image_url' in out));
    });
});

test('buckets are club-posts and club-avatars, club-media is gone', () => run({}, async (h) => {
    assert.equal(h.images.POSTS_BUCKET, 'club-posts');
    assert.equal(h.images.AVATARS_BUCKET, 'club-avatars');
    assert.equal(h.images.bucketName, undefined);
    const r = await h.images.uploadPostImage('Sc1', 'locus_ioe', mkIo({ 'Sc1.webp': buf(5) }), null);
    const a = await h.images.uploadAvatar('locus_ioe', mkIo({ 'locus_ioe.jpg': buf(5) }));
    assert.deepEqual(h.fake.uploads.map((u) => u.bucket), ['club-posts', 'club-avatars']);
    assert.equal(r.imageUrl, BASE + '/storage/v1/object/public/club-posts/locus_ioe/Sc1.webp');
    assert.equal(a, BASE + '/storage/v1/object/public/club-avatars/locus_ioe.jpg');
    assert.ok(h.fake.uploads.every((u) => u.bucket !== 'club-media'));
}));
