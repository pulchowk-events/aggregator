// src/discord/onReady.js
// What runs once the bot has authenticated with Discord.
//
// Order matters — this runs BEFORE any command is invokable, so the
// bot's state must be correct by the time this returns. In sequence:
//
//   1. Register the audit channel (so all subsequent audit calls reach
//      Discord as well as the local file).
//   2. Register slash commands (guild-scoped to HOME_GUILD_ID — see
//      registerSlashCommands below for why not global).
//   3. Schedule cron: scraping, missed-scrape safety net, consistency sweep.
//   4. Kick off the missed-scrape catch-up check (in case the process was
//      off when a slot should have fired).
//   5. Resume or warn on autopost tracks (crash vs. deliberate-stop).
//   6. Run startup reconciliation of cache against markers.
//   7. Start the express dashboard.
//
// Every step is independent — a failure in one is logged but does NOT
// prevent the rest from running. This is deliberate: even if e.g. slash
// command registration fails, the bot should still scrape and post.
//
// Output format: matches the batch pipeline's style — banner at top,
// one line per step as it completes (✓/✗), plain-English detail, one
// summary line at the bottom. Same visual language as `batch verify`,
// `scrapeAll`, `postEventToCategory`.

const { auditLog, registerDiscordAuditChannel } = require('../core/auditLogger');
const env = require('../config/env');
const { startWebServer } = require('../web/server');
const ui = require('../core/ui');

async function onReady(bot) {
    ui.banner({
        title: 'Startup',
        sub: `guild ${env.HOME_GUILD_ID || '(unset)'} · dashboard :${env.WEB_PORT || 3001}`
    });

    const failures = [];

    // Run one step, print one line. Never throws — the try/catch here is
    // the per-step fault tolerance the original code had inline.
    const step = async (label, fn) => {
        try {
            const detail = await fn();
            const detailStr = detail ? `  ${ui.colors.GRAY}${detail}${ui.colors.R}` : '';
            ui.line(`  ${ui.colors.GREEN}✓${ui.colors.R}  ${label}${detailStr}`);
        } catch (error) {
            ui.line(`  ${ui.colors.RED}✗${ui.colors.R}  ${label}  ${ui.colors.GRAY}${error.message}${ui.colors.R}`);
            failures.push({ label, error });
            auditLog('ready_step_failed', `${label} failed`, {
                errorMessage: error.message,
                errorStack: error.stack
            }, 'error');
        }
    };

    await step('audit channel registered', async () => {
        registerDiscordAuditChannel(bot.client, env.AUDIT_LOG_CHANNEL_ID);
        return env.AUDIT_LOG_CHANNEL_ID ? 'discord mirror enabled' : 'console-only (no AUDIT_LOG_CHANNEL_ID)';
    });

    await step('slash commands registered', async () => {
        await require('./commands/registerSlashCommands').registerSlashCommands(bot);
        return 'guild-scoped';
    });

    await step('scrape cron scheduled', async () => {
        bot.scheduleAutomaticScraping();
        const expr = bot.activeScrapeCron;
        return expr ? `"${expr}"` : 'scheduled';
    });

    await step('consistency check scheduled', async () => {
        bot.scheduleConsistencyCheck();
        return 'daily 3 AM';
    });

    await step('missed-scrape check scheduled', async () => {
        bot.scheduleMissedScrapeCheck();
        return 'every 15 min';
    });

    await step('missed-scrape catch-up', async () => {
        // May trigger a full scrape inline — if it does, the scrape
        // banner appears between this line and the next. That's fine;
        // the visual sections stay distinct.
        await bot.checkForMissedScrapeAndCatchUp();
        return 'checked';
    });

    await step('autopost resume check', async () => {
        await bot.resumeOrWarnAutopostAfterRestart();
        return 'checked';
    });

    await step('cache/marker reconciliation', async () => {
        const reconciled = bot.reconcilePendingAgainstMarkers();
        return reconciled > 0 ? `moved ${reconciled} item(s) from pending` : 'clean';
    });

    await step('dashboard API', async () => {
        startWebServer(bot);
        return `http://localhost:${env.WEB_PORT || 3001}`;
    });

    ui.blank();
    if (failures.length === 0) {
        ui.line(`  ${ui.colors.GREEN}✓${ui.colors.R}  ready · bot online`);
    } else {
        ui.line(`  ${ui.tag('warn')}  ready with ${failures.length} failure(s) — see audit-log for details`);
    }
    ui.blank();

    // Preserved marker line. Docs and boot-test greps look for this
    // string verbatim; do not change without updating the docs.
    console.log('✅ Ready handler completed all startup steps.');
}

module.exports = { onReady };