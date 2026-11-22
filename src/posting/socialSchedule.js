'use strict';
// Instagram club scheduler: one due club per tick, persisted backoff, alert on repeated blocks.
// Off unless IG_SCHEDULER=1. State: data/instagram/schedule.json (atomic writes, corrupt file never overwritten).
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('../core/jsonStore');

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const LADDER_MS = [5 * MIN_MS, 30 * MIN_MS, 2 * HOUR_MS];
const ALERT_AT = 5;
const BASE_INTERVAL_HOURS = 24;
const RATE_RE = /429|rate|too many|try again/i;
const FILE = path.join(__dirname, '..', '..', 'data', 'instagram', 'schedule.json');

const iso = (ms) => new Date(ms).toISOString();
const backoffMs = (n) => LADDER_MS[Math.min(Math.max(n, 1), LADDER_MS.length) - 1];
function intervalMs(env) {
    const h = Number((env || process.env).IG_MIN_INTERVAL_HOURS);
    return Math.max(BASE_INTERVAL_HOURS, Number.isFinite(h) ? h : 0) * HOUR_MS;
}

function createScheduleStore(opts = {}) {
    const file = opts.file || FILE;
    function read() {
        let raw;
        try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
            if (e && e.code === 'ENOENT') return { data: {}, corrupt: false };
            return { data: {}, corrupt: true, error: String(e.message) };
        }
        try {
            const d = JSON.parse(raw);
            if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('not an object');
            return { data: d, corrupt: false };
        } catch (e) { return { data: {}, corrupt: true, error: String(e.message) }; }
    }
    function write(data) { writeJsonAtomic(file, data); }
    function update(mutator) {
        const snap = read();
        if (snap.corrupt) return { ok: false, error: snap.error };
        mutator(snap.data);
        write(snap.data);
        return { ok: true, data: snap.data };
    }
    return { file, read, write, update };
}

function classify(out, handle) {
    const meta = (out && out.meta) || {};
    const errs = Array.isArray(meta.profileErrors) ? meta.profileErrors : [];
    const setup = errs.find((e) => e && e.club === '*');
    if (setup) return { kind: 'login_required', error: String(setup.error || 'setup failed') };
    const pc = ((meta.instagram || {}).perClub || {})[handle];
    if (pc) {
        if (pc.state === 'login' || pc.state === 'challenge') return { kind: 'login_required', error: pc.state };
        if (pc.error) {
            const m = String(pc.error);
            return { kind: RATE_RE.test(m) ? 'rate_limited' : 'error', error: m };
        }
        if (pc.state === 'ok' || pc.state === 'empty' || pc.skipped) return { kind: 'ok' };
        return { kind: 'error', error: String(pc.state || 'unknown') };
    }
    if (meta.looksBlocked || meta.sessionDead || meta.cooldownActive) {
        return { kind: 'login_required', error: String(meta.sessionDeadReason || (meta.cooldownActive ? 'cooldown_active' : 'looks_blocked')) };
    }
    return { kind: 'error', error: 'no_result' };
}

function hm(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes());
}
function describeStatus(rec, now) {
    if (!rec || (!rec.lastFetchAt && !rec.status && !rec.nextAttemptAt)) return 'never fetched';
    const last = Date.parse(rec.lastFetchAt);
    const lastTxt = Number.isFinite(last) ? 'last ' + (new Date(last).getMonth() + 1) + '/' + new Date(last).getDate() + ' ' + hm(last) : 'last never';
    const nxt = Date.parse(rec.nextAttemptAt);
    let st = 'ok';
    if (Number.isFinite(nxt) && nxt > now) st = 'backing off until ' + hm(nxt);
    else if ((rec.consecutiveBlocks || 0) > 0) st = 'blocked x' + rec.consecutiveBlocks;
    else if (rec.status === 'error') st = 'error: ' + String(rec.lastError || '').slice(0, 40);
    return lastTxt + ', ' + st;
}

function createScheduler(deps) {
    const store = deps.store || createScheduleStore();
    const runner = deps.runner;
    const clock = deps.clock || Date.now;
    const env = deps.env || process.env;
    const listClubs = deps.listClubs;
    const log = deps.log || ((m) => console.log('[igSchedule] ' + m));
    let running = false;
    let pausedLogged = false;

    const dueAt = (rec, interval) => {
        const last = Date.parse(rec.lastFetchAt);
        const nxt = Date.parse(rec.nextAttemptAt);
        return Math.max(Number.isFinite(last) ? last + interval : 0, Number.isFinite(nxt) ? nxt : 0);
    };
    const blank = () => ({ status: 'ok', consecutiveBlocks: 0, nextAttemptAt: null, lastFetchAt: null, lastError: null, alerted: false });

    async function tick(bot) {
        if (running) return { skipped: 'running' };
        running = true;
        try {
            const snap = store.read();
            if (snap.corrupt) {
                if (!pausedLogged) { log('schedule.json unreadable, scheduler paused (file left untouched): ' + snap.error); pausedLogged = true; }
                return { paused: true };
            }
            pausedLogged = false;
            const now = clock();
            const interval = intervalMs(env);
            const cands = listClubs().filter((c) => c && c.enabled)
                .map((c) => { const rec = snap.data[c.username] || {}; return { u: c.username, rec, at: dueAt(rec, interval) }; })
                .filter((x) => now >= x.at);
            if (!cands.length) return { idle: true };
            cands.sort((a, b) => (a.at - b.at) || ((b.rec.consecutiveBlocks || 0) - (a.rec.consecutiveBlocks || 0)) || (a.u < b.u ? -1 : a.u > b.u ? 1 : 0));
            const handle = cands[0].u;

            let out = null;
            let cls = null;
            try { out = await runner(bot, { only: handle }); } catch (e) {
                const m = String((e && e.message) || e);
                cls = { kind: RATE_RE.test(m) ? 'rate_limited' : 'error', error: m };
            }
            if (out && out.busy) return { skipped: 'busy' };
            if (!cls) cls = classify(out, handle);

            const end = clock();
            let alertText = null;
            let nextTxt = '';
            const res = store.update((data) => {
                const rec = data[handle] = Object.assign(blank(), data[handle]);
                if (cls.kind === 'ok') {
                    Object.assign(rec, { status: 'ok', consecutiveBlocks: 0, nextAttemptAt: null, lastFetchAt: iso(end), lastError: null, alerted: false });
                    return;
                }
                if (cls.kind === 'error') {
                    Object.assign(rec, { status: 'error', lastFetchAt: iso(end), lastError: cls.error, nextAttemptAt: null });
                    return;
                }
                rec.consecutiveBlocks = (rec.consecutiveBlocks || 0) + 1;
                rec.status = cls.kind;
                rec.lastError = cls.error;
                rec.nextAttemptAt = iso(end + backoffMs(rec.consecutiveBlocks));
                nextTxt = ' next ' + rec.nextAttemptAt;
                if (rec.consecutiveBlocks === ALERT_AT && !rec.alerted) {
                    rec.alerted = true;
                    alertText = '\u26A0\uFE0F Instagram scraper: ' + ALERT_AT + ' consecutive blocks on @' + handle + ', manual /insta-login needed';
                }
                if (cls.kind === 'login_required') {
                    for (const c of listClubs()) {
                        if (!c || !c.enabled || c.username === handle) continue;
                        const other = data[c.username] = Object.assign(blank(), data[c.username]);
                        other.nextAttemptAt = rec.nextAttemptAt;
                    }
                }
            });
            if (!res.ok) log('schedule.json became unreadable, result not saved: ' + res.error);
            log('@' + handle + ' -> ' + cls.kind + (cls.error ? ' (' + String(cls.error).slice(0, 80) + ')' : '') + nextTxt);
            if (alertText) {
                try {
                    if (!bot || typeof bot.sendLogMessage !== 'function') throw new Error('bot.sendLogMessage missing');
                    await bot.sendLogMessage(alertText);
                } catch (e) { log('alert failed: ' + String((e && e.message) || e)); }
            }
            return { ran: handle, kind: cls.kind };
        } finally { running = false; }
    }
    return { tick };
}

function start(bot, deps = {}) {
    const env = deps.env || process.env;
    if (String(env.IG_SCHEDULER || '') !== '1') return null;
    const log = deps.log || ((m) => console.log('[igSchedule] ' + m));
    const cron = deps.cron || require('node-cron');
    const runner = deps.runner || ((b, o) => require('../discord/commands/club').runClubFetch(b, o));
    const listClubs = deps.listClubs || (() => require('./socialPost').clubsStore.list());
    const sched = createScheduler({ store: deps.store, runner, clock: deps.clock, env, listClubs, log });
    if (bot.instagramSchedulerCronTask) bot.instagramSchedulerCronTask.stop();
    bot.instagramSchedulerCronTask = cron.schedule('* * * * *', () => {
        sched.tick(bot).catch((e) => log('tick crashed: ' + String((e && e.message) || e)));
    });
    log('scheduler on, one club per minute');
    return bot.instagramSchedulerCronTask;
}

module.exports = { createScheduleStore, createScheduler, start, classify, backoffMs, intervalMs, describeStatus, ALERT_AT, FILE };
