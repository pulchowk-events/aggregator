'use strict';
// Offline test: triggerRevalidation must not follow redirects. A moved URL
// answers 301; following it turned the POST into a GET and logged a
// misleading 405. fetch is stubbed; the supabase client is a fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;
const P = (...a) => path.join(ROOT, 'src', ...a);

function stub(request, exportsObj) {
    const p = require.resolve(request);
    const m = new Module(p);
    m.filename = p; m.loaded = true; m.exports = exportsObj;
    require.cache[p] = m;
    return p;
}

function setup() {
    Object.keys(require.cache).forEach((k) => { if (k.startsWith(SRC_PREFIX)) delete require.cache[k]; });
    const sbPath = stub('@supabase/supabase-js', { createClient: () => ({}) });
    const alPath = stub(P('core', 'auditLogger'), { auditLog: () => {} });
    const env = require(P('config', 'env'));
    env.WEBSITE_REVALIDATE_URL = 'http://old.example.invalid/api/revalidate';
    env.WEBSITE_REVALIDATE_SECRET = 'test-secret';
    const engine = require(P('integrations', 'websiteSync', 'engine'));

    const fetches = [];
    const origFetch = global.fetch;
    global.fetch = async (url, init) => {
        fetches.push({ url, init });
        return { ok: false, status: 301, headers: { get: (k) => (String(k).toLowerCase() === 'location' ? 'https://new.example.invalid/api/revalidate' : null) } };
    };
    const logs = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a) => { logs.push(a.join(' ')); };
    console.warn = (...a) => { logs.push(a.join(' ')); };
    console.error = (...a) => { logs.push(a.join(' ')); };
    return {
        engine, fetches, logs,
        restore() {
            console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
            global.fetch = origFetch;
            delete require.cache[sbPath];
            delete require.cache[alPath];
        }
    };
}

test('triggerRevalidation: redirect manual, moved URL logs 301 plus the new location', async () => {
    const h = setup();
    try {
        await h.engine.triggerRevalidation(['events']);
        assert.equal(h.fetches.length, 1, 'fetch called once');
        assert.equal(h.fetches[0].init.redirect, 'manual');
        assert.equal(h.fetches[0].init.method, 'POST');
        const out = h.logs.join('\n');
        assert.match(out, /Revalidation returned 301/);
        assert.match(out, /new\.example\.invalid/);
        assert.doesNotMatch(out, /405/);
    } finally {
        h.restore();
    }
});
