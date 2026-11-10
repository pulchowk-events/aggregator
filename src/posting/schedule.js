// src/posting/schedule.js
// Cron-driven scrape scheduler and missed-scrape catch-up.
//
// Two responsibilities:
//
//   1. FIRE scrapes on a cron schedule. The cron expression is
//      cache.settings.scrapeCron if set, otherwise SCRAPE_CRON from env,
//      otherwise DEFAULT_SCRAPE_CRON (6-hourly). Whichever wins is stored
//      on bot.activeScrapeCron so /status can report it.
//
//   2. DETECT missed cycles and catch up. A cron slot can be missed
//      because the machine was off, the container was paused, or the
//      process crashed. On the next boot AND on a 15-minute safety net,
//      we ask: "should the cron have fired since the last successful
//      scrape?" If yes, run one scrape immediately to catch up. The cron
//      itself does NOT shift — the next scheduled fire is unchanged.
//
// Both /scrape (manual) and the cron and the catch-up all route through
// the SAME scrapeAndNotify method on bot, so behavior is identical.

const cron = require('node-cron');
const { auditLog } = require('../core/auditLogger');
const { getNextCronRun, getPreviousCronRun } = require('../core/cronParser');
const {
    SCRAPE_CRON,
    DEFAULT_SCRAPE_CRON,
    MISSED_SCRAPE_LOG_THROTTLE_MS
} = require('../config/constants');

const MISSED_SCRAPE_CHECK_CRON = '*/15 * * * *';

// ---------- Scrape cron ----------

function scheduleAutomaticScraping(bot) {
    if (bot.cronTask) bot.cronTask.stop();
    const cronExpr = bot.cache.settings.scrapeCron || SCRAPE_CRON || DEFAULT_SCRAPE_CRON;
    if (!cron.validate(cronExpr)) {
        console.error(`❌ Invalid scrape cron expression "${cronExpr}" — automatic scraping disabled.`);
        return;
    }
    bot.activeScrapeCron = cronExpr;
    bot.cronTask = cron.schedule(cronExpr, () => {
        console.log('⏰ Running scheduled scrape...');
        bot.scrapeAndNotify('all').catch((err) => console.error('❌ Scheduled scrape failed:', err));
    });
    console.log(`🕒 Automatic scraping scheduled with cron "${cronExpr}"`);
}

// Called when the user runs /settings set-schedule — re-arm the task on
// the new expression. bot.activeScrapeCron is updated immediately so
// /status shows the correct "next run" time without waiting for the next
// scheduled tick.
function rescheduleWithCustomCron(bot, expr) {
    if (bot.cronTask) bot.cronTask.stop();
    bot.activeScrapeCron = expr;
    bot.cronTask = cron.schedule(expr, () => {
        console.log('⏰ Running scheduled scrape...');
        bot.scrapeAndNotify('all').catch((err) => console.error('❌ Scheduled scrape failed:', err));
    });
}

// ---------- Next/previous run ----------

function getNextScrapeTime(bot) {
    return getNextCronRun(bot.activeScrapeCron || SCRAPE_CRON || DEFAULT_SCRAPE_CRON, new Date());
}

function getLastScheduledScrapeTime(bot) {
    return getPreviousCronRun(bot.activeScrapeCron || SCRAPE_CRON || DEFAULT_SCRAPE_CRON, new Date());
}

// True if the last completed scrape (cache.lastCheck) predates the most
// recent scheduled run — i.e. a cycle was missed and hasn't been caught
// up yet.
function wasLastScrapeCycleMissed(bot) {
    const lastScheduledRun = getLastScheduledScrapeTime(bot);
    if (!lastScheduledRun) return false;
    return (bot.cache.lastCheck || 0) < lastScheduledRun.getTime();
}

function isMissedScrapeCatchupEnabled(bot) {
    return bot.cache.settings.missedScrapeCatchupEnabled !== false;   // default: on
}

// ---------- Catch-up ----------

// Runs ONE catch-up scrape if a cycle was missed. Never touches
// bot.activeScrapeCron — the schedule's origin time is unchanged.
//
// Discord log throttled to once per MISSED_SCRAPE_LOG_THROTTLE_MS so a
// failing catch-up (network down, etc.) doesn't re-announce itself every
// 15 minutes. Console logs and audit entries fire on every attempt.
async function checkForMissedScrapeAndCatchUp(bot) {
    if (bot.isScraping) return;
    if (!isMissedScrapeCatchupEnabled(bot)) return;

    const lastScheduledRun = getLastScheduledScrapeTime(bot);
    if (!lastScheduledRun || !wasLastScrapeCycleMissed(bot)) return;

    const cronExpr = bot.activeScrapeCron || SCRAPE_CRON || DEFAULT_SCRAPE_CRON;
    const now = Date.now();
    const shouldLog = (now - (bot.lastMissedScrapeLogAt || 0)) >= MISSED_SCRAPE_LOG_THROTTLE_MS;

    console.log(`⏰ Detected a missed scrape cycle — last completed scrape predates the scheduled run at ${lastScheduledRun.toISOString()}. Running catch-up now; the "${cronExpr}" schedule is unchanged.`);

    auditLog('missed_scrape_catchup',
        `Missed scrape cycle detected — scheduled run was ${lastScheduledRun.toISOString()}, last completed scrape was ${bot.cache.lastCheck ? new Date(bot.cache.lastCheck).toISOString() : 'never'}. Triggering catch-up.`,
        { scheduledRun: lastScheduledRun.toISOString(), lastCheck: bot.cache.lastCheck || null, cronExpr },
        'warn');

    if (shouldLog) {
        bot.lastMissedScrapeLogAt = now;
        await bot.sendLogMessage(
            `⏰ Missed scrape detected — last completed scrape was <t:${Math.floor((bot.cache.lastCheck || 0) / 1000)}:R>, before the scheduled run at <t:${Math.floor(lastScheduledRun.getTime() / 1000)}:f>. Running catch-up now. The regular \`${cronExpr}\` schedule is unaffected.`
        );
    }

    try {
        await bot.scrapeAndNotify('all');
        auditLog('missed_scrape_catchup',
            `Catch-up scrape completed successfully for the missed run scheduled at ${lastScheduledRun.toISOString()}`,
            { scheduledRun: lastScheduledRun.toISOString() });
    } catch (error) {
        console.error('❌ Catch-up scrape failed:', error);
        auditLog('missed_scrape_catchup',
            `Catch-up scrape failed: ${error.message}`,
            { scheduledRun: lastScheduledRun.toISOString(), errorMessage: error.message, errorStack: error.stack },
            'error');
        if (shouldLog) await bot.sendLogMessage(`❌ Catch-up scrape failed: ${error.message}`);
    }
}

// Install the 15-minute safety-net cron. Necessary because a laptop that
// sleeps with the process still alive won't catch up at the next boot —
// the process never restarted.
function scheduleMissedScrapeCheck(bot) {
    if (bot.missedScrapeCheckCronTask) bot.missedScrapeCheckCronTask.stop();
    bot.missedScrapeCheckCronTask = cron.schedule(MISSED_SCRAPE_CHECK_CRON, () => {
        checkForMissedScrapeAndCatchUp(bot).catch((err) => console.error('❌ Missed-scrape catch-up check failed:', err));
    });
    console.log(`⏰ Missed-scrape catch-up check scheduled with cron "${MISSED_SCRAPE_CHECK_CRON}"`);
}

module.exports = {
    MISSED_SCRAPE_CHECK_CRON,
    scheduleAutomaticScraping,
    rescheduleWithCustomCron,
    getNextScrapeTime,
    getLastScheduledScrapeTime,
    wasLastScrapeCycleMissed,
    isMissedScrapeCatchupEnabled,
    checkForMissedScrapeAndCatchUp,
    scheduleMissedScrapeCheck
};
