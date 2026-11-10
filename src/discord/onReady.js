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

const { auditLog, registerDiscordAuditChannel } = require('../core/auditLogger');
const env = require('../config/env');
const { startWebServer } = require('../web/server');

async function onReady(bot) {
    try {
        registerDiscordAuditChannel(bot.client, env.AUDIT_LOG_CHANNEL_ID);

        try {
            await require('./commands/registerSlashCommands').registerSlashCommands(bot);
        } catch (error) {
            console.error('❌ Failed to register slash commands:', error.message);
            auditLog('ready_step_failed', 'Slash command registration failed', {
                errorMessage: error.message, errorStack: error.stack
            }, 'error');
        }

        try {
            bot.scheduleAutomaticScraping();
        } catch (error) {
            console.error('❌ Failed to schedule scraping:', error.message);
        }

        try {
            bot.scheduleConsistencyCheck();
        } catch (error) {
            console.error('❌ Failed to schedule consistency check:', error.message);
        }

        try {
            bot.scheduleMissedScrapeCheck();
        } catch (error) {
            console.error('❌ Failed to schedule missed-scrape check:', error.message);
        }

        try {
            await bot.checkForMissedScrapeAndCatchUp();
        } catch (error) {
            console.error('❌ Missed-scrape catch-up failed:', error.message);
        }

        try {
            await bot.resumeOrWarnAutopostAfterRestart();
        } catch (error) {
            console.error('❌ Failed to resume/check autopost state:', error.message);
        }

        try {
            const reconciled = bot.reconcilePendingAgainstMarkers();
            if (reconciled > 0) {
                console.log(`🔧 Startup reconciliation: moved ${reconciled} event(s) from pending — already confirmed-posted on disk.`);
            }
        } catch (error) {
            console.error('❌ Startup reconciliation failed:', error.message);
        }

        try {
            startWebServer(bot);
        } catch (error) {
            console.error('❌ Failed to start web server:', error.message);
        }

        console.log('✅ Ready handler completed all startup steps.');
    } catch (error) {
        console.error('❌ Unhandled error in ready handler:', error);
        auditLog('ready_handler_error', 'Unhandled error in onReady', {
            errorMessage: error.message, errorStack: error.stack
        }, 'error');
    }
}

module.exports = { onReady };
