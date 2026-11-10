// src/integrations/websiteSync/index.js
// Attach point. Wires the engine (engine.js) and commands (commands.js)
// to the bot instance, installs the cache mutation hooks (so a scrape or
// a mark-posted triggers a delayed sync), and starts the cron safety net.

const cron = require('node-cron');
const env = require('../../config/env');
const engine = require('./engine');
const { commands, handleCommand } = require('./commands');

function attachHooks(bot) {
    // Every scrape pipeline run → schedule a sync.
    const origScrape = bot._processScrapedEventsLocked.bind(bot);
    bot._processScrapedEventsLocked = async function patched(events, errors) {
        const result = await origScrape(events, errors);
        engine.scheduleSync(bot, 30000);
        return result;
    };

    // Every remove-from-pending (item left the queue) → schedule.
    const origRemove = bot.removeFromPending.bind(bot);
    bot.removeFromPending = function patched(eventId) {
        const result = origRemove(eventId);
        engine.scheduleSync(bot, 5000);
        return result;
    };

    // Every mark-posted → schedule.
    const origMarkPosted = bot.markEventPosted.bind(bot);
    bot.markEventPosted = function patched(event) {
        const result = origMarkPosted(event);
        engine.scheduleSync(bot, 5000);
        return result;
    };
}

function registerCommands(bot) {
    bot.client.once('ready', async () => {
        try {
            const { REST, Routes } = require('discord.js');
            const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);
            for (const cmd of commands) {
                await rest.post(Routes.applicationCommands(bot.client.user.id), { body: cmd.toJSON() });
            }
            console.log(`✅ [websiteSync] Registered ${commands.length} command(s).`);
        } catch (error) {
            console.error('❌ [websiteSync] Failed to register command:', error);
        }
    });
}

function attach(bot) {
    if (!engine.isEnabled()) {
        console.log('ℹ️ [websiteSync] Disabled via WEBSITE_SYNC_ENABLED=false');
        return;
    }
    if (!engine.isConfigured()) {
        console.warn('⚠️ [websiteSync] WEBSITE_SUPABASE_URL/KEY not set — sync disabled');
        return;
    }

    attachHooks(bot);
    registerCommands(bot);

    bot.client.once('ready', () => {
        setTimeout(() => {
            console.log('🌐 [websiteSync] Startup sync starting (30s after ready)...');
            engine.scheduleSync(bot, 1000);
        }, 30000);

        if (cron.validate(env.WEBSITE_SYNC_CRON || '0 * * * *')) {
            cron.schedule(env.WEBSITE_SYNC_CRON || '0 * * * *', () => engine.scheduleSync(bot, 1000));
            console.log(`🌐 [websiteSync] Cron safety net: ${env.WEBSITE_SYNC_CRON || '0 * * * *'}`);
        } else {
            console.warn(`⚠️ [websiteSync] Invalid cron "${env.WEBSITE_SYNC_CRON}" — cron disabled`);
        }
    });

    bot.websiteSync = {
        isConfigured: engine.isConfigured,
        syncNow: (opts) => engine.syncWebsite(bot, opts),
        health: () => engine.checkWebsiteSyncHealth(bot),
        getMode: () => ({ dryRun: engine.DRY_RUN, eventsTable: engine.WEBSITE_TABLE, jobsTable: engine.JOBS_SYNC_ENABLED ? engine.WEBSITE_JOBS_TABLE : null, enabled: engine.isEnabled() })
    };

    console.log(
        `🌐 [websiteSync] Attached — mode: ${engine.DRY_RUN ? 'DRY-RUN' : 'LIVE'}, ` +
        `events: ${engine.WEBSITE_TABLE}, jobs: ${engine.JOBS_SYNC_ENABLED ? engine.WEBSITE_JOBS_TABLE : 'disabled'}, ` +
        `batch: ${engine.BATCH_SIZE}`
    );
}

// Backward-compat aliases so any older require('./integrations/websiteSync')
// shape still works — commands array, handleCommand, syncWebsite, health,
// isConfigured, getMode.
module.exports = {
    attach,
    commands,
    handleCommand,
    syncWebsite: engine.syncWebsite,
    syncWebsiteEvents: engine.syncWebsite,
    checkWebsiteSyncHealth: engine.checkWebsiteSyncHealth,
    isConfigured: engine.isConfigured,
    getMode: () => ({ dryRun: engine.DRY_RUN, eventsTable: engine.WEBSITE_TABLE, jobsTable: engine.JOBS_SYNC_ENABLED ? engine.WEBSITE_JOBS_TABLE : null, enabled: engine.isEnabled() })
};
