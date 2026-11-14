// src/discord/scrapeAndNotify.js
// Manual / cron scrape entry point. Runs scrapeAll under the cache
// mutex, renders a live progress bar to the logs channel, and pipes the
// result through pipeline.processScrapedEvents.
//
// Two modes of use:
//   - programmatic: bot.scrapeAndNotify('all') — called by the cron, the
//     missed-scrape catch-up, and /scrape
//   - interactive: /scrape also reads the return value to send a
//     summary reply to the invoking user
//
// Progress message update cadence: 4 s. On completion, always updates one
// last time with done=true (100% / 0 ETA). If logs channel isn't
// configured, silently skips (progress is nice-to-have, not critical).

const { scrapeAll } = require('../scrapers/scrapeAll');
const { auditLog } = require('../core/auditLogger');

const PROGRESS_UPDATE_INTERVAL_MS = 4000;

async function scrapeAndNotify(bot, site = 'all', type = null) {
    if (bot.isScraping) {
        console.warn('⚠️ scrapeAndNotify called while a scrape is already running — skipping.');
        return { newEvents: 0, errors: 0, skipped: true };
    }

    bot.isScraping = true;
    try {
        const purgedCount = await bot.cacheMutex.runExclusive(() => bot.purgeExpiredPendingEvents());
        if (purgedCount > 0) console.log(`🧹 Purged ${purgedCount} expired event(s) from pending.`);

        console.log(`🔄 Running scrape for ${site}...`);

        // Report discovered sources up-front so the progress bar has a
        // sensible total from the first tick.
        bot.scrapeProgress.start([site]);

        const progressMessage = await startProgressMessage(bot);
        const progressInterval = setInterval(
            () => updateProgressMessage(bot, progressMessage).catch(() => {}),
            PROGRESS_UPDATE_INTERVAL_MS
        );

        let result;
        try {
            result = await scrapeAll(bot, { sites: site, type, progress: bot.scrapeProgress });
        } finally {
            clearInterval(progressInterval);
            await updateProgressMessage(bot, progressMessage, true);
        }

        if (result.errors.length > 0) {
            await bot.sendLogMessage(`⚠️ Scraping errors: ${result.errors.join(', ')}`);
        }

        return await bot.cacheMutex.runExclusive(async () => {
            const processed = bot._processScrapedEventsLocked(result.items, result.errors);

            // Nothing new — send a summary and bail.
            if (processed.newEvents === 0) {
                const nextScrape = bot.getNextScrapeTime();
                const nextNote = nextScrape ? `\n⏭️ Next scrape: <t:${Math.floor(nextScrape.getTime() / 1000)}:R>` : '';
                const summary = (result.items.length === 0 && result.errors.length > 0)
                    ? `⚠️ Scrape produced no items — all sources errored.${nextNote}`
                    : `✅ No new items found. Total scraped: ${result.items.length}.${nextNote}`;
                await bot.sendLogMessage(summary);
                return { newEvents: 0, errors: result.errors.length, items: [] };
            }

            const flaggedNote = processed.flaggedCount > 0
                ? ` (⚠️ ${processed.flaggedCount} flagged for manual review)`
                : '';
            const nextScrape = bot.getNextScrapeTime();
            const nextNote = nextScrape ? `\n⏭️ Next scrape: <t:${Math.floor(nextScrape.getTime() / 1000)}:R>` : '';
            await bot.sendLogMessage(`📢 Found ${processed.newEvents} new item(s)${flaggedNote}. Use /pending to review.${nextNote}`);

            // Post pending embeds into the logs channel for quick review.
            if (bot.cache.settings.logsChannelId) {
                try {
                    const logsChannel = await bot.client.channels.fetch(bot.cache.settings.logsChannelId);
                    await require('./sendPendingEventsMessage').sendPendingEventsMessage(bot, logsChannel, processed.newEventsArray);
                } catch (error) {
                    console.error('❌ Failed to post pending items to logs channel:', error);
                }
            }

            return { newEvents: processed.newEvents, errors: result.errors.length, items: processed.newEventsArray };
        });
    } finally {
        bot.isScraping = false;
    }
}

async function startProgressMessage(bot) {
    if (!bot.cache.settings.logsChannelId) return null;
    try {
        const channel = await bot.client.channels.fetch(bot.cache.settings.logsChannelId);
        return await channel.send(formatProgressContent(bot, false));
    } catch (e) {
        console.warn('⚠️ Could not send scrape progress message:', e.message);
        return null;
    }
}

function formatProgressContent(bot, done = false) {
    const p = bot.scrapeProgress;
    const bar = p.renderBar(20);
    const pct = done ? 100 : p.percent();
    const eta = done ? 0 : p.etaSeconds();
    const etaText = eta === null ? 'calculating…' : `${eta}s`;
    const prefix = done ? '✅ Scrape finished' : '🔄 Scraping';
    return `${prefix}: \`${bar}\` ${pct}%  •  ETA: ${etaText}  •  ${p.completed}/${p.total || '?'} items  •  ${p.elapsedSeconds()}s elapsed`;
}

async function updateProgressMessage(bot, message, done = false) {
    if (!message) return;
    try {
        await message.edit(formatProgressContent(bot, done));
    } catch (e) {
        // Best-effort — a failed edit (message deleted, rate limit) should
        // never interrupt the actual scrape.
    }
}

module.exports = { scrapeAndNotify };
