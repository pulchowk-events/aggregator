'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MessageFlags } = require('discord.js');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src') + path.sep;
const AUDIT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devmode-audit-')), 'audit.jsonl');

const SCRUB = {
    DISCORD_TOKEN: 'dummy-token',
    SUPABASE_URL: 'http://127.0.0.1:9',
    SUPABASE_SERVICE_ROLE_KEY: 'dummy-key',
    WEBSITE_SUPABASE_URL: 'http://127.0.0.1:9',
    WEBSITE_SUPABASE_SERVICE_ROLE_KEY: 'dummy-key',
    AUDIT_FILE: AUDIT, // keep test audit entries out of data/audit-log.jsonl
};

function clearSrc() {
    for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];
}
// NOTE: "unset" is simulated as '' (not delete): env.js runs dotenv, which would
// otherwise load DEV_MODE=true from the real .env. dotenv never overrides existing keys.
async function withEnv(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
    clearSrc();
    try { return await fn(); }
    finally {
        for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        clearSrc();
    }
}
const devMode = () => require(path.join(ROOT, 'src/core/devMode'));

function mockInteraction(extra = {}) {
    const calls = [];
    return {
        calls, deferred: false, replied: false,
        reply: async (p) => { calls.push(['reply', p]); },
        followUp: async (p) => { calls.push(['followUp', p]); },
        ...extra,
    };
}

test('1. isDevMode() true when DEV_MODE=true', async () => {
    await withEnv({ ...SCRUB, DEV_MODE: 'true' }, () => assert.equal(devMode().isDevMode(), true));
});
test('2. isDevMode() false when DEV_MODE unset/empty', async () => {
    await withEnv({ ...SCRUB, DEV_MODE: '' }, () => assert.equal(devMode().isDevMode(), false));
});
test('3. isDevMode() false when DEV_MODE=false', async () => {
    await withEnv({ ...SCRUB, DEV_MODE: 'false' }, () => assert.equal(devMode().isDevMode(), false));
});
test('3b. unrecognized DEV_MODE fails closed (true) and warns', async () => {
    const warn = console.warn; let warned = false;
    console.warn = () => { warned = true; };
    try { await withEnv({ ...SCRUB, DEV_MODE: 'banana' }, () => assert.equal(devMode().isDevMode(), true)); }
    finally { console.warn = warn; }
    assert.ok(warned);
});
test('4. requireProdMode replies ephemerally and returns false in DEV_MODE; true otherwise', async () => {
    await withEnv({ ...SCRUB, DEV_MODE: 'true' }, async () => {
        const i = mockInteraction();
        const ok = await devMode().requireProdMode('autopost start-live', i);
        assert.equal(ok, false);
        assert.equal(i.calls.length, 1);
        assert.equal(i.calls[0][0], 'reply');
        assert.equal(i.calls[0][1].flags, MessageFlags.Ephemeral);
        assert.match(i.calls[0][1].content, /DEV_MODE=true — \/autopost start-live disabled\. Unset DEV_MODE to enable\./);
        const d = mockInteraction({ deferred: true });
        assert.equal(await devMode().requireProdMode('x', d), false);
        assert.equal(d.calls[0][0], 'followUp');
    });
    await withEnv({ ...SCRUB, DEV_MODE: '' }, async () => {
        const i = mockInteraction();
        assert.equal(await devMode().requireProdMode('x', i), true);
        assert.equal(i.calls.length, 0);
    });
});

test('5. every requireProdMode( call in the handler files is awaited (and expected sites exist)', () => {
    const expected = {
        'src/discord/commands/autopost.js': 1,
        'src/integrations/websiteSync/commands.js': 2,
        'src/discord/extensions/admin-toggles.js': 1,
    };
    for (const [rel, count] of Object.entries(expected)) {
        const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const re = /requireProdMode\s*\(/g;
        let m, n = 0;
        while ((m = re.exec(text))) {
            n++;
            assert.match(text.slice(Math.max(0, m.index - 12), m.index), /await\s+$/, `${rel}: un-awaited requireProdMode( at offset ${m.index}`);
        }
        assert.equal(n, count, `${rel}: expected ${count} guard call(s), found ${n}`);
        assert.match(text, /require\('\.\.\/\.\.\/core\/devMode'\)/, `${rel}: devMode import missing`);
    }
});

test('6. syncPostedEvents refuses in DEV_MODE: no network, no state mutation', async () => {
    const realFetch = global.fetch; let fetchCalls = 0;
    global.fetch = async () => { fetchCalls++; throw new Error('network blocked in test'); };
    try {
        await withEnv({ ...SCRUB, DEV_MODE: 'true' }, async () => {
            const { syncPostedEvents } = require(path.join(ROOT, 'src/integrations/supabase'));
            const bot = { cache: { settings: {} } };
            const before = JSON.stringify(bot);
            const r = await syncPostedEvents(bot, { force: true });
            assert.equal(r.skipped, 'dev_mode');
            assert.equal(r.uploaded, 0);
            assert.equal(JSON.stringify(bot), before, 'bot state must be untouched');
            assert.equal(fetchCalls, 0);
        });
    } finally { global.fetch = realFetch; }
});

test('7. startAutopost refuses mode=live in DEV_MODE: no config, timers or persistence', async () => {
    const realFetch = global.fetch; let fetchCalls = 0;
    global.fetch = async () => { fetchCalls++; throw new Error('network blocked in test'); };
    try {
        await withEnv({ ...SCRUB, DEV_MODE: 'true' }, async () => {
            const { startAutopost } = require(path.join(ROOT, 'src/posting/autopost'));
            const bot = {
                cache: { settings: { autopostDeliberateStop: {} } },
                autopostConfig: { events: { live: { active: false, intervalMinutes: 60 } } },
                autopostTimers: { events: { live: null } },
                autopostLastPostAt: { events: { live: 0 } },
            };
            const before = JSON.stringify(bot);
            const r = startAutopost(bot, 'events', 'live', 60);
            assert.equal(r, undefined);
            assert.equal(JSON.stringify(bot), before, 'bot state must be untouched');
            assert.equal(fetchCalls, 0);
        });
    } finally { global.fetch = realFetch; }
});
