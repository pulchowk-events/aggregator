'use strict';
// Offline tests for src/integrations/websiteSync/clubs.js.
// No network: the supabase client is a fake injected through require.cache,
// global.fetch is stubbed, and the audit logger is replaced by a no-op.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;
const P = (...a) => path.join(ROOT, 'src', ...a);
const POSTS = 'club_posts';

function makeFake() {
    const tables = {};
    const calls = { upsert: [], select: [], delete: [] };
    const tbl = (n) => (tables[n] || (tables[n] = new Map()));
    const matcher = (pat) => {
        const re = new RegExp('^' + String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$');
        return (v) => re.test(String(v == null ? '' : v));
    };
    const client = {
        calls,
        seed(name, rows, col) { const c = col || 'id'; rows.forEach((r) => tbl(name).set(String(r[c]), Object.assign({}, r))); },
        size(name) { return tbl(name).size; },
        has(name, key) { return tbl(name).has(String(key)); },
        from(name) {
            return {
                upsert(payload, opts) {
                    const rows = Array.isArray(payload) ? payload : [payload];
                    const col = (opts && opts.onConflict) || 'id';
                    calls.upsert.push({ table: name, count: rows.length, onConflict: col });
                    rows.forEach((r) => tbl(name).set(String(r[col]), Object.assign({}, tbl(name).get(String(r[col])) || {}, r)));
                    return Promise.resolve({ error: null });
                },
                select(cols) {
                    calls.select.push({ table: name, cols });
                    return {
                        like(col, pat) {
                            const m = matcher(pat);
                            const data = Array.from(tbl(name).values()).filter((r) => m(r[col])).map((r) => Object.assign({}, r));
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
        }
    };
    return client;
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
    const fake = makeFake();
    const sbPath = stub('@supabase/supabase-js', { createClient: () => fake });
    const alPath = stub(P('core', 'auditLogger'), { auditLog: () => {} });

    const env = require(P('config', 'env'));
    const configured = o.configured !== false;
    env.WEBSITE_SUPABASE_URL = configured ? 'http://fake.invalid' : '';
    env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY = configured ? 'fake-key' : '';
    env.WEBSITE_SYNC_ENABLED = o.syncEnabled === false ? false : true;
    env.WEBSITE_SYNC_DRY_RUN = !!o.dryRun;
    delete process.env.WEBSITE_CLUBS_CONFIRM_HOST;
    if (o.confirmHost === 'unset') delete env.WEBSITE_CLUBS_CONFIRM_HOST; else env.WEBSITE_CLUBS_CONFIRM_HOST = o.confirmHost || 'fake.invalid';
    env.DEV_MODE = !!o.devMode;
    env.WEBSITE_SYNC_BATCH_SIZE = 2;
    env.WEBSITE_SYNC_BATCH_DELAY_MS = 1;
    env.WEBSITE_REVALIDATE_URL = 'http://fake.invalid/api/revalidate';
    env.WEBSITE_REVALIDATE_SECRET = 'test-secret';
    delete process.env.WEBSITE_CLUBS_SYNC_ENABLED;
    delete process.env.WEBSITE_CLUBS_TABLE;
    delete process.env.WEBSITE_CLUB_POSTS_TABLE;
    delete env.WEBSITE_CLUBS_TABLE;
    delete env.WEBSITE_CLUB_POSTS_TABLE;
    if (o.clubsEnabled === 'unset') delete env.WEBSITE_CLUBS_SYNC_ENABLED;
    else env.WEBSITE_CLUBS_SYNC_ENABLED = o.clubsEnabled === undefined ? true : o.clubsEnabled;

    const engine = require(P('integrations', 'websiteSync', 'engine'));
    const clubs = require(P('integrations', 'websiteSync', 'clubs'));
    const sf = require(P('posting', 'socialFormat'));

    const fetches = [];
    const origFetch = global.fetch;
    global.fetch = async (url, init) => { fetches.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
    const logs = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a) => { logs.push(a.join(' ')); };
    console.warn = (...a) => { logs.push(a.join(' ')); };
    console.error = (...a) => { logs.push(a.join(' ')); };

    return {
        fake, env, engine, clubs, sf, logs, fetches,
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

const REC = (over) => Object.assign({
    club: 'locus_ioe', label: 'LOCUS, IOE Pulchowk',
    caption: 'Online Project Exhibition | LOCUS\nBuild it. Film it. Showcase it.',
    hints: null, url: 'https://www.instagram.com/p/Deo1UA6hr7T/',
    image: 'https://example.invalid/a.webp', postedAt: 1792331524000, savedAt: 1795369872901, bridged: true
}, over || {});
const CLUB = { username: 'locus_ioe', label: 'locus_ioe', displayName: 'LOCUS, IOE Pulchowk' };
const mkRow = (i) => ({ id: 'id-' + i, bot_dedup_key: 'ig:S' + i, origin: 'scraper:instagram', shortcode: 'S' + i });
const rowsOf = (from, to) => { const a = []; for (let i = from; i <= to; i++) a.push(mkRow(i)); return a; };

// ------------------------------------------------------------ mapping
test('postToRow: deterministic id, ISO posted_at, exact shape', () => run({}, (h) => {
    const a = h.clubs.postToRow(REC(), 'Deo1UA6hr7T', CLUB, { imageUrl: 'https://x.invalid/i.webp', imagePath: 'locus_ioe/Deo1UA6hr7T.webp' });
    const b = h.clubs.postToRow(REC({ caption: 'different' }), 'Deo1UA6hr7T', CLUB, {});
    const c = h.clubs.postToRow(REC(), 'OtherCode', CLUB, {});
    assert.equal(a.id, h.engine.deterministicUUID('ig:Deo1UA6hr7T'));
    assert.equal(a.id, b.id, 'same shortcode gives same uuid');
    assert.notEqual(a.id, c.id);
    assert.match(a.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(a.bot_dedup_key, 'ig:Deo1UA6hr7T');
    assert.equal(a.origin, 'scraper:instagram');
    assert.equal(a.shortcode, 'Deo1UA6hr7T');
    assert.equal(a.club_username, 'locus_ioe');
    assert.equal(a.post_url, 'https://www.instagram.com/p/Deo1UA6hr7T/');
    assert.equal(a.image_url, 'https://x.invalid/i.webp');
    assert.equal(a.image_path, 'locus_ioe/Deo1UA6hr7T.webp');
    assert.equal(a.posted_at, new Date(1792331524000).toISOString());
    assert.ok(!isNaN(Date.parse(a.synced_at)));
    assert.deepEqual(Object.keys(a).sort(), [
        'bot_dedup_key', 'caption', 'club_username', 'id', 'image_path', 'image_url', 'is_event',
        'origin', 'post_type', 'post_url', 'posted_at', 'shortcode', 'synced_at'
    ]);
    assert.ok(!('image_url' in b), 'image_url omitted when empty');
    assert.ok(!('image_path' in b), 'image_path omitted when empty');
}));

test('postToRow: caption clipped to 2000, empty caption is null', () => run({}, (h) => {
    const long = h.clubs.postToRow(REC({ caption: 'word '.repeat(2000) }), 'LongOne', CLUB, {});
    assert.ok(long.caption.length > 0 && long.caption.length <= 2000, 'length ' + long.caption.length);
    assert.equal(h.clubs.postToRow(REC({ caption: '' }), 'NoCap', CLUB, {}).caption, null);
    assert.equal(h.clubs.postToRow(REC({ caption: null }), 'NoCap2', CLUB, {}).caption, null);
}));

test('postToRow: unusable records return null', () => run({}, (h) => {
    assert.equal(h.clubs.postToRow(REC({ url: '' }), 'a', CLUB, {}), null);
    assert.equal(h.clubs.postToRow(REC({ postedAt: 'nope' }), 'b', CLUB, {}), null);
    assert.equal(h.clubs.postToRow(REC({ postedAt: 0 }), 'c', CLUB, {}), null);
    assert.equal(h.clubs.postToRow(REC(), '', CLUB, {}), null);
    assert.equal(h.clubs.postToRow(null, 'd', CLUB, {}), null);
}));

test('clubToRow: shape, display_name fallback, avatar', () => run({}, (h) => {
    const r = h.clubs.clubToRow(CLUB, 'https://x.invalid/dp.jpg');
    assert.deepEqual(Object.keys(r).sort(), ['avatar_url', 'display_name', 'enabled', 'updated_at', 'username']);
    assert.equal(r.username, 'locus_ioe');
    assert.equal(r.display_name, 'LOCUS, IOE Pulchowk');
    assert.equal(r.avatar_url, 'https://x.invalid/dp.jpg');
    assert.equal(r.enabled, true);
    assert.ok(!isNaN(Date.parse(r.updated_at)));
    const bare = h.clubs.clubToRow({ username: '@Some_Club', label: 'some_club' }, null);
    assert.equal(bare.username, 'some_club');
    assert.ok(!('display_name' in bare), 'display_name omitted when empty');
    assert.ok(!('avatar_url' in bare), 'avatar_url omitted when empty');
    assert.equal(h.clubs.clubToRow({}, null), null);
}));

// ------------------------------------------------------------ classifier (insta-classifier)
const EXPO_CAP = 'Online Project Exhibition | LOCUS\nBuild it. Film it. Showcase it. Got a project ready to showcase? Register now and submit your entry before the deadline.';
const SPOT_CAP = 'Project Name: LipiAI | Team ID: 8 Bimal Rajbhandari, Bibek Maharjan, Sudeep Khatri Pokhara Engineering College Category: AI';
const BDAY_CAP = 'Wishing our Project Manager a very Happy Birthday! May your leadership continue to inspire us.';

test('is_event / post_type map straight from the insta classifier result', () => run({}, (h) => {
    const ic = require(P('scrapers', 'lib', 'insta-classifier'));
    const seen = [];
    let next;
    ic.classifyPost = (arg) => { seen.push(arg); if (next instanceof Error) throw next; return next; };
    next = { is_event: true, score: 1, hints: { type: 'hackathon' } };
    let r = h.clubs.postToRow(REC(), 'C1', CLUB, {});
    assert.equal(r.is_event, true); assert.equal(r.post_type, 'hackathon');
    assert.equal(seen[0].caption, REC().caption);
    assert.equal(seen[0].takenAt, 1792331524000);
    next = { is_event: false, score: 0.2, hints: { type: 'workshop' } };
    r = h.clubs.postToRow(REC(), 'C2', CLUB, {});
    assert.equal(r.is_event, false); assert.equal(r.post_type, null, 'post_type is null when not an event');
    next = { is_event: true, score: 1, hints: {} };
    r = h.clubs.postToRow(REC(), 'C3', CLUB, {});
    assert.equal(r.is_event, true); assert.equal(r.post_type, null);
    next = new Error('boom');
    r = h.clubs.postToRow(REC(), 'C4', CLUB, {});
    assert.equal(r.is_event, false); assert.equal(r.post_type, null);
    next = null;
    r = h.clubs.postToRow(REC(), 'C5', CLUB, {});
    assert.equal(r.is_event, false); assert.equal(r.post_type, null);
}));

test('real insta classifier: expo caption is an event, project-card (spotlight) caption is not', () => run({}, (h) => {
    const ic = require(P('scrapers', 'lib', 'insta-classifier'));
    const expo = h.clubs.postToRow(REC({ caption: EXPO_CAP }), 'E1', CLUB, {});
    assert.equal(expo.is_event, true, 'expo caption');
    assert.equal(expo.post_type, 'exhibition');
    const spot = h.clubs.postToRow(REC({ caption: SPOT_CAP }), 'E2', CLUB, {});
    assert.equal(spot.is_event, false, 'Project Name / Team ID caption');
    assert.equal(spot.post_type, null);
    const bday = h.clubs.postToRow(REC({ caption: BDAY_CAP }), 'E3', CLUB, {});
    assert.equal(bday.is_event, false, 'birthday caption');
    [EXPO_CAP, SPOT_CAP, BDAY_CAP, ''].forEach((cap, i) => {
        const rec = REC({ caption: cap });
        const res = ic.classifyPost({ caption: rec.caption, takenAt: rec.postedAt });
        const row = h.clubs.postToRow(rec, 'A' + i, CLUB, {});
        assert.equal(row.is_event, res.is_event === true, 'case ' + i);
        assert.equal(typeof row.is_event, 'boolean');
        if (!row.is_event) assert.equal(row.post_type, null);
    });
}));

// ------------------------------------------------------------ idempotent upsert
test('syncClubPosts: running twice leaves one row per post, upserts on id', () => run({}, async (h) => {
    const rows = ['A', 'B', 'C'].map((s) => h.clubs.postToRow(REC(), s, CLUB, {}));
    const r1 = await h.clubs.syncClubPosts(null, rows);
    const r2 = await h.clubs.syncClubPosts(null, rows);
    assert.equal(h.fake.size(POSTS), 3);
    assert.equal(r1.syncedCount, 3); assert.equal(r2.syncedCount, 3);
    assert.equal(r1.failedCount, 0);
    assert.ok(h.fake.calls.upsert.every((c) => c.table === POSTS && c.onConflict === 'id'));
    assert.equal(h.fake.calls.upsert.length, 4, 'batch size 2 -> 2 batches per run');
    assert.equal(h.fake.calls.delete.length, 0);
}));

test('syncClubs: plain upsert on username, no prune, idempotent', () => run({}, async (h) => {
    const rows = [h.clubs.clubToRow(CLUB, null), h.clubs.clubToRow({ username: 'b_club' }, null), h.clubs.clubToRow({ username: 'c_club' }, null)];
    await h.clubs.syncClubs(null, rows);
    const r2 = await h.clubs.syncClubs(null, rows);
    assert.equal(h.fake.size('clubs'), 3);
    assert.equal(r2.syncedCount, 3);
    assert.ok(h.fake.calls.upsert.every((c) => c.table === 'clubs' && c.onConflict === 'username'));
    assert.equal(h.fake.calls.select.length, 0, 'no prune lookup for clubs');
    assert.equal(h.fake.calls.delete.length, 0);
}));

test('upsertClubPost: upsert only, never selects or deletes, idempotent', () => run({}, async (h) => {
    h.fake.seed(POSTS, rowsOf(1, 5));
    const row = h.clubs.postToRow(REC(), 'Solo', CLUB, {});
    const r1 = await h.clubs.upsertClubPost(row);
    const r2 = await h.clubs.upsertClubPost(row);
    assert.equal(r1.ok, true); assert.equal(r2.ok, true);
    assert.equal(h.fake.size(POSTS), 6, 'five seeded rows untouched plus one new');
    assert.equal(h.fake.calls.delete.length, 0);
    assert.equal(h.fake.calls.select.length, 0);
    assert.ok(h.fake.calls.upsert.every((c) => c.onConflict === 'id'));
    assert.deepEqual(await h.clubs.upsertClubPost(null), { ok: false, reason: 'invalid_row' });
}));

// ------------------------------------------------------------ prune guards
test('prune guard: empty eligible set aborts, nothing deleted', () => run({}, async (h) => {
    h.fake.seed(POSTS, rowsOf(1, 3));
    const r = await h.clubs.syncClubPosts(null, []);
    assert.equal(r.pruneAborted, true);
    assert.equal(r.pruneAbortReason, 'empty_eligible_set');
    assert.equal(h.fake.calls.delete.length, 0);
    assert.equal(h.fake.size(POSTS), 3);
}));

test('prune guard: more than 50 percent orphans aborts', () => run({}, async (h) => {
    h.fake.seed(POSTS, rowsOf(1, 12));
    const r = await h.clubs.syncClubPosts(null, rowsOf(101, 103));
    assert.equal(r.pruneAborted, true);
    assert.equal(r.pruneAbortReason, 'delete_threshold_exceeded');
    assert.equal(h.fake.calls.delete.length, 0);
    assert.equal(h.fake.size(POSTS), 15);
}));

test('prune: removes a real orphan, only touches origin scraper:%', () => run({}, async (h) => {
    h.fake.seed(POSTS, rowsOf(1, 12));
    h.fake.seed(POSTS, [{ id: 'u1', bot_dedup_key: 'x', origin: 'user' }]);
    const r = await h.clubs.syncClubPosts(null, rowsOf(1, 11));
    assert.equal(r.prunedCount, 1);
    assert.equal(r.pruneAborted, false);
    assert.equal(h.fake.has(POSTS, 'id-12'), false);
    assert.equal(h.fake.has(POSTS, 'u1'), true, 'non-scraper row survives');
    assert.deepEqual(h.fake.calls.delete.map((d) => d.val), ['id-12']);
}));

// ------------------------------------------------------------ DEV_MODE / DRY_RUN
test('DEV_MODE: skipped, prints ascii rows with caption cut at 80, no db or network', () => run({ devMode: true }, async (h) => {
    const row = h.clubs.postToRow(REC({ caption: 'caf\u00e9 ' + 'x'.repeat(200) }), 'DevCode1', CLUB, {});
    const crow = h.clubs.clubToRow(CLUB, null);
    const r1 = await h.clubs.syncClubPosts(null, [row]);
    const r2 = await h.clubs.syncClubs(null, [crow]);
    const r3 = await h.clubs.upsertClubPost(row);
    [r1, r2, r3].forEach((r) => assert.equal(r.skipped, 'dev_mode'));
    assert.equal(h.fake.calls.upsert.length + h.fake.calls.select.length + h.fake.calls.delete.length, 0);
    assert.equal(h.fetches.length, 0);
    const printed = h.logs.join('\n');
    assert.ok(printed.indexOf('DevCode1') >= 0, 'row printed');
    assert.ok(printed.indexOf('locus_ioe') >= 0, 'club printed');
    assert.ok(printed.indexOf('x'.repeat(81)) < 0, 'caption cut to 80');
    assert.match(printed, /^[\x00-\x7f]*$/, 'ascii only');
}));

test('DRY_RUN: no writes, no deletes, no revalidation, rows printed', () => run({ dryRun: true }, async (h) => {
    h.fake.seed(POSTS, rowsOf(1, 2));
    const posts = await h.clubs.syncClubPosts(null, [mkRow(1)]);
    const clubsRes = await h.clubs.syncClubs(null, [h.clubs.clubToRow(CLUB, null)]);
    const single = await h.clubs.upsertClubPost(h.clubs.postToRow(REC(), 'DryOne', CLUB, {}));
    assert.equal(posts.dryRun, true); assert.equal(posts.syncedCount, 1);
    assert.equal(clubsRes.dryRun, true); assert.equal(single.dryRun, true);
    assert.equal(h.fake.calls.upsert.length, 0);
    assert.equal(h.fake.calls.delete.length, 0);
    assert.equal(h.fetches.length, 0);
    const printed = h.logs.join('\n');
    assert.ok(printed.indexOf('DRY RUN') >= 0);
    assert.ok(printed.indexOf('DryOne') >= 0);
    assert.ok(printed.indexOf('Would delete') >= 0, 'prune is only reported');
}));

// ------------------------------------------------------------ gates and config
test('disabled gate: default off, nothing touched', () => run({ clubsEnabled: 'unset' }, async (h) => {
    assert.equal(h.clubs.isEnabled(), false);
    const row = h.clubs.postToRow(REC(), 'G1', CLUB, {});
    assert.deepEqual(await h.clubs.syncClubPosts(null, [row]), { ok: false, reason: 'clubs_disabled' });
    assert.deepEqual(await h.clubs.syncClubs(null, [h.clubs.clubToRow(CLUB, null)]), { ok: false, reason: 'clubs_disabled' });
    assert.deepEqual(await h.clubs.upsertClubPost(row), { ok: false, reason: 'clubs_disabled' });
    assert.equal(h.fake.calls.upsert.length + h.fake.calls.select.length, 0);
}));

test('disabled gate: engine-level WEBSITE_SYNC_ENABLED=false wins', () => run({ syncEnabled: false }, async (h) => {
    const r = await h.clubs.syncClubPosts(null, [mkRow(1)]);
    assert.deepEqual(r, { ok: false, reason: 'disabled' });
}));

test('missing config: not_configured, nothing touched', () => run({ configured: false }, async (h) => {
    assert.deepEqual(await h.clubs.syncClubPosts(null, [mkRow(1)]), { ok: false, reason: 'not_configured' });
    assert.deepEqual(await h.clubs.syncClubs(null, [h.clubs.clubToRow(CLUB, null)]), { ok: false, reason: 'not_configured' });
    assert.equal(h.fake.calls.upsert.length, 0);
}));

test('table names default to clubs / club_posts and honour env overrides', () => run({}, async (h) => {
    assert.equal(h.clubs.clubsTableName(), 'clubs');
    assert.equal(h.clubs.clubPostsTableName(), 'club_posts');
    h.env.WEBSITE_CLUBS_TABLE = 'clubs_stage';
    h.env.WEBSITE_CLUB_POSTS_TABLE = 'cp_stage';
    await h.clubs.syncClubs(null, [h.clubs.clubToRow(CLUB, null)]);
    await h.clubs.syncClubPosts(null, [mkRow(1)]);
    assert.equal(h.fake.size('clubs_stage'), 1);
    assert.equal(h.fake.size('cp_stage'), 1);
    assert.equal(h.fake.size('clubs'), 0);
}));

// ------------------------------------------------------------ revalidation
test('revalidation: tag clubs fires after a real write, not after a no-op', () => run({}, async (h) => {
    await h.clubs.syncClubPosts(null, [mkRow(1)]);
    await h.clubs.syncClubs(null, [h.clubs.clubToRow(CLUB, null)]);
    await h.clubs.upsertClubPost(h.clubs.postToRow(REC(), 'RV', CLUB, {}));
    assert.equal(h.fetches.length, 3);
    h.fetches.forEach((f) => { assert.deepEqual(f.body, { tags: ['clubs'] }); assert.equal(f.url, 'http://fake.invalid/api/revalidate'); });
    const before = h.fetches.length;
    await h.clubs.syncClubs(null, []);
    assert.equal(h.fetches.length, before, 'zero rows written -> no revalidation');
}));

// ------------------------------------------------------------ getMode
test('getMode lists the two new tables only when the clubs gate is on', async () => {
    await run({}, (h) => {
        const idx = require(P('integrations', 'websiteSync', 'index'));
        const m = idx.getMode();
        assert.equal(m.clubsTable, 'clubs');
        assert.equal(m.clubPostsTable, 'club_posts');
    });
    await run({ clubsEnabled: 'unset' }, (h) => {
        const idx = require(P('integrations', 'websiteSync', 'index'));
        const m = idx.getMode();
        assert.equal(m.clubsTable, null);
        assert.equal(m.clubPostsTable, null);
    });
});
