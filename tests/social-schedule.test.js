'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SS = require('../src/posting/socialSchedule');

const MIN = 60000, HOUR = 3600000;
const T0 = Date.UTC(2026, 10, 22, 0, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const ALERT = (h) => '\u26A0\uFE0F Instagram scraper: 5 consecutive blocks on @' + h + ', manual /insta-login needed';
const okOut = (h) => ({ items: [], meta: { instagram: { perClub: { [h]: { state: 'ok' } } } } });
const stateOut = (h, state) => ({ items: [], meta: { instagram: { perClub: { [h]: { state } } } } });
const errOut = (h, error) => ({ items: [], meta: { instagram: { perClub: { [h]: { error } } } } });

function rig(over = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
    const file = path.join(dir, 'schedule.json');
    const r = { file, clock: { t: T0 }, calls: [], logs: [], alerts: [], next: okOut, clubs: over.clubs || ['a'], env: over.env || {} };
    r.bot = { sendLogMessage: async (m) => { if (over.alertFails) throw new Error('boom'); r.alerts.push(m); } };
    r.store = SS.createScheduleStore({ file });
    r.make = () => SS.createScheduler({
        store: SS.createScheduleStore({ file }),
        runner: async (b, o) => { r.calls.push(o.only); return r.next(o.only); },
        clock: () => r.clock.t,
        env: r.env,
        listClubs: () => r.clubs.map((u) => ({ username: u, enabled: true })),
        log: (m) => r.logs.push(m)
    });
    r.sched = r.make();
    r.rec = (h) => r.store.read().data[h];
    r.tick = () => r.sched.tick(r.bot);
    r.jump = (h) => { r.clock.t = Date.parse(r.rec(h).nextAttemptAt) + 1000; };
    r.blocks = async (h, n) => { for (let i = 0; i < n; i++) { await r.tick(); r.jump(h); } };
    return r;
}

test('ladder 5m / 30m / 2h / 2h cap, success resets', async () => {
    const r = rig();
    r.next = (h) => stateOut(h, 'challenge');
    const want = [5 * MIN, 30 * MIN, 2 * HOUR, 2 * HOUR];
    for (let i = 0; i < 4; i++) {
        const t = r.clock.t;
        await r.tick();
        const rec = r.rec('a');
        assert.equal(rec.consecutiveBlocks, i + 1);
        assert.equal(rec.status, 'login_required');
        assert.equal(rec.nextAttemptAt, iso(t + want[i]));
        if (i === 0) {
            r.clock.t = t + MIN;
            await r.tick();
            assert.equal(r.calls.length, 1, 'not due inside the backoff window');
        }
        r.jump('a');
    }
    r.next = okOut;
    await r.tick();
    const rec = r.rec('a');
    assert.equal(rec.consecutiveBlocks, 0);
    assert.equal(rec.alerted, false);
    assert.equal(rec.nextAttemptAt, null);
    assert.equal(rec.lastFetchAt, iso(r.clock.t));
});

test('exactly one alert at the 5th block, none at the 6th, new one after success + 5 blocks', async () => {
    const r = rig();
    r.next = (h) => stateOut(h, 'challenge');
    await r.blocks('a', 4);
    assert.equal(r.alerts.length, 0);
    await r.blocks('a', 1);
    assert.deepEqual(r.alerts, [ALERT('a')]);
    assert.equal(r.rec('a').alerted, true);
    await r.blocks('a', 1);
    assert.equal(r.alerts.length, 1);
    r.next = okOut;
    await r.tick();
    assert.equal(r.rec('a').alerted, false);
    r.next = (h) => stateOut(h, 'challenge');
    r.clock.t += 25 * HOUR;
    await r.blocks('a', 5);
    assert.equal(r.alerts.length, 2);
    assert.equal(r.alerts[1], ALERT('a'));
});

test('a failed alert is logged and never stops the scheduler', async () => {
    const r = rig({ alertFails: true });
    r.next = (h) => stateOut(h, 'login');
    await r.blocks('a', 5);
    assert.equal(r.rec('a').alerted, true);
    assert.ok(r.logs.some((l) => /alert failed/.test(l)));
    const before = r.calls.length;
    await r.tick();
    assert.equal(r.calls.length, before + 1);
});

test('one club per tick (stagger)', async () => {
    const r = rig({ clubs: ['a', 'b', 'c'] });
    await r.tick();
    assert.deepEqual(r.calls, ['a']);
    await r.tick();
    await r.tick();
    assert.deepEqual(r.calls, ['a', 'b', 'c']);
    await r.tick();
    assert.equal(r.calls.length, 3, 'nothing due after all three fetched');
});

test('no re-fetch within 24h after a restart', async () => {
    const r = rig();
    await r.tick();
    assert.equal(r.calls.length, 1);
    r.clock.t = T0 + 23 * HOUR;
    const restarted = r.make();
    await restarted.tick(r.bot);
    assert.equal(r.calls.length, 1);
    r.clock.t = T0 + 24 * HOUR;
    await restarted.tick(r.bot);
    assert.equal(r.calls.length, 2);
});

test('interval is max(24h, IG_MIN_INTERVAL_HOURS)', async () => {
    assert.equal(SS.intervalMs({}), 24 * HOUR);
    assert.equal(SS.intervalMs({ IG_MIN_INTERVAL_HOURS: '1' }), 24 * HOUR);
    assert.equal(SS.intervalMs({ IG_MIN_INTERVAL_HOURS: '48' }), 48 * HOUR);
    const r = rig({ env: { IG_MIN_INTERVAL_HOURS: '48' } });
    await r.tick();
    r.clock.t = T0 + 25 * HOUR;
    await r.tick();
    assert.equal(r.calls.length, 1);
    r.clock.t = T0 + 48 * HOUR;
    await r.tick();
    assert.equal(r.calls.length, 2);
});

test('login_required sets the same nextAttemptAt on every club', async () => {
    const r = rig({ clubs: ['a', 'b'] });
    r.next = (h) => stateOut(h, 'challenge');
    await r.tick();
    assert.deepEqual(r.calls, ['a']);
    assert.equal(r.rec('a').nextAttemptAt, iso(T0 + 5 * MIN));
    assert.equal(r.rec('b').nextAttemptAt, iso(T0 + 5 * MIN));
    r.clock.t = T0 + MIN;
    await r.tick();
    assert.equal(r.calls.length, 1, 'b is also backing off');
    r.jump('a');
    await r.tick();
    assert.deepEqual(r.calls, ['a', 'a'], 'the club with the streak is probed again');
});

test('setup failure (club "*") is login_required for all clubs', async () => {
    const r = rig({ clubs: ['a', 'b'] });
    r.next = () => ({ items: [], meta: { profileErrors: [{ club: '*', error: 'cookie/header setup failed: x' }], instagram: { perClub: {} } } });
    await r.tick();
    assert.equal(r.rec('a').status, 'login_required');
    assert.equal(r.rec('b').nextAttemptAt, r.rec('a').nextAttemptAt);
});

test('rate_limited backs off only that club', async () => {
    const r = rig({ clubs: ['a', 'b'] });
    r.next = (h) => errOut(h, 'HTTP 429 too many requests');
    await r.tick();
    assert.equal(r.rec('a').status, 'rate_limited');
    assert.equal(r.rec('a').consecutiveBlocks, 1);
    assert.equal(r.rec('b'), undefined);
    await r.tick();
    assert.deepEqual(r.calls, ['a', 'b']);
});

test('not_found / private / layout_changed are not blocks', async () => {
    for (const state of ['not_found', 'private', 'layout_changed']) {
        const r = rig();
        r.next = (h) => stateOut(h, state);
        await r.tick();
        const rec = r.rec('a');
        assert.equal(rec.consecutiveBlocks, 0);
        assert.equal(rec.status, 'error');
        assert.equal(rec.lastError, state);
        assert.equal(rec.nextAttemptAt, null);
        r.clock.t = T0 + 23 * HOUR;
        await r.tick();
        assert.equal(r.calls.length, 1);
        assert.equal(r.alerts.length, 0);
    }
});

test('corrupt schedule.json is never overwritten: log and pause', async () => {
    const r = rig();
    fs.writeFileSync(r.file, 'not json{');
    const out = await r.tick();
    assert.equal(out.paused, true);
    assert.equal(r.calls.length, 0);
    assert.equal(fs.readFileSync(r.file, 'utf8'), 'not json{');
    assert.equal(fs.existsSync(r.file + '.tmp'), false);
    assert.ok(r.logs.length >= 1);
});

test('IG_SCHEDULER gate', () => {
    const cron = { scheduled: [], schedule(expr) { this.scheduled.push(expr); return { stop() {} }; } };
    const base = { cron, runner: async () => ({}), listClubs: () => [] };
    const bot = {};
    assert.equal(SS.start(bot, Object.assign({ env: {} }, base)), null);
    assert.equal(SS.start(bot, Object.assign({ env: { IG_SCHEDULER: '0' } }, base)), null);
    assert.equal(cron.scheduled.length, 0);
    const task = SS.start(bot, Object.assign({ env: { IG_SCHEDULER: '1' }, log: () => {} }, base));
    assert.deepEqual(cron.scheduled, ['* * * * *']);
    assert.equal(bot.instagramSchedulerCronTask, task);
});

test('busy runner (manual fetch running) changes no state', async () => {
    const r = rig();
    r.next = () => ({ busy: true });
    const out = await r.tick();
    assert.equal(out.skipped, 'busy');
    assert.equal(fs.existsSync(r.file), false);
});
