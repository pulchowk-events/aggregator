'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src') + path.sep;
const AUDIT = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devmode-guards-')), 'audit.jsonl');
const SCRUB = {
    DISCORD_TOKEN: 'dummy-token',
    SUPABASE_URL: 'http://127.0.0.1:9',
    SUPABASE_SERVICE_ROLE_KEY: 'dummy-key',
    WEBSITE_SUPABASE_URL: 'http://127.0.0.1:9',
    WEBSITE_SUPABASE_SERVICE_ROLE_KEY: 'dummy-key',
    AUDIT_FILE: AUDIT,
};
function clearSrc() { for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k]; }
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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('8. supabase.js command guard exists, is awaited, and covers the three write subcommands', () => {
    const text = read('src/integrations/supabase.js');
    const re = /requireProdMode\s*\(/g;
    let m, n = 0;
    while ((m = re.exec(text))) {
        n++;
        assert.match(text.slice(Math.max(0, m.index - 12), m.index), /await\s+$/, 'un-awaited requireProdMode(');
    }
    assert.equal(n, 1);
    assert.match(text, /\['sync-now', 'republish-all', 'autosync-start'\]\.includes\(sub\)/);
    assert.match(text, /require\('\.\.\/core\/devMode'\)/);
});

test('9. syncPostedEvents DEV_MODE result is ok:true with no errors (autosync tick stays silent)', async () => {
    await withEnv({ ...SCRUB, DEV_MODE: 'true' }, async () => {
        const { syncPostedEvents } = require(path.join(ROOT, 'src/integrations/supabase'));
        const r = await syncPostedEvents({ cache: { settings: {} } }, {});
        assert.equal(r.ok, true);
        assert.equal(r.uploaded, 0);
        assert.ok(Array.isArray(r.errors) && r.errors.length === 0);
        assert.equal(r.skipped, 'dev_mode');
    });
});

test('10. autopublish: tryCrosspost, post hook and publish-previous all refuse in DEV_MODE', async () => {
    await withEnv({ ...SCRUB, DEV_MODE: 'true' }, async () => {
        const ap = require(path.join(ROOT, 'src/discord/extensions/autopublish'));
        let crossposted = false, fetched = 0;
        const msg = { id: '1', crosspostable: true, crosspost: async () => { crossposted = true; } };
        assert.equal(await ap.tryCrosspost({}, 'c', msg), false);
        assert.equal(crossposted, false);
        const bot = {
            cache: { settings: { autopublishEnabled: true } },
            client: { channels: { fetch: async () => { fetched++; throw new Error('no network in test'); } } },
        };
        const r1 = await ap.sequencedPostPublish(bot, { title: 't' }, 'main', 'cat', 'chan');
        assert.equal(r1.reason, 'dev_mode');
        const r2 = await ap.publishPreviousInChannels(bot, ['chan'], 10);
        assert.deepEqual(r2, { deleted: 0, published: 0, skipped: 0, devMode: true });
        assert.equal(fetched, 0, 'no Discord fetches may happen in DEV_MODE');
    });
});

test('11. control: without DEV_MODE, tryCrosspost still crossposts (the guard is what blocks)', async () => {
    await withEnv({ ...SCRUB, DEV_MODE: '' }, async () => {
        const ap = require(path.join(ROOT, 'src/discord/extensions/autopublish'));
        let crossposted = false;
        const msg = { id: '1', crosspostable: true, crosspost: async () => { crossposted = true; } };
        assert.equal(await ap.tryCrosspost({}, 'c', msg), true);
        assert.equal(crossposted, true);
    });
});

test('12. websiteSync engine folds DEV_MODE into DRY_RUN', async () => {
    await withEnv({ ...SCRUB, DEV_MODE: 'true' }, () => {
        assert.equal(require(path.join(ROOT, 'src/integrations/websiteSync/engine')).DRY_RUN, true);
    });
});

test('13. checkForMissedScrapeAndCatchUp returns early when DEV_MODE=true (control: runs without it)', async () => {
    const touched = [];
    const spyBot = () => new Proxy({}, {
        get(_t, prop) { touched.push(String(prop)); throw new Error('bot touched: ' + String(prop)); },
    });
    await withEnv({ ...SCRUB, DEV_MODE: 'true' }, async () => {
        const { checkForMissedScrapeAndCatchUp } = require(SRC + 'posting/schedule.js');
        const r = await checkForMissedScrapeAndCatchUp(spyBot());
        assert.equal(r, undefined);
        assert.deepEqual(touched, [], 'guard must return before touching bot');
    });
    touched.length = 0;
    await withEnv({ ...SCRUB, DEV_MODE: 'false' }, async () => {
        const { checkForMissedScrapeAndCatchUp } = require(SRC + 'posting/schedule.js');
        await checkForMissedScrapeAndCatchUp(spyBot()).catch(() => {});
        assert.ok(touched.length > 0, 'control: without DEV_MODE the function proceeds into bot state');
    });
});

function makeDedupeHarness() {
    const calls = { replies: [], defers: 0, edits: [], fetches: 0 };
    const interaction = {
        deferred: false, replied: false,
        options: { getChannel: () => null, getInteger: () => null },
        reply: async (p) => { calls.replies.push(p); },
        followUp: async (p) => { calls.replies.push(p); },
        deferReply: async () => { calls.defers++; },
        editReply: async (p) => { calls.edits.push(p); },
    };
    const bot = {
        CATEGORIES: { events: { main: '111' } },
        client: {
            user: { id: 'bot' },
            channels: { fetch: async () => {
                calls.fetches++;
                return { isTextBased: () => true, messages: { fetch: async () => ({ size: 0, values: () => [] }) } };
            } },
        },
        normalizeEventName: (s) => String(s).toLowerCase(),
        sendLogMessage: async () => {},
    };
    return { calls, interaction, bot };
}

test('14. /dedupe refuses in DEV_MODE (ephemeral reply, no scan, no delete); control: proceeds without it', async () => {
    const { MessageFlags } = require('discord.js');
    await withEnv({ ...SCRUB, DEV_MODE: 'true' }, async () => {
        const { handlers } = require(SRC + 'discord/extensions/dedupe.js');
        const h = makeDedupeHarness();
        await handlers.dedupe(h.bot, h.interaction);
        assert.equal(h.calls.replies.length, 1);
        assert.equal(h.calls.replies[0].flags, MessageFlags.Ephemeral);
        assert.match(h.calls.replies[0].content, /DEV_MODE=true/);
        assert.equal(h.calls.defers, 0, 'must not defer');
        assert.equal(h.calls.fetches, 0, 'must not touch any channel');
    });
    await withEnv({ ...SCRUB, DEV_MODE: 'false' }, async () => {
        const { handlers } = require(SRC + 'discord/extensions/dedupe.js');
        const h = makeDedupeHarness();
        await handlers.dedupe(h.bot, h.interaction);
        assert.equal(h.calls.defers, 1, 'control: handler proceeds');
        assert.equal(h.calls.fetches, 1);
        assert.match(h.calls.edits[0].content, /no duplicates/);
    });
});

test('15. deleteDuplicateMessages (leaf) refuses in DEV_MODE even when called directly; control: deletes without it', async () => {
    const mk = (deleted) => [
        { id: 'm1', content: '## Dup Event', createdTimestamp: 1, author: { id: 'bot' }, delete: async () => { deleted.push('m1'); } },
        { id: 'm2', content: '## Dup Event', createdTimestamp: 2, author: { id: 'bot' }, delete: async () => { deleted.push('m2'); } },
    ];
    const bot = { normalizeEventName: (s) => String(s).toLowerCase() };
    await withEnv({ ...SCRUB, DEV_MODE: 'true' }, async () => {
        const { deleteDuplicateMessages } = require(SRC + 'discord/extensions/dedupe.js');
        const deleted = [];
        const r = await deleteDuplicateMessages(bot, '111', mk(deleted));
        assert.deepEqual(r, []);
        assert.deepEqual(deleted, [], 'no delete may be attempted');
    });
    await withEnv({ ...SCRUB, DEV_MODE: 'false' }, async () => {
        const { deleteDuplicateMessages } = require(SRC + 'discord/extensions/dedupe.js');
        const deleted = [];
        const r = await deleteDuplicateMessages(bot, '111', mk(deleted));
        assert.deepEqual(deleted, ['m2'], 'control: newer duplicate is deleted');
        assert.equal(r.length, 1);
    });
});
