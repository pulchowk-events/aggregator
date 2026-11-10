// /status — health, queue counts, autopost state, next scrape, missed-cycle
// indicator, and every configurable window.
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

const definition = new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show bot health and scraping status');

async function handle(bot, interaction) {
    const nextScrape = bot.getNextScrapeTime();
    const lastScheduledRun = bot.getLastScheduledScrapeTime();
    const missedCycle = bot.wasLastScrapeCycleMissed();

    const embed = new EmbedBuilder()
        .setTitle('Bot Status')
        .addFields(
            { name: 'Pending events', value: String(bot.cache.pendingEvents.length), inline: true },
            { name: 'Posted events', value: String(bot.cache.postedEvents.length), inline: true },
            { name: 'Skipped events', value: String(bot.cache.skippedEvents.length), inline: true },
            { name: 'Expired (archived)', value: String((bot.cache.expiredEvents || []).length), inline: true },
            { name: 'Needs-attention (archived)', value: String((bot.cache.needsAttentionExpiredEvents || []).length), inline: true },
            { name: 'Currently scraping', value: bot.isScraping ? 'Yes' : 'No', inline: true },
            { name: 'In-flight posts', value: String(bot.postingLocks.size), inline: true },
            { name: '📅 Autopost Events', value: `${bot.autopostConfig.events.test.active ? '🟢' : '⚪'} / ${bot.autopostConfig.events.live.active ? '🟢' : '⚪'}`, inline: true },
            { name: '💼 Autopost Jobs', value: `${bot.autopostConfig.jobs.test.active ? '🟢' : '⚪'} / ${bot.autopostConfig.jobs.live.active ? '🟢' : '⚪'}`, inline: true },
            { name: '🎓 Autopost Scholarships', value: `${bot.autopostConfig.scholarships.test.active ? '🟢' : '⚪'} / ${bot.autopostConfig.scholarships.live.active ? '🟢' : '⚪'}`, inline: true },
            { name: 'Global ping', value: bot.cache.settings.pingEnabled === false ? '🔕 off' : '🔔 on', inline: true },
            { name: 'Category pings off', value: Object.entries(bot.cache.settings.categoryPingEnabled || {}).filter(([, v]) => v === false).map(([k]) => k).join(', ') || 'none', inline: true },
            { name: 'Autopost min lead time', value: `${bot.getAutopostMinLeadDays()} day(s)`, inline: true },
            { name: 'Needs-attention expiry', value: `${bot.getNeedsAttentionExpiryDays()} day(s)`, inline: true },
            { name: 'Last scrape', value: bot.cache.lastCheck ? `<t:${Math.floor(bot.cache.lastCheck / 1000)}:R>` : 'Never', inline: true },
            { name: 'Next scrape', value: nextScrape ? `<t:${Math.floor(nextScrape.getTime() / 1000)}:R>` : 'Unknown', inline: true },
            { name: 'Last scheduled run', value: lastScheduledRun ? `<t:${Math.floor(lastScheduledRun.getTime() / 1000)}:R>` : 'Unknown', inline: true },
            { name: 'Missed last cycle?', value: missedCycle ? '⚠️ Yes — catch-up pending/running' : '✅ No', inline: true },
            { name: 'Missed-scrape catch-up', value: bot.isMissedScrapeCatchupEnabled() ? '🟢 on (checked every 15m)' : '⚪ off', inline: true },
            { name: 'Schedule', value: `\`${bot.activeScrapeCron || '0 */6 * * *'}\``, inline: true }
        )
        .setColor(0x00AE86);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

module.exports = { definition, handle };
