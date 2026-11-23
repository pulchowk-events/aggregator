'use strict';
// Offline tests for session 6: schema guard, null-image safety, host guard, hook, backfill,
// orphan cleanup, club takedown, wiring. No network: fake supabase (tables + storage) via require.cache.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;
const P = (...a) => path.join(ROOT, 'src', ...a);
const BASE = 'http://fake.invalid';
const OLD = '2020-01-01T00:00:00.000Z';
const POSTS = 'club_posts';

// Column lists copied from the clubs SQL record (session 1).
const CLUB_COLS = ['username', 'display_name', 'avatar_url', 'enabled', 'created_at', 'updated_at'];
const POST_COLS = ['id', 'bot_dedup_key', 'origin', 'shortcode', 'club_username', 'caption', 'post_url', 'image_url', 'image_path', 'is_event', 'post_type', 'posted_at', 'synced_at'];
const POST_REQUIRED = ['id', 'bot_dedup_key', 'shortcode', 'club_username', 'post_url', 'posted_at'];

function makeFake(o) {
    const opts = o || {};
    const tables = {}; const buckets = {};
    const calls = { upsert: [], delete: [], upload: [], remove: [] };
    const tbl = (n) => (tables[n] || (tables[n] = new Map()));
    const bk = (n) => (buckets[n] || (buckets[n] = new Map()));
    return {
        calls,
        seedRow(name, row, keyCol) { tbl(name).set(String(row[keyCol || 'id']), Object.assign({}, row)); },
        seedFile(bucket, p, ts) { bk(bucket).set(p, { created_at: ts || OLD }); },
        rows(name) { return Array.from(tbl(name).values()); },
        hasFile(bucket, p) { return bk(bucket).has(p); },
        fileCount(bucket) { return bk(bucket).size; },
        from(name) {
            return {
                upsert(payload, uo) {
                    const rows = Array.isArray(payload) ? payload : [payload];
                    const col = (uo && uo.onConflict) || 'id';
                    calls.upsert.push({ table: name, count: rows.length, onConflict: col });
                    if (opts.failTable === name) return Promise.resolve({ error: { message: 'forced failure' } });
                    rows.forEach((r) => tbl(name).set(String(r[col]), Object.assign({}, tbl(name).get(String(r[col])) || {}, r)));
                    return Promise.resolve({ error: null });
                },
                select() {
                    return {
                        range(a, b) {
                            const data = Array.from(tbl(name).values()).slice(a, b + 1).map((r) => Object.assign({}, r));
                            return Promise.resolve({ data, error: null });
                        }
                    };
                },
                delete() {
                    return {
                        eq(col, val) {
                            calls.delete.push({ table: name, col, val });
                            Array.from(tbl(name).entries()).forEach(([k, r]) => { if (r[col] === val) tbl(name).delete(k); });
                            return Promise.resolve({ error: null });
                        }
                    };
                }
            };
        },
        storage: {
            from(bucket) {
                return {
                    upload(p, b, uo) {
                        calls.upload.push({ bucket, path: p, contentType: uo && uo.contentType });
                        bk(bucket).set(p, { created_at: new Date().toISOString() });
                        return Promise.resolve({ data: { path: p }, error: null });
                    },
                    list(prefix, lo) {
                        const pre = prefix ? prefix + '/' : '';
                        const seen = new Map();
                        bk(bucket).forEach((meta, p) => {
                            if (!p.startsWith(pre)) return;
                            const rest = p.slice(pre.length);
                            const i = rest.indexOf('/');
                            if (i < 0) seen.set(rest, { name: rest, id: 'f:' + p, created_at: meta.created_at, updated_at: meta.created_at });
                            else { const d = rest.slice(0, i); if (!seen.has(d)) seen.set(d, { name: d, id: null }); }
                        });
                        const arr = Array.from(seen.values());
                        const off = (lo && lo.offset) || 0; const lim = (lo && lo.limit) || 100;
                        return Promise.resolve({ data: arr.slice(off, off + lim), error: null });
                    },
                    remove(paths) {
                        calls.remove.push({ bucket, paths: paths.slice() });
                        paths.forEach((p) => bk(bucket).delete(p));
                        return Promise.resolve({ data: paths.map((p) => ({ name: p })), error: null });
                    }
                };
            }
        }
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
    env.DEV_MODE = !!o.devMode;
    env.WEBSITE_SYNC_BATCH_SIZE = 2;
    env.WEBSITE_SYNC_BATCH_DELAY_MS = 1;
    env.WEBSITE_REVALIDATE_URL = BASE + '/api/revalidate';
    env.WEBSITE_REVALIDATE_SECRET = 'test-secret';
    ['WEBSITE_CLUBS_SYNC_ENABLED', 'WEBSITE_CLUBS_IMAGES_ENABLED', 'WEBSITE_CLUBS_TABLE', 'WEBSITE_CLUB_POSTS_TABLE', 'WEBSITE_CLUBS_CONFIRM_HOST'].forEach((k) => { delete process.env[k]; });
    delete env.WEBSITE_CLUBS_TABLE; delete env.WEBSITE_CLUB_POSTS_TABLE;
    if (o.confirmHost === 'unset') delete env.WEBSITE_CLUBS_CONFIRM_HOST; else env.WEBSITE_CLUBS_CONFIRM_HOST = o.confirmHost || 'fake.invalid';
    env.WEBSITE_CLUBS_SYNC_ENABLED = o.clubsEnabled === false ? false : true;
    if (o.imagesEnabled) env.WEBSITE_CLUBS_IMAGES_ENABLED = true; else delete env.WEBSITE_CLUBS_IMAGES_ENABLED;

    const engine = require(P('integrations', 'websiteSync', 'engine'));
    const clubs = require(P('integrations', 'websiteSync', 'clubs'));
    const images = require(P('integrations', 'websiteSync', 'clubImages'));
    const ops = require(P('integrations', 'websiteSync', 'clubsOps'));

    const fetches = [];
    const origFetch = global.fetch;
    global.fetch = async (url, init) => { fetches.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
    const logs = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a) => { logs.push(a.join(' ')); };
    console.warn = (...a) => { logs.push(a.join(' ')); };
    console.error = (...a) => { logs.push(a.join(' ')); };
    return {
        fake, env, engine, clubs, images, ops, logs, fetches,
        restore() {
            console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
            global.fetch = origFetch;
            delete require.cache[sbPath]; delete require.cache[alPath];
        }
    };
}
async function run(opts, fn) {
    const h = setup(opts);
    try { await fn(h); } finally { h.restore(); }
}

const buf = (n) => Buffer.alloc(n, 1);
const mkIo = (local) => ({ readLocal: (p) => (local && local[path.basename(p)]) || null, download: async () => { throw new Error('HTTP 404'); } });
const REC = (over) => Object.assign({
    club: 'locus_ioe', label: 'LOCUS, IOE Pulchowk',
    caption: 'Online Project Exhibition | LOCUS Register now and submit your entry',
    hints: null, url: 'https://www.instagram.com/p/Deo1UA6hr7T/', image: 'https://example.invalid/a.webp', postedAt: 1792331524000
}, over || {});
const CLUB = { username: 'locus_ioe', label: 'locus_ioe', displayName: 'LOCUS, IOE Pulchowk' };
const IT = (sc, over) => Object.assign({ url: 'https://www.instagram.com/p/' + sc + '/', caption: 'Online Project Exhibition | LOCUS Register now', postedAt: 1792331524000 }, over || {});
const waitFor = async (fn) => { for (let i = 0; i < 100; i++) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };
const subset = (keys, cols) => keys.filter((k) => cols.indexOf(k) < 0);

// ------------------------------------------------------------ schema guard
test('schema guard: row keys are a subset of the SQL columns, required columns always present', () => run({}, (h) => {
    const posts = [
        h.clubs.postToRow(REC(), 'S1', CLUB, {}),
        h.clubs.postToRow(REC(), 'S2', CLUB, { imageUrl: 'https://x.invalid/i.webp', imagePath: 'locus_ioe/S2.webp' })
    ];
    const clubRows = [h.clubs.clubToRow(CLUB, null), h.clubs.clubToRow(CLUB, 'https://x.invalid/dp.jpg'), h.clubs.clubToRow({ username: 'bare_club' }, null)];
    posts.forEach((r) => {
        assert.deepEqual(subset(Object.keys(r), POST_COLS), [], 'unknown club_posts column');
        POST_REQUIRED.forEach((c) => assert.ok(r[c] !== undefined && r[c] !== null, 'required column ' + c));
        assert.equal(typeof r.is_event, 'boolean');
    });
    clubRows.forEach((r) => {
        assert.deepEqual(subset(Object.keys(r), CLUB_COLS), [], 'unknown clubs column');
        assert.ok(r.username);
    });
}));

// ------------------------------------------------------------ null-image bug
test('null-image bug: upsert with image then without keeps the stored URL (posts and club avatar)', () => run({}, async (h) => {
    const withImg = h.clubs.postToRow(REC(), 'N1', CLUB, { imageUrl: 'https://x.invalid/i.webp', imagePath: 'locus_ioe/N1.webp' });
    const without = h.clubs.postToRow(REC({ caption: 'edited caption' }), 'N1', CLUB, {});
    assert.ok(!('image_url' in without) && !('image_path' in without));
    await h.clubs.upsertClubPost(withImg);
    await h.clubs.upsertClubPost(without);
    const stored = h.fake.rows(POSTS);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].image_url, 'https://x.invalid/i.webp');
    assert.equal(stored[0].image_path, 'locus_ioe/N1.webp');
    assert.ok(/edited/.test(stored[0].caption), 'other columns still update');
    await h.clubs.syncClubs(null, [h.clubs.clubToRow(CLUB, 'https://x.invalid/dp.jpg')]);
    await h.clubs.syncClubs(null, [h.clubs.clubToRow({ username: 'locus_ioe' }, null)]);
    const c = h.fake.rows('clubs');
    assert.equal(c.length, 1);
    assert.equal(c[0].avatar_url, 'https://x.invalid/dp.jpg');
    assert.equal(c[0].display_name, 'LOCUS, IOE Pulchowk');
}));

test('syncClubs groups rows by key shape so a batch never mixes optional columns', () => run({}, async (h) => {
    const rows = [h.clubs.clubToRow({ username: 'a_club' }, 'https://x.invalid/a.jpg'), h.clubs.clubToRow({ username: 'b_club' }, null), h.clubs.clubToRow({ username: 'c_club' }, 'https://x.invalid/c.jpg')];
    await h.clubs.syncClubs(null, rows);
    const ups = h.fake.calls.upsert.filter((c) => c.table === 'clubs');
    assert.equal(ups.length, 2);
    assert.deepEqual(ups.map((c) => c.count).sort(), [1, 2]);
    assert.equal(h.fake.rows('clubs').length, 3);
}));

// ------------------------------------------------------------ host guard
test('host guard: live writes are refused unless WEBSITE_CLUBS_CONFIRM_HOST matches', async () => {
    for (const confirmHost of ['unset', 'other.invalid']) {
        await run({ confirmHost, imagesEnabled: true }, async (h) => {
            const io = mkIo({ 'G1.webp': buf(5), 'locus_ioe.jpg': buf(5) });
            const row = h.clubs.postToRow(REC(), 'G1', CLUB, {});
            const r1 = await h.clubs.syncClubs(null, [h.clubs.clubToRow(CLUB, null)]);
            const r2 = await h.clubs.syncClubPosts(null, [row]);
            const r3 = await h.clubs.upsertClubPost(row);
            const up = await h.images.uploadPostImage('G1', 'locus_ioe', io, null);
            const av = await h.images.uploadAvatar('locus_ioe', io);
            [r1, r2, r3].forEach((r) => { assert.equal(r.ok, false); assert.equal(r.reason, 'host_not_confirmed'); });
            assert.deepEqual(up, { imageUrl: null, imagePath: null });
            assert.equal(av, null);
            assert.equal(h.fake.calls.upsert.length, 0);
            assert.equal(h.fake.calls.upload.length, 0);
            assert.equal(h.fake.calls.delete.length, 0);
            assert.equal(h.fetches.length, 0);
            assert.ok(h.logs.some((l) => l.indexOf('REFUSED') >= 0 && l.indexOf('fake.invalid') >= 0));
        });
    }
});

test('host guard: matching host (any spelling) lets writes through and prints the target host', async () => {
    for (const confirmHost of ['fake.invalid', 'HTTP://FAKE.INVALID/', 'https://fake.invalid']) {
        await run({ confirmHost, imagesEnabled: true }, async (h) => {
            const io = mkIo({ 'G2.webp': buf(5), 'locus_ioe.jpg': buf(5) });
            const r1 = await h.clubs.syncClubs(null, [h.clubs.clubToRow(CLUB, null)]);
            const r3 = await h.clubs.upsertClubPost(h.clubs.postToRow(REC(), 'G2', CLUB, {}));
            const up = await h.images.uploadPostImage('G2', 'locus_ioe', io, null);
            assert.equal(r1.ok, true); assert.equal(r3.ok, true);
            assert.equal(up.imagePath, 'locus_ioe/G2.webp');
            assert.ok(h.logs.some((l) => l.indexOf('[hostGuard]') >= 0 && l.indexOf('target host fake.invalid') >= 0));
        });
    }
});

test('host guard: DRY_RUN and DEV_MODE are unaffected even with no confirmation', async () => {
    await run({ dryRun: true, confirmHost: 'unset', imagesEnabled: true }, async (h) => {
        const io = mkIo({ 'locus_ioe.jpg': buf(5), 'D1.webp': buf(5) });
        const a = await h.clubs.syncClubs(null, [h.clubs.clubToRow(CLUB, null)]);
        const b = await h.clubs.upsertClubPost(h.clubs.postToRow(REC(), 'D1', CLUB, {}));
        const c = await h.images.uploadPostImage('D1', 'locus_ioe', io, null);
        assert.equal(a.dryRun, true); assert.equal(a.ok, true);
        assert.equal(b.dryRun, true); assert.equal(b.ok, true);
        assert.equal(c.imagePath, 'locus_ioe/D1.webp');
        assert.equal(h.fake.calls.upsert.length + h.fake.calls.upload.length, 0);
    });
    await run({ devMode: true, confirmHost: 'unset', imagesEnabled: true }, async (h) => {
        const a = await h.clubs.syncClubs(null, [h.clubs.clubToRow(CLUB, null)]);
        const b = await h.clubs.upsertClubPost(h.clubs.postToRow(REC(), 'D2', CLUB, {}));
        assert.equal(a.skipped, 'dev_mode'); assert.equal(b.skipped, 'dev_mode');
        assert.equal(h.fake.calls.upsert.length, 0);
    });
});

// ------------------------------------------------------------ hook
test('hook: club row first, once per club, then the post (upsert only)', () => run({}, async (h) => {
    const r1 = await h.ops.syncPostedItem(IT('H1'), CLUB);
    const r2 = await h.ops.syncPostedItem(IT('H2'), CLUB);
    assert.equal(r1.ok, true); assert.equal(r2.ok, true);
    assert.deepEqual(h.fake.calls.upsert.map((c) => c.table), ['clubs', POSTS, POSTS]);
    assert.equal(h.fake.rows(POSTS).length, 2);
    assert.equal(h.fake.rows('clubs').length, 1);
    assert.equal(h.fake.calls.delete.length, 0);
    assert.equal(h.fake.calls.remove.length, 0);
    assert.equal(h.fake.calls.upload.length, 0, 'images are off by default');
}));

test('hook: images on uploads avatar and post image, rows carry the public urls', () => run({ imagesEnabled: true }, async (h) => {
    const io = mkIo({ 'H3.webp': buf(5), 'locus_ioe.jpg': buf(5) });
    const r = await h.ops.syncPostedItem(IT('H3'), CLUB, { io });
    assert.equal(r.ok, true);
    assert.deepEqual(h.fake.calls.upload.map((u) => u.bucket), ['club-avatars', 'club-posts']);
    assert.equal(h.fake.rows('clubs')[0].avatar_url, BASE + '/storage/v1/object/public/club-avatars/locus_ioe.jpg');
    const p = h.fake.rows(POSTS)[0];
    assert.equal(p.image_path, 'locus_ioe/H3.webp');
    assert.equal(p.image_url, BASE + '/storage/v1/object/public/club-posts/locus_ioe/H3.webp');
}));

test('hook: failed club sync skips the post and is retried next time; guard and flag respected', async () => {
    await run({ failTable: 'clubs' }, async (h) => {
        const r = await h.ops.syncPostedItem(IT('H4'), CLUB);
        assert.deepEqual(r, { skipped: 'club_not_synced' });
        assert.equal(h.fake.calls.upsert.filter((c) => c.table === POSTS).length, 0);
        await h.ops.syncPostedItem(IT('H5'), CLUB);
        assert.equal(h.fake.calls.upsert.filter((c) => c.table === 'clubs').length, 2, 'club sync retried');
    });
    await run({ confirmHost: 'unset' }, async (h) => {
        assert.deepEqual(await h.ops.syncPostedItem(IT('H6'), CLUB), { skipped: 'club_not_synced' });
        assert.equal(h.fake.calls.upsert.length, 0);
    });
    await run({ clubsEnabled: false }, async (h) => {
        assert.deepEqual(await h.ops.syncPostedItem(IT('H7'), CLUB), { skipped: 'disabled' });
        assert.equal(h.fake.calls.upsert.length, 0);
    });
    await run({}, async (h) => {
        assert.deepEqual(await h.ops.syncPostedItem(IT('H8', { url: '' }), CLUB), { skipped: 'unusable' });
        assert.deepEqual(await h.ops.syncPostedItem(null, CLUB), { skipped: 'bad_input' });
    });
});

test('hook: fireAndForget returns at once, never throws, writes in the background', async () => {
    await run({}, async (h) => {
        assert.equal(h.ops.fireAndForget(IT('F1'), CLUB), undefined);
        assert.doesNotThrow(() => h.ops.fireAndForget(null, null));
        assert.doesNotThrow(() => h.ops.fireAndForget({}, {}));
        assert.ok(await waitFor(() => h.fake.rows(POSTS).length === 1));
        assert.equal(h.fake.rows('clubs').length, 1);
    });
    await run({ clubsEnabled: false }, async (h) => {
        h.ops.fireAndForget(IT('F2'), CLUB);
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(h.fake.calls.upsert.length, 0);
    });
});

// ------------------------------------------------------------ backfill
const RAW = (n) => { const o = {}; for (let i = 1; i <= n; i++) o['B' + i] = { club: 'locus_ioe', label: 'LOCUS, IOE Pulchowk', caption: 'Online Project Exhibition | LOCUS Register now', url: 'https://www.instagram.com/p/B' + i + '/', postedAt: 1792331524000 + i }; return o; };

test('backfill: loadRecs reads array, keyed and {posts} shapes, url wins for the shortcode', () => run({}, (h) => {
    assert.equal(h.ops.loadRecs(RAW(3)).length, 3);
    assert.equal(h.ops.loadRecs({ posts: RAW(2) }).length, 2);
    assert.equal(h.ops.loadRecs(Object.values(RAW(4))).length, 4);
    assert.deepEqual(h.ops.loadRecs(Object.values(RAW(2))).map((x) => x.sc), ['B1', 'B2']);
    assert.equal(h.ops.loadRecs({ x: { club: 'c' } }).length, 0);
}));

test('backfill: clubs first, posts upsert-only, idempotent, one revalidation per run', () => run({}, async (h) => {
    const recs = h.ops.loadRecs(RAW(3));
    const out = await h.ops.backfill(recs, { clubList: [] });
    assert.equal(out.posts, 3); assert.equal(out.failed, 0); assert.equal(out.aborted, null);
    assert.equal(h.fake.calls.upsert[0].table, 'clubs');
    assert.ok(h.fake.calls.upsert.slice(1).every((c) => c.table === POSTS && c.onConflict === 'id'));
    assert.equal(h.fetches.length, 2, 'one for clubs, one at the end, not one per post');
    await h.ops.backfill(recs, { clubList: [] });
    assert.equal(h.fake.rows(POSTS).length, 3);
    assert.equal(h.fake.rows('clubs').length, 1);
    assert.equal(h.fake.calls.delete.length, 0);
}));

test('backfill: dry run writes nothing, unconfirmed host aborts before any post', async () => {
    await run({ dryRun: true }, async (h) => {
        const out = await h.ops.backfill(h.ops.loadRecs(RAW(3)), {});
        assert.equal(out.dry, 3); assert.equal(out.posts, 0);
        assert.equal(h.fake.calls.upsert.length, 0);
        assert.equal(h.fetches.length, 0);
    });
    await run({ confirmHost: 'unset' }, async (h) => {
        const out = await h.ops.backfill(h.ops.loadRecs(RAW(3)), {});
        assert.equal(out.aborted, 'clubs_not_synced');
        assert.equal(h.fake.calls.upsert.length, 0);
    });
});

test('backfill: images on re-hosts through the injected io', () => run({ imagesEnabled: true }, async (h) => {
    const io = mkIo({ 'B1.webp': buf(5), 'locus_ioe.jpg': buf(5) });
    const out = await h.ops.backfill(h.ops.loadRecs(RAW(2)), { io });
    assert.equal(out.posts, 2);
    const b1 = h.fake.rows(POSTS).find((r) => r.shortcode === 'B1');
    const b2 = h.fake.rows(POSTS).find((r) => r.shortcode === 'B2');
    assert.equal(b1.image_path, 'locus_ioe/B1.webp');
    assert.ok(!('image_url' in b2), 'no source, no image keys');
}));

// ------------------------------------------------------------ nightly cleanup
function seedCleanup(h) {
    ['a/1.jpg', 'a/2.jpg', 'b/1.jpg', 'b/2.jpg'].forEach((p, i) => h.fake.seedRow(POSTS, { id: 'r' + i, image_path: p }));
    h.fake.seedRow(POSTS, { id: 'rn', image_path: null });
    ['a/1.jpg', 'a/2.jpg', 'a/3.jpg', 'b/1.jpg', 'b/2.jpg'].forEach((p) => h.fake.seedFile('club-posts', p, OLD));
    h.fake.seedFile('club-posts', 'a/4.jpg', new Date().toISOString());
    h.fake.seedFile('club-avatars', 'a.jpg', OLD);
}
test('cleanup: deletes only old orphans in club-posts, keeps young files and avatars, revalidates', () => run({}, async (h) => {
    seedCleanup(h);
    const r = await h.ops.cleanupOrphans();
    assert.equal(r.ok, true); assert.equal(r.orphans, 1); assert.equal(r.young, 1); assert.equal(r.deleted, 1);
    assert.equal(h.fake.hasFile('club-posts', 'a/3.jpg'), false);
    assert.equal(h.fake.hasFile('club-posts', 'a/4.jpg'), true, 'young file kept');
    assert.equal(h.fake.hasFile('club-posts', 'a/1.jpg'), true);
    assert.equal(h.fake.hasFile('club-avatars', 'a.jpg'), true);
    assert.deepEqual(h.fake.calls.remove, [{ bucket: 'club-posts', paths: ['a/3.jpg'] }]);
    assert.equal(h.fetches.length, 1);
    assert.deepEqual(h.fetches[0].body, { tags: ['clubs'] });
}));

test('cleanup: guards (empty rows, over 50 percent, dry run, unconfirmed host, flag off)', async () => {
    await run({}, async (h) => {
        ['a/1.jpg', 'a/2.jpg'].forEach((p) => h.fake.seedFile('club-posts', p, OLD));
        const r = await h.ops.cleanupOrphans();
        assert.equal(r.aborted, 'empty_row_set');
        assert.equal(h.fake.calls.remove.length, 0);
    });
    await run({}, async (h) => {
        h.fake.seedRow(POSTS, { id: 'r1', image_path: 'a/1.jpg' });
        ['a/1.jpg', 'a/2.jpg', 'a/3.jpg', 'a/4.jpg'].forEach((p) => h.fake.seedFile('club-posts', p, OLD));
        const r = await h.ops.cleanupOrphans();
        assert.equal(r.aborted, 'delete_threshold_exceeded');
        assert.equal(h.fake.calls.remove.length, 0);
    });
    await run({ dryRun: true }, async (h) => {
        seedCleanup(h);
        const r = await h.ops.cleanupOrphans();
        assert.equal(r.dryRun, true); assert.equal(r.deleted, 0);
        assert.equal(h.fake.calls.remove.length, 0);
        assert.ok(h.logs.some((l) => l.indexOf('would delete club-posts/a/3.jpg') >= 0));
    });
    await run({ confirmHost: 'unset' }, async (h) => {
        seedCleanup(h);
        const r = await h.ops.cleanupOrphans();
        assert.equal(r.ok, false); assert.equal(r.reason, 'host_not_confirmed');
        assert.equal(h.fake.calls.remove.length, 0);
    });
    await run({ clubsEnabled: false }, async (h) => {
        seedCleanup(h);
        assert.deepEqual(await h.ops.cleanupOrphans(), { ok: false, reason: 'clubs_disabled' });
    });
});

// ------------------------------------------------------------ takedown
function seedTakedown(h) {
    h.fake.seedRow('clubs', { username: 'a_club' }, 'username');
    h.fake.seedRow('clubs', { username: 'b_club' }, 'username');
    h.fake.seedRow(POSTS, { id: 'p1', club_username: 'a_club' });
    h.fake.seedRow(POSTS, { id: 'p2', club_username: 'a_club' });
    h.fake.seedRow(POSTS, { id: 'p3', club_username: 'b_club' });
    ['a_club/1.jpg', 'a_club/2.jpg', 'b_club/1.jpg'].forEach((p) => h.fake.seedFile('club-posts', p, OLD));
    h.fake.seedFile('club-avatars', 'a_club.jpg', OLD);
    h.fake.seedFile('club-avatars', 'b_club.jpg', OLD);
}
test('takedown: removes the club posts rows, storage files, avatar and club row, then revalidates', () => run({}, async (h) => {
    seedTakedown(h);
    const r = await h.ops.takedownClub('@A_Club');
    assert.equal(r.ok, true); assert.equal(r.files, 2); assert.equal(r.username, 'a_club');
    assert.deepEqual(h.fake.rows(POSTS).map((x) => x.id), ['p3']);
    assert.deepEqual(h.fake.rows('clubs').map((x) => x.username), ['b_club']);
    assert.equal(h.fake.hasFile('club-posts', 'a_club/1.jpg'), false);
    assert.equal(h.fake.hasFile('club-posts', 'b_club/1.jpg'), true);
    assert.equal(h.fake.hasFile('club-avatars', 'a_club.jpg'), false);
    assert.equal(h.fake.hasFile('club-avatars', 'b_club.jpg'), true);
    assert.equal(h.fetches.length, 1);
    assert.deepEqual(await h.ops.takedownClub(''), { ok: false, reason: 'bad_username' });
}));

test('takedown: refused by the host guard, flag off, dry run and dev mode touch nothing', async () => {
    const untouched = (h) => { assert.equal(h.fake.rows(POSTS).length, 3); assert.equal(h.fake.rows('clubs').length, 2); assert.equal(h.fake.fileCount('club-posts'), 3); assert.equal(h.fake.calls.delete.length + h.fake.calls.remove.length, 0); };
    await run({ confirmHost: 'unset' }, async (h) => { seedTakedown(h); const r = await h.ops.takedownClub('a_club'); assert.equal(r.reason, 'host_not_confirmed'); untouched(h); });
    await run({ clubsEnabled: false }, async (h) => { seedTakedown(h); assert.equal((await h.ops.takedownClub('a_club')).reason, 'clubs_disabled'); untouched(h); });
    await run({ dryRun: true }, async (h) => { seedTakedown(h); assert.equal((await h.ops.takedownClub('a_club')).dryRun, true); untouched(h); });
    await run({ devMode: true }, async (h) => { seedTakedown(h); assert.equal((await h.ops.takedownClub('a_club')).skipped, 'dev_mode'); untouched(h); });
});

// ------------------------------------------------------------ wiring (string level)
test('wiring: hook sits after recordPost and is gated, takedown is wired into /club remove, club-media is gone, hook never prunes', () => {
    const sp = fs.readFileSync(P('posting', 'socialPost.js'), 'utf8');
    const iConfirm = sp.indexOf('markers.confirm(key');
    const iRecord = sp.indexOf('posts.json write failed');
    const iFlag = sp.indexOf('WEBSITE_CLUBS_SYNC_ENABLED');
    const iHook = sp.indexOf("clubsOps').fireAndForget");
    assert.ok(iConfirm > 0 && iRecord > iConfirm && iFlag > iRecord && iHook > iFlag, 'order confirm, record, flag, hook');
    assert.ok(/try \{ require\('\.\.\/integrations\/websiteSync\/clubsOps'\)\.fireAndForget/.test(sp), 'hook is wrapped in try');
    const cm = fs.readFileSync(P('discord', 'commands', 'club.js'), 'utf8');
    assert.ok(cm.indexOf('takedownClub') > 0 && cm.indexOf('WEBSITE_CLUBS_SYNC_ENABLED') > 0);
    ['clubImages.js', 'clubs.js', 'clubsOps.js'].forEach((f) => {
        assert.ok(!/club-media/.test(fs.readFileSync(P('integrations', 'websiteSync', f), 'utf8')), f + ' mentions club-media');
    });
    assert.ok(fs.readFileSync(P('integrations', 'websiteSync', 'clubsOps.js'), 'utf8').indexOf('syncClubPosts') < 0, 'ops never calls the pruning sync');
});
