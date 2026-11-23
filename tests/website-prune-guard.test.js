'use strict';
// Offline tests for the website prune guard in engine.syncOneTable.
// Same injection pattern as tests/website-clubs.test.js: the supabase client
// is a fake supplied through require.cache; the audit logger is captured.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;
const P = (...a) => path.join(ROOT, 'src', ...a);

function makeFake() {
    const rows = new Map();
    const calls = { upsert: 0, delete: [] };
    return {
        calls,
        seed(list) { list.forEach((r) => rows.set(String(r.id), Object.assign({}, r))); },
        size() { return rows.size; },
        has(id) { return rows.has(String(id)); },
        from() {
            return {
                upsert(payload) {
                    const list = Array.isArray(payload) ? payload : [payload];
                    list.forEach((r) => rows.set(String(r.id), Object.assign({}, rows.get(String(r.id)) || {}, r)));
                    calls.upsert += list.length;
                    return Promise.resolve({ error: null });
                },
                select() {
                    return {
                        like(col, pat) {
                            const prefix = String(pat).replace(/%$/, '');
                            const data = Array.from(rows.values())
                                .filter((r) => String(r[col] == null ? '' : r[col]).startsWith(prefix))
                                .map((r) => Object.assign({}, r));
                            return Promise.resolve({ data, error: null });
                        }
                    };
                },
                delete() {
                    return {
                        eq(col, val) {
                            calls.delete.push(val);
                            Array.from(rows.entries()).forEach(([k, r]) => { if (r[col] === val) rows.delete(k); });
                            return Promise.resolve({ error: null });
                        }
                    };
                }
            };
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

function setup() {
    Object.keys(require.cache).forEach((k) => { if (k.startsWith(SRC_PREFIX)) delete require.cache[k]; });
    const fake = makeFake();
    const audits = [];
    const sbPath = stub('@supabase/supabase-js', { createClient: () => fake });
    const alPath = stub(P('core', 'auditLogger'), { auditLog: (type, msg, data, level) => { audits.push({ type, msg, data, level }); } });
    const env = require(P('config', 'env'));
    env.WEBSITE_SUPABASE_URL = 'http://fake.invalid';
    env.WEBSITE_SUPABASE_SERVICE_ROLE_KEY = 'fake-key';
    env.WEBSITE_SYNC_ENABLED = true;
    env.WEBSITE_SYNC_DRY_RUN = false;
    env.DEV_MODE = false;
    env.WEBSITE_SYNC_BATCH_SIZE = 100;
    env.WEBSITE_SYNC_BATCH_DELAY_MS = 1;
    delete process.env.WEBSITE_SYNC_PRUNE_MAX_FRACTION;
    delete process.env.WEBSITE_SYNC_PRUNE_MIN_ABS;
    const engine = require(P('integrations', 'websiteSync', 'engine'));
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    return {
        fake, audits, engine,
        restore() {
            console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
            delete process.env.WEBSITE_SYNC_PRUNE_MAX_FRACTION;
            delete process.env.WEBSITE_SYNC_PRUNE_MIN_ABS;
            delete require.cache[sbPath];
            delete require.cache[alPath];
        }
    };
}

async function run(fn) {
    const h = setup();
    try { await fn(h); } finally { h.restore(); }
}

const mk = (i) => ({ id: 'id-' + i, bot_dedup_key: 'k' + i, origin: 'scraper:test' });
const range = (from, to) => { const a = []; for (let i = from; i <= to; i++) a.push(mk(i)); return a; };

// Site has `existing` bot rows (id-1..id-existing). The eligible set keeps the
// first `keep` of them plus `fresh` brand-new rows, so orphans = existing - keep.
async function go(h, existing, keep, fresh) {
    h.fake.seed(range(1, existing));
    const rows = range(1, keep).concat(fresh ? range(existing + 1, existing + fresh) : []);
    return h.engine.syncOneTable(null, {
        tableName: 'club_posts', rows, label: 'test', emit: () => {}, log: () => {}, startMs: Date.now()
    });
}

test('5 percent orphans (13/269): normal prune, keys audited', () => run(async (h) => {
    const r = await go(h, 269, 256, 0);
    assert.equal(r.pruneAborted, false);
    assert.equal(r.prunedCount, 13);
    assert.equal(h.fake.size(), 256);
    const a = h.audits.find((x) => /Pruned 13\/13/.test(x.msg));
    assert.ok(a, 'real prune is audited');
    assert.equal(a.data.keys.length, 13);
}));

test('18.6 percent orphans (50/269, the prod case): skipped with prune_limit_exceeded', () => run(async (h) => {
    const r = await go(h, 269, 219, 0);
    assert.equal(r.pruneAborted, true);
    assert.equal(r.pruneAbortReason, 'prune_limit_exceeded');
    assert.equal(r.prunedCount, 0);
    assert.equal(h.fake.calls.delete.length, 0);
    assert.equal(h.fake.size(), 269);
    const a = h.audits.find((x) => /Prune skipped by guard/.test(x.msg));
    assert.ok(a, 'skip is audited');
    assert.equal(a.level, 'warn');
    assert.equal(a.data.limit, 26);
    assert.equal(a.data.sampleKeys.length, 25);
}));

test('50 percent orphans (135/269): legacy reason delete_threshold_exceeded is kept', () => run(async (h) => {
    const r = await go(h, 269, 134, 0);
    assert.equal(r.pruneAborted, true);
    assert.equal(r.pruneAbortReason, 'delete_threshold_exceeded');
    assert.equal(h.fake.calls.delete.length, 0);
    assert.equal(h.fake.size(), 269);
}));

test('100 percent orphans (eligible disjoint from site): nothing deleted', () => run(async (h) => {
    const r = await go(h, 269, 0, 3);
    assert.equal(r.pruneAborted, true);
    assert.equal(r.pruneAbortReason, 'delete_threshold_exceeded');
    assert.equal(h.fake.calls.delete.length, 0);
}));

test('zero eligible: empty_eligible_set, nothing deleted', () => run(async (h) => {
    const r = await go(h, 269, 0, 0);
    assert.equal(r.pruneAborted, true);
    assert.equal(r.pruneAbortReason, 'empty_eligible_set');
    assert.equal(h.fake.calls.delete.length, 0);
    assert.equal(h.fake.size(), 269);
}));

test('zero orphans: nothing to prune, not aborted', () => run(async (h) => {
    const r = await go(h, 269, 269, 0);
    assert.equal(r.pruneAborted, false);
    assert.equal(r.prunedCount, 0);
}));

test('10 of 219 (the 09:20 events case) is NOT blocked', () => run(async (h) => {
    const r = await go(h, 219, 209, 0);
    assert.equal(r.pruneAborted, false);
    assert.equal(r.prunedCount, 10);
    assert.equal(h.fake.size(), 209);
}));

test('boundary: 26 of 269 pruned, 27 of 269 skipped', async () => {
    await run(async (h) => {
        const r = await go(h, 269, 243, 0);
        assert.equal(r.pruneAborted, false);
        assert.equal(r.prunedCount, 26);
    });
    await run(async (h) => {
        const r = await go(h, 269, 242, 0);
        assert.equal(r.pruneAborted, true);
        assert.equal(r.pruneAbortReason, 'prune_limit_exceeded');
        assert.equal(h.fake.size(), 269);
    });
});

test('small table: floor lets 6 of 8 prune (guard floor, legacy needs more than 10 rows)', () => run(async (h) => {
    const r = await go(h, 8, 2, 0);
    assert.equal(r.pruneAborted, false);
    assert.equal(r.prunedCount, 6);
}));

test('env override WEBSITE_SYNC_PRUNE_MAX_FRACTION=0.4 allows 50/269', () => run(async (h) => {
    process.env.WEBSITE_SYNC_PRUNE_MAX_FRACTION = '0.4';
    const r = await go(h, 269, 219, 0);
    assert.equal(r.pruneAborted, false);
    assert.equal(r.prunedCount, 50);
}));

test('pruneGuard pure: limit math', () => run(async (h) => {
    const g = h.engine.pruneGuard;
    const o = { maxFraction: 0.10, minAbs: 10 };
    assert.equal(g(26, 269, o).abort, false);
    assert.equal(g(27, 269, o).abort, true);
    assert.equal(g(10, 20, o).abort, false);
    assert.equal(g(11, 20, o).abort, true);
    assert.equal(g(0, 0, o).abort, false);
}));
