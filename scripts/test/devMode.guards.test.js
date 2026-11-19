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

test('19. both scrape-cron callbacks refuse in DEV_MODE (control: scrapeAndNotify runs without it)', async () => {
    const cronPath = require.resolve('node-cron');
    require('node-cron');
    const entry = require.cache[cronPath];
    const realExports = entry.exports;
    const runCallbacks = async (devMode) => {
        const captured = [];
        entry.exports = { ...realExports, validate: realExports.validate, schedule: (expr, cb) => { captured.push(cb); return { stop() {} }; } };
        try {
            return await withEnv({ ...SCRUB, DEV_MODE: devMode }, async () => {
                const schedule = require(SRC + 'posting/schedule.js');
                let scrapes = 0;
                const bot = { cache: { settings: { scrapeCron: '0 */6 * * *' } }, scrapeAndNotify: async () => { scrapes++; } };
                schedule.scheduleAutomaticScraping(bot);
                schedule.rescheduleWithCustomCron(bot, '0 */6 * * *');
                assert.equal(captured.length, 2, 'both registration points must register a callback');
                for (const cb of captured) await cb();
                await new Promise((r) => setImmediate(r));
                return scrapes;
            });
        } finally {
            entry.exports = realExports;
        }
    };
    assert.equal(await runCallbacks('true'), 0, 'no scrape may start from a cron tick in DEV_MODE');
    assert.equal(await runCallbacks('false'), 2, 'control: both callbacks scrape without DEV_MODE');
});

test('20. /api/send-event live path is guarded before postEventToCategory (source-order check; smoke-test at supervised boot)', () => {
    const text = read('src/web/server.js');
    const routeIdx = text.indexOf("'/api/send-event'");
    assert.ok(routeIdx > -1, 'send-event route missing');
    const guardIdx = text.indexOf("noteBlocked('api/send-event:live')", routeIdx);
    const postIdx = text.indexOf('postEventToCategory(', routeIdx);
    assert.ok(guardIdx > -1, 'send-event guard missing');
    assert.ok(postIdx > -1, 'postEventToCategory call missing');
    assert.ok(guardIdx < postIdx, 'guard must precede the post call');
    const line = text.slice(text.lastIndexOf('\n', guardIdx) + 1, text.indexOf('\n', guardIdx));
    assert.match(line, /mode === 'main'/);
    assert.match(line, /return res\.status\(403\)/);
});

test('21. /publish-previous refuses at command entry in DEV_MODE (ephemeral, no defer); control: proceeds without it', async () => {
    const { MessageFlags } = require('discord.js');
    await withEnv({ ...SCRUB, DEV_MODE: 'true' }, async () => {
        const { handlers } = require(SRC + 'discord/extensions/dedupe.js');
        const h = makeDedupeHarness();
        await handlers['publish-previous'](h.bot, h.interaction);
        assert.equal(h.calls.replies.length, 1);
        assert.equal(h.calls.replies[0].flags, MessageFlags.Ephemeral);
        assert.match(h.calls.replies[0].content, /DEV_MODE=true/);
        assert.equal(h.calls.defers, 0, 'must not defer');
    });
    await withEnv({ ...SCRUB, DEV_MODE: 'false' }, async () => {
        const { handlers } = require(SRC + 'discord/extensions/dedupe.js');
        const h = makeDedupeHarness();
        await handlers['publish-previous'](h.bot, h.interaction).catch(() => {});
        assert.equal(h.calls.defers, 1, 'control: handler proceeds past the guard');
    });
});

test('22. deliverAlert refuses in DEV_MODE (no Discord send) while recordOutcome keeps streak and cooldown; control: sends without it', async () => {
    const run = (devMode) => withEnv({ ...SCRUB, DEV_MODE: devMode, ALERTS_CHANNEL_ID: '999', ALERTS_PING_ROLE_ID: '' }, async () => {
        const { recordOutcome } = require(SRC + 'scrapers/alerts.js');
        const sent = [];
        const bot = {
            cache: { settings: { sourceAlertThreshold: 1, sourceAlertCooldownMinutes: 60 } },
            saveCache() {},
            client: { channels: { fetch: async () => ({ send: async (payload) => { sent.push(payload); } }) } },
        };
        const result = await recordOutcome(bot, 'testsource', 'jobs', { status: 'parse_failed', errorMessage: 'boom' });
        return { sent, result, entry: bot.cache.settings.sourceAlertState.testsource };
    });
    const dev = await run('true');
    assert.equal(dev.sent.length, 0, 'no Discord send in DEV_MODE');
    assert.equal(dev.result.fired, true);
    assert.equal(dev.entry.consecutiveFailures, 1, 'streak tracking stays on');
    assert.equal(typeof dev.entry.lastAlertAt, 'number', 'cooldown state stays on');
    const prod = await run('false');
    assert.equal(prod.sent.length, 1, 'control: alert is sent without DEV_MODE');
    assert.match(prod.sent[0].content, /Source failure alert/);
});

test('23. postEventToCategory refuses mode=main in DEV_MODE (ok:false, bot untouched); test mode and the no-DEV_MODE control are not refused', async () => {
    const touched = [];
    const spyBot = () => new Proxy({}, { get(_t, prop) { touched.push(String(prop)); throw new Error('bot touched: ' + String(prop)); } });
    const event = { id: 'e1', title: 'Guard test', category: 'x' };
    const attempt = (devMode, mode) => withEnv({ ...SCRUB, DEV_MODE: devMode }, async () => {
        const { postEventToCategory } = require(SRC + 'posting/post.js');
        try { return await postEventToCategory(spyBot(), event, mode); }
        catch (e) { return { threw: true }; }
    });
    const refused = await attempt('true', 'main');
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'dev_mode');
    assert.equal(refused.skipped, 'dev_mode');
    assert.deepEqual(touched, [], 'guard must return before touching bot');
    const testMode = await attempt('true', 'test');
    assert.notEqual(testMode.reason, 'dev_mode', 'test-channel posts stay available in DEV_MODE');
    const control = await attempt('false', 'main');
    assert.notEqual(control.reason, 'dev_mode', 'control: main proceeds without DEV_MODE');
});

test('24. resumeOrWarnAutopostAfterRestart returns early in DEV_MODE (no log, no persist, snapshot untouched); control: runs without it', async () => {
    const run = (devMode) => withEnv({ ...SCRUB, DEV_MODE: devMode }, async () => {
        const { resumeOrWarnAutopostAfterRestart } = require(SRC + 'posting/autopost.js');
        const track = () => ({ test: { active: false, intervalMinutes: 60 }, live: { active: false, intervalMinutes: 60 } });
        const logs = [];
        let saves = 0;
        const bot = {
            cache: { settings: {
                autopostConfigSnapshot: {
                    events: { test: { active: false, intervalMinutes: 60 }, live: { active: true, intervalMinutes: 60 } },
                    jobs: track(),
                    scholarships: track(),
                },
                autopostDeliberateStop: { events: { live: true, test: false } },
            } },
            autopostConfig: { events: track(), jobs: track(), scholarships: track() },
            sendLogMessage: async (m) => { logs.push(m); },
            saveCache() { saves++; },
        };
        await resumeOrWarnAutopostAfterRestart(bot);
        return { logs, saves, bot };
    });
    const dev = await run('true');
    assert.equal(dev.logs.length, 0, 'no logs-channel message in DEV_MODE');
    assert.equal(dev.saves, 0, 'no persist in DEV_MODE');
    assert.equal(dev.bot.cache.settings.autopostConfigSnapshot.events.live.active, true, 'snapshot must not be wiped');
    assert.equal(dev.bot.cache.settings.autopostDeliberateStop.events.live, true, 'deliberate-stop flag must be left for the next real boot');
    const prod = await run('false');
    assert.equal(prod.logs.length, 1, 'control: deliberate-stop note is sent without DEV_MODE');
    assert.match(prod.logs[0], /deliberately stopped/);
    assert.equal(prod.saves, 1, 'control: state is persisted without DEV_MODE');
    assert.equal(prod.bot.cache.settings.autopostConfigSnapshot.events.live.active, false, 'control: shows the overwrite the guard prevents');
});

// D7:undo-edit -- live-destructive extension commands refuse in DEV_MODE (tests 25-27)
{
    const d7test = require('node:test').test;
    const d7assert = require('node:assert/strict');
    const { MessageFlags: D7MessageFlags } = require('discord.js');

    const d7WithDevMode = async (flag, fn) => {
        const env = require('../../src/config/env');
        const had = Object.prototype.hasOwnProperty.call(env, 'DEV_MODE');
        const prev = env.DEV_MODE;
        env.DEV_MODE = flag;
        try {
            d7assert.equal(require('../../src/core/devMode').isDevMode(), flag, 'env.DEV_MODE toggle did not take effect');
            await fn();
        } finally {
            if (had) env.DEV_MODE = prev; else delete env.DEV_MODE;
        }
    };

    const d7ModPath = require.resolve('../../src/discord/extensions/undo-edit');
    const d7Load = () => {
        const audit = require('../../src/core/auditLogger');
        const orig = audit.auditLog;
        audit.auditLog = () => {};
        delete require.cache[d7ModPath];
        try { return require(d7ModPath); } finally { audit.auditLog = orig; }
    };
    const d7Drop = () => { delete require.cache[d7ModPath]; };

    const d7MkBot = () => {
        const calls = { del: 0, edit: 0, lastEdit: null, fetchCh: 0, save: 0, log: 0, release: 0 };
        const event = { id: 'ev1', title: 'Test Event' };
        const message = {
            id: 'm1',
            author: { id: 'bot1' },
            content: '## Test Event\nbody',
            delete: async () => { calls.del++; },
            edit: async (a) => { calls.edit++; calls.lastEdit = a; },
        };
        const channel = {
            id: 'c1',
            messages: { fetch: async (arg) => (typeof arg === 'string' ? message : new Map([['m1', message]])) },
        };
        const bot = {
            cache: { postedEvents: [event], pendingEvents: [], postedEventKeys: ['k1'] },
            _ext: { recentPosts: [{ eventId: 'ev1', title: 'Test Event', channelId: 'c1', messageId: 'm1', mode: 'main', postedAt: 1 }] },
            CATEGORIES: { sports: { main: 'c1', test: 't1' } },
            client: { user: { id: 'bot1' }, channels: { fetch: async () => { calls.fetchCh++; return channel; } } },
            getEventDedupKey: () => 'k1',
            releasePostedMarker: () => { calls.release++; },
            saveCache: () => { calls.save++; },
            sendLogMessage: async () => { calls.log++; },
            normalizeEventName: (s) => String(s).toLowerCase(),
            sanitizeEventFields: () => {},
            formatEventMessage: () => 'FORMATTED',
        };
        return { bot, calls, event };
    };

    const d7MkInteraction = (opts = {}) => {
        const rec = { reply: [], followUp: [], defer: [], editReply: [], showModal: 0, optionReads: 0, fieldReads: 0 };
        const interaction = {
            deferred: false,
            replied: false,
            customId: opts.customId,
            user: { tag: 'tester#0001' },
            options: { getString: () => { rec.optionReads++; return opts.query === undefined ? null : opts.query; } },
            fields: { getTextInputValue: (id) => { rec.fieldReads++; return opts.fields ? opts.fields[id] : ''; } },
            reply: async (p) => { interaction.replied = true; rec.reply.push(p); },
            followUp: async (p) => { rec.followUp.push(p); },
            deferReply: async (p) => { interaction.deferred = true; rec.defer.push(p); },
            editReply: async (p) => { rec.editReply.push(p); },
            showModal: async () => { rec.showModal++; },
        };
        return { interaction, rec };
    };

    const d7Snap = (bot) => JSON.stringify({ cache: bot.cache, ext: bot._ext });

    const d7AssertRefusal = (rec, name) => {
        d7assert.equal(rec.reply.length, 1);
        d7assert.equal(rec.reply[0].flags, D7MessageFlags.Ephemeral);
        d7assert.ok(rec.reply[0].content.includes('DEV_MODE=true'));
        d7assert.ok(rec.reply[0].content.includes('/' + name + ' disabled'));
        d7assert.equal(rec.followUp.length, 0);
        d7assert.equal(rec.defer.length, 0);
        d7assert.equal(rec.editReply.length, 0);
    };

    d7test('25. /undo refuses in DEV_MODE (ephemeral reply, no defer, no option read, no message.delete, cache untouched); control: deletes and reverts to pending without it', async () => {
        const mod = d7Load();
        try {
            await d7WithDevMode(true, async () => {
                const { bot, calls } = d7MkBot();
                const { interaction, rec } = d7MkInteraction({});
                const before = d7Snap(bot);
                await mod.handlers.undo(bot, interaction);
                d7AssertRefusal(rec, 'undo');
                d7assert.equal(rec.optionReads, 0);
                d7assert.equal(calls.del, 0);
                d7assert.equal(calls.fetchCh, 0);
                d7assert.equal(calls.release, 0);
                d7assert.equal(calls.save, 0);
                d7assert.equal(calls.log, 0);
                d7assert.equal(d7Snap(bot), before);
            });
            await d7WithDevMode(false, async () => {
                const { bot, calls } = d7MkBot();
                const { interaction, rec } = d7MkInteraction({});
                await mod.handlers.undo(bot, interaction);
                d7assert.equal(rec.reply.length, 0);
                d7assert.equal(rec.defer.length, 1);
                d7assert.equal(calls.del, 1);
                d7assert.equal(calls.release, 1);
                d7assert.equal(calls.save, 1);
                d7assert.equal(bot.cache.postedEvents.length, 0);
                d7assert.equal(bot.cache.pendingEvents.length, 1);
                d7assert.equal(bot.cache.pendingEvents[0].id, 'ev1');
                d7assert.ok(rec.editReply[0].content.includes('Undid'));
            });
        } finally { d7Drop(); }
    });

    d7test('26. /edit-live refuses in DEV_MODE (ephemeral reply, no option read, no message lookup, no showModal); control: opens the modal without it', async () => {
        const mod = d7Load();
        try {
            await d7WithDevMode(true, async () => {
                const { bot, calls } = d7MkBot();
                const { interaction, rec } = d7MkInteraction({ query: 'test event' });
                const before = d7Snap(bot);
                await mod.handlers['edit-live'](bot, interaction);
                d7AssertRefusal(rec, 'edit-live');
                d7assert.equal(rec.optionReads, 0);
                d7assert.equal(rec.showModal, 0);
                d7assert.equal(calls.fetchCh, 0);
                d7assert.equal(d7Snap(bot), before);
            });
            await d7WithDevMode(false, async () => {
                const { bot, calls } = d7MkBot();
                const { interaction, rec } = d7MkInteraction({ query: 'test event' });
                await mod.handlers['edit-live'](bot, interaction);
                d7assert.equal(rec.reply.length, 0);
                d7assert.equal(rec.defer.length, 1);
                d7assert.equal(rec.showModal, 1);
                d7assert.ok(calls.fetchCh >= 1);
            });
        } finally { d7Drop(); }
    });

    d7test('27. /edit-live modal submit refuses in DEV_MODE (ephemeral reply, no field read, no message.edit, event + cache unchanged); control: edits without it', async () => {
        const mod = d7Load();
        const fields = { title: 'New Title', description: 'New desc', date: '', location: '' };
        try {
            await d7WithDevMode(true, async () => {
                const { bot, calls, event } = d7MkBot();
                const { interaction, rec } = d7MkInteraction({ customId: 'ext_edit_live:c1:m1:ev1', fields });
                const before = d7Snap(bot);
                await mod.modalHandlers.ext_edit_live(bot, interaction);
                d7AssertRefusal(rec, 'edit-live-submit');
                d7assert.equal(rec.fieldReads, 0);
                d7assert.equal(calls.edit, 0);
                d7assert.equal(calls.fetchCh, 0);
                d7assert.equal(calls.save, 0);
                d7assert.equal(event.title, 'Test Event');
                d7assert.equal(event.description, undefined);
                d7assert.equal(d7Snap(bot), before);
            });
            await d7WithDevMode(false, async () => {
                const { bot, calls, event } = d7MkBot();
                const { interaction, rec } = d7MkInteraction({ customId: 'ext_edit_live:c1:m1:ev1', fields });
                await mod.modalHandlers.ext_edit_live(bot, interaction);
                d7assert.equal(event.title, 'New Title');
                d7assert.equal(calls.save, 1);
                d7assert.equal(calls.edit, 1);
                d7assert.deepEqual(calls.lastEdit, { content: 'FORMATTED' });
                d7assert.equal(rec.reply.length, 1);
                d7assert.ok(rec.reply[0].content.includes('updated'));
                d7assert.ok(!rec.reply[0].content.includes('DEV_MODE'));
            });
        } finally { d7Drop(); }
    });
}
