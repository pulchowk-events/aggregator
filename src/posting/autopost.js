// src/posting/autopost.js
// Autopost: per-track (events/jobs/scholarships) × per-mode (test/live)
// posting timers.
//
// Six independent tracks — one per (type, mode) pair. Each track is its
// own setTimeout loop, so jobs never crowd out events, and test-posting
// never blocks live-posting. Every track can run at its own interval
// (0 = back-to-back / as-fast-as-possible).
//
// Two important properties:
//
//   1. Persistence across restart. Every state change (start/stop/interval
//      change/last-post-time) writes to cache.settings. On boot,
//      resumeOrWarnAutopostAfterRestart() re-arms every track that was
//      active before the crash — AND delays the first tick by the REMAINDER
//      of the interval (respects the fact that we might have posted 5
//      minutes before a crash on a 60-minute interval, so we should wait
//      55 more minutes, not 0).
//
//   2. Deliberate vs. accidental stop. A /autopost stop is deliberate —
//      do NOT resume on restart. A crash is not deliberate — resume.
//      cache.settings.autopostDeliberateStop tracks which tracks were
//      explicitly stopped.
//
// The tick loop itself is _runAutopostTickLocked — a mutex-wrapped pass
// that walks every eligible pending item in date order, runs the gates
// (past, too-soon, has-image, dedup), and posts the first one that survives
// them. Returns { posted: true | false } so the caller knows whether to
// schedule the next tick at 0ms (had something to do) or the idle retry
// delay (nothing to do, don't busy-loop).

const { auditLog } = require('../core/auditLogger');
const { isEventPast, isEventTooSoon, parseEventDate, compareByEventDate } = require('../core/dateUtils');
const { sanitizeEventFields } = require('../core/sanitize');
const { determineCategory } = require('./category');
const { hasValidImage, hasDataQualityWarnings } = require('./gates');
const { hasBeenPostedToChannel } = require('./reconcile');
// Note: do NOT import postEventToCategory directly from './post'.
// bot.postEventToCategory is wrapped by extensions/index.js (attachPostHooks)
// so every successful live post also fires the sequenced dedupe-then-publish
// flow. Importing the raw function bypasses the wrap — autopublish, undo's
// recent-post registry, and any future post-hooks would silently never run
// for autoposted items. Always route through bot.postEventToCategory.
const {
    TARGET_TIMEZONE,
    AUTOPOST_LIVE_WINDOW_START_HOUR,
    AUTOPOST_LIVE_WINDOW_END_HOUR,
    AUTOPOST_NIGHT_BLOCK_LOG_THROTTLE_MS,
    AUTOPOST_IDLE_RETRY_MS,
    AUTOPOST_IDLE_LOG_THROTTLE_MS,
    DEFAULT_AUTOPOST_MIN_LEAD_DAYS
} = require('../config/constants');
const { DateTime } = require('luxon');

const ITEM_TYPES = ['events', 'jobs', 'scholarships'];
const MODES = ['test', 'live'];

function getItemTypes() { return ITEM_TYPES; }
function getModes() { return MODES; }

// True if the event belongs to the requested track.
//   'events'      -> items with no itemType marker
//   'jobs'        -> items with itemType === 'job'
//   'scholarships' -> items with itemType === 'scholarship'
function matchesAutopostItemType(event, itemType) {
    if (!event) return false;
    if (itemType === 'jobs') return event.itemType === 'job';
    if (itemType === 'scholarships') return event.itemType === 'scholarship';
    return !event.itemType;
}

function formatAutopostInterval(minutes) {
    return minutes === 0 ? 'instantly (back-to-back)' : `every ${minutes}m`;
}

// Lead-time gate. Overridable via cache.settings.autopostMinLeadDays.
function getAutopostMinLeadDays(bot) {
    const configured = bot.cache.settings.autopostMinLeadDays;
    return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_AUTOPOST_MIN_LEAD_DAYS;
}

// Live-autopost time window (6 AM - 10 PM NPT). Live posts ping roles, so
// they must not go out at 3 AM. Test autopost is exempt.
function isWithinLiveAutopostWindow() {
    const hour = DateTime.now().setZone(TARGET_TIMEZONE).hour;
    return hour >= AUTOPOST_LIVE_WINDOW_START_HOUR && hour < AUTOPOST_LIVE_WINDOW_END_HOUR;
}

// Throttled log: "holding off, it's nighttime" so the logs channel isn't
// spammed with one message per live tick overnight.
async function logAutopostNightBlockThrottled(bot, itemType) {
    const now = Date.now();
    const state = bot.autopostNightBlockLogState[itemType] || (bot.autopostNightBlockLogState[itemType] = { live: 0 });
    if (now - (state.live || 0) >= AUTOPOST_NIGHT_BLOCK_LOG_THROTTLE_MS) {
        state.live = now;
        await bot.sendLogMessage(
            `🌙 Autopost (${itemType}/live): holding off — outside the ${AUTOPOST_LIVE_WINDOW_START_HOUR} AM–${AUTOPOST_LIVE_WINDOW_END_HOUR - 12} PM Nepal-time posting window.`
        );
    }
}

// Throttled console log: "nothing eligible to post this tick". Real posts
// still fire instantly; this only quiets the idle case at interval=0.
function logAutopostIdleThrottled(bot, itemType, mode) {
    const now = Date.now();
    const state = bot.autopostIdleLogState[itemType] || (bot.autopostIdleLogState[itemType] = { test: 0, live: 0 });
    const last = state[mode] || 0;
    if (now - last >= AUTOPOST_IDLE_LOG_THROTTLE_MS) {
        state[mode] = now;
        console.log(`ℹ️ Autopost (${itemType}/${mode}): nothing eligible to post (idle — throttled to once per ${AUTOPOST_IDLE_LOG_THROTTLE_MS / 60000}m).`);
    }
}

// Persist current active/interval state to cache. Called on every state
// change so a crash never loses "these tracks were running."
function persistAutopostState(bot) {
    const snap = (t) => ({
        test: { active: bot.autopostConfig[t].test.active, intervalMinutes: bot.autopostConfig[t].test.intervalMinutes },
        live: { active: bot.autopostConfig[t].live.active, intervalMinutes: bot.autopostConfig[t].live.intervalMinutes }
    });
    bot.cache.settings.autopostConfigSnapshot = {
        events: snap('events'),
        jobs: snap('jobs'),
        scholarships: snap('scholarships')
    };
    bot.saveCache();
}

// Start (or restart) a track. Clears any existing timer for that
// (itemType, mode) before installing the new one.
//
// options.respectLastPostAt = true means "this is a resume-after-restart,
// respect how much of the interval has already elapsed." Manual
// /autopost start does NOT set this — it posts right away.
function startAutopost(bot, itemType, mode, intervalMinutes = 60, options = {}) {
    const { respectLastPostAt = false } = options;

    stopAutopost(bot, itemType, mode);   // housekeeping only — not a deliberate stop

    bot.cache.settings.autopostDeliberateStop = bot.cache.settings.autopostDeliberateStop || {};
    bot.cache.settings.autopostDeliberateStop[itemType] = bot.cache.settings.autopostDeliberateStop[itemType] || {};
    bot.cache.settings.autopostDeliberateStop[itemType][mode] = false;

    bot.autopostConfig[itemType][mode] = { active: true, intervalMinutes };
    persistAutopostState(bot);

    const tick = async () => {
        if (!bot.autopostConfig[itemType][mode].active) return;
        let tickResult = { posted: false };
        try {
            tickResult = (await runAutopostTick(bot, itemType, mode)) || { posted: false };
        } catch (error) {
            console.error(`❌ Autopost (${itemType}/${mode}) tick failed:`, error);
            await bot.sendLogMessage(`❌ Autopost (${itemType}/${mode}) tick failed: ${error.message}`);
        }
        if (bot.autopostConfig[itemType][mode].active) {
            const configuredMs = bot.autopostConfig[itemType][mode].intervalMinutes > 0
                ? bot.autopostConfig[itemType][mode].intervalMinutes * 60 * 1000
                : 0;
            const delayMs = (configuredMs === 0 && !tickResult.posted) ? AUTOPOST_IDLE_RETRY_MS : configuredMs;
            bot.autopostTimers[itemType][mode] = setTimeout(tick, delayMs);
            if (bot.autopostTimers[itemType][mode].unref) bot.autopostTimers[itemType][mode].unref();
        }
    };

    // First-tick delay. Manual start posts immediately; restart-resume
    // waits out the remainder of the interval.
    let initialDelay = 0;
    if (respectLastPostAt) {
        const lastPostAt = (bot.autopostLastPostAt[itemType] || {})[mode] || 0;
        const configuredMs = intervalMinutes > 0 ? intervalMinutes * 60 * 1000 : 0;
        if (configuredMs > 0 && lastPostAt > 0) {
            const elapsed = Date.now() - lastPostAt;
            initialDelay = Math.max(0, configuredMs - elapsed);
        }
    }

    if (initialDelay > 0) {
        console.log(`⏳ Autopost (${itemType}/${mode}) resumed after restart — last post was ${Math.round((Date.now() - bot.autopostLastPostAt[itemType][mode]) / 1000)}s ago, delaying first tick by ${Math.round(initialDelay / 1000)}s to respect the ${intervalMinutes}m interval.`);
        bot.autopostTimers[itemType][mode] = setTimeout(tick, initialDelay);
        if (bot.autopostTimers[itemType][mode].unref) bot.autopostTimers[itemType][mode].unref();
    } else {
        tick();
    }
}

// Stop a track (does NOT record this as deliberate — that's the caller's
// job if the stop is intentional).
function stopAutopost(bot, itemType, mode) {
    if (bot.autopostTimers[itemType][mode]) {
        clearTimeout(bot.autopostTimers[itemType][mode]);
        bot.autopostTimers[itemType][mode] = null;
    }
    if (bot.autopostConfig[itemType][mode]) {
        bot.autopostConfig[itemType][mode].active = false;
    }
    persistAutopostState(bot);
}

// Stop a track AND record it as deliberate so a restart does not resume
// it. Only call from a human/explicit-stop path (/autopost stop,
// /shutdown, SIGTERM handler).
function stopAutopostDeliberately(bot, itemType, mode) {
    bot.cache.settings.autopostDeliberateStop = bot.cache.settings.autopostDeliberateStop || {};
    bot.cache.settings.autopostDeliberateStop[itemType] = bot.cache.settings.autopostDeliberateStop[itemType] || {};
    bot.cache.settings.autopostDeliberateStop[itemType][mode] = true;
    stopAutopost(bot, itemType, mode);
    bot.flushCacheSync();
}

function setAutopostInterval(bot, itemType, mode, intervalMinutes) {
    const wasActive = bot.autopostConfig[itemType][mode].active;
    if (wasActive) {
        startAutopost(bot, itemType, mode, intervalMinutes);
    } else {
        bot.autopostConfig[itemType][mode].intervalMinutes = intervalMinutes;
        persistAutopostState(bot);
    }
}

// On boot, restore any tracks that were active before the crash, but skip
// tracks that were deliberately stopped.
async function resumeOrWarnAutopostAfterRestart(bot) {
    const snapshot = bot.cache.settings.autopostConfigSnapshot;
    if (!snapshot) return;

    const deliberateStop = bot.cache.settings.autopostDeliberateStop || {};
    const resumed = [];
    const respectedStops = [];

    for (const itemType of ITEM_TYPES) {
        const track = snapshot[itemType];
        if (!track) continue;
        deliberateStop[itemType] = deliberateStop[itemType] || {};

        for (const mode of MODES) {
            const modeSnapshot = track[mode];
            if (!modeSnapshot || !modeSnapshot.active) continue;

            if (deliberateStop[itemType][mode]) {
                respectedStops.push(`${itemType}/${mode}`);
                deliberateStop[itemType][mode] = false;
                continue;
            }
            resumed.push({ itemType, mode, intervalMinutes: modeSnapshot.intervalMinutes });
        }
    }

    bot.cache.settings.autopostDeliberateStop = deliberateStop;

    if (resumed.length > 0) {
        for (const { itemType, mode, intervalMinutes } of resumed) {
            startAutopost(bot, itemType, mode, intervalMinutes, { respectLastPostAt: true });
        }
        const summary = resumed.map((r) => `${r.itemType}/${r.mode} (every ${r.intervalMinutes}m)`).join(', ');
        await bot.sendLogMessage(
            `♻️ Autopost was active before an unexpected restart — resumed: **${summary}**. Use \`/autopost stop\` if this wasn't intended.`
        );
        auditLog('autopost_restart_resume', `Auto-resumed autopost after restart`, { resumed, respectedStops }, 'warn');
    }

    if (respectedStops.length > 0) {
        await bot.sendLogMessage(`ℹ️ Autopost (**${respectedStops.join(', ')}**) was deliberately stopped before the last restart — correctly NOT resumed.`);
    }

    persistAutopostState(bot);
}

// Mutex wrapper.
function runAutopostTick(bot, itemType, mode) {
    return bot.cacheMutex.runExclusive(() => _runAutopostTickLocked(bot, itemType, mode));
}

// One tick: find the oldest eligible pending item for this track, post
// it, and return { posted: true | false }.
async function _runAutopostTickLocked(bot, itemType, mode) {
    const channelMode = mode === 'live' ? 'main' : 'test';

    // Live night-time gate
    if (mode === 'live' && !isWithinLiveAutopostWindow()) {
        await logAutopostNightBlockThrottled(bot, itemType);
        return { posted: false };
    }

    const allPending = bot.cache.pendingEvents.filter((e) => matchesAutopostItemType(e, itemType));

    // Past filter — with audit-log why.
    const afterPastFilter = [];
    for (const e of allPending) {
        if (isEventPast(e)) {
            const dateObj = parseEventDate(e);
            auditLog('autopost_filter_skip', `Autopost (${itemType}/${mode}): "${e.title}" removed by past-filter`, {
                mode, eventId: e.id || null, title: e.title || null, filter: 'past_filter',
                dateField: e.date || e.startDate || null, resolvedDate: dateObj ? dateObj.toISOString() : null
            }, 'warn');
        } else {
            afterPastFilter.push(e);
        }
    }

    // Too-soon filter
    const afterTooSoon = [];
    const minLeadDays = getAutopostMinLeadDays(bot);
    for (const e of afterPastFilter) {
        if (isEventTooSoon(e, minLeadDays)) {
            const dateObj = parseEventDate(e);
            const msUntil = dateObj ? dateObj.getTime() - Date.now() : null;
            auditLog('autopost_filter_skip', `Autopost (${itemType}/${mode}): "${e.title}" removed by too-soon-filter`, {
                mode, eventId: e.id || null, title: e.title || null, filter: 'too_soon_filter',
                dateField: e.date || e.startDate || null, resolvedDate: dateObj ? dateObj.toISOString() : null,
                autopostMinLeadDays: minLeadDays, msUntil
            }, 'warn');
        } else {
            afterTooSoon.push(e);
        }
    }

    // Image filter (live only — scholarships exempt via hasValidImage)
    const afterImage = [];
    for (const e of afterTooSoon) {
        if (channelMode === 'main' && !hasValidImage(bot, e)) {
            auditLog('autopost_filter_skip', `Autopost (${itemType}/${mode}): "${e.title}" removed by has-image filter`, {
                mode, eventId: e.id || null, title: e.title || null, filter: 'has_image_filter', imageField: e.image || null
            }, 'warn');
        } else {
            afterImage.push(e);
        }
    }

    const candidates = afterImage.sort((a, b) => compareByEventDate(a, b));

    // Walk candidates in date order; post the first that survives gates.
    for (const event of candidates) {
        sanitizeEventFields(event);

        if (hasDataQualityWarnings(event)) {
            continue;
        }

        const categoryKey = determineCategory(event);
        const category = bot.CATEGORIES[categoryKey];
        const channelId = channelMode === 'main' ? category?.main : category?.test;
        if (!channelId) continue;

        if (await hasBeenPostedToChannel(bot, event, channelId)) continue;

        const result = await bot.postEventToCategory(event, channelMode, categoryKey);
        if (result.ok) {
            if (mode === 'test') {
                const pendingEvent = bot.cache.pendingEvents.find((e) => e.id === event.id);
                if (pendingEvent) {
                    pendingEvent.testPosted = true;
                    pendingEvent.testPostedAt = Date.now();
                    bot.saveCache();
                }
            } else {
                bot.removeFromPending(event.id);
                bot.markEventPosted(event);
                bot.saveCache();
            }
            bot.autopostLastPostAt[itemType] = bot.autopostLastPostAt[itemType] || {};
            bot.autopostLastPostAt[itemType][mode] = Date.now();
            bot.cache.settings.autopostLastPostAt = bot.autopostLastPostAt;
            bot.saveCache();

            await bot.sendLogMessage(`🤖 Autopost (${itemType}/${mode}): posted "${event.title}" to **${categoryKey}**.`);
            return { posted: true };
        }

        await bot.sendLogMessage(`🤖 Autopost (${itemType}/${mode}): skipped "${event.title}" (${result.reason}).`);
    }

    logAutopostIdleThrottled(bot, itemType, mode);
    return { posted: false };
}

module.exports = {
    ITEM_TYPES,
    MODES,
    getItemTypes,
    getModes,
    matchesAutopostItemType,
    formatAutopostInterval,
    getAutopostMinLeadDays,
    isWithinLiveAutopostWindow,
    logAutopostNightBlockThrottled,
    logAutopostIdleThrottled,
    persistAutopostState,
    startAutopost,
    stopAutopost,
    stopAutopostDeliberately,
    setAutopostInterval,
    resumeOrWarnAutopostAfterRestart,
    runAutopostTick
};
