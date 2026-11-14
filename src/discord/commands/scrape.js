// /scrape — manual scrape of one source or all.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { EVENT_SOURCES, JOB_SOURCES, SCHOLARSHIP_SOURCES } = require('../../config/constants');

const definition = new SlashCommandBuilder()
    .setName('scrape')
    .setDescription('Manually trigger event/job/scholarship scraping')
    .addStringOption((option) => option
        .setName('type')
        .setDescription('Restrict to one item type (leave empty for all)')
        .setRequired(false)
        .addChoices(
            { name: 'All Types', value: 'all' },
            { name: 'Events', value: 'events' },
            { name: 'Jobs', value: 'jobs' },
            { name: 'Scholarships', value: 'scholarships' }
        ))
    .addStringOption((option) => option
        .setName('site')
        .setDescription('Which site to scrape (leave empty for all)')
        .setRequired(false)
        .addChoices(
            { name: 'All Sites', value: 'all' },
            ...EVENT_SOURCES.map((s) => ({ name: s, value: s })),
            ...JOB_SOURCES.map((s) => ({ name: `${s} (jobs)`, value: s })),
            ...SCHOLARSHIP_SOURCES.map((s) => ({ name: `${s} (scholarships)`, value: s }))
        ));

async function handle(bot, interaction) {
    if (bot.isScraping) {
        return interaction.reply({ content: '⏳ A scrape is already in progress. Please wait for it to finish.', flags: MessageFlags.Ephemeral });
    }
    const site = interaction.options.getString('site') || 'all';
    const type = interaction.options.getString('type') || 'all';
    const scopeLabel = (type && type !== 'all') ? `${site} (${type} only)` : site;
    await interaction.reply({ content: `🔄 Starting manual scrape for **${scopeLabel}**...`, flags: MessageFlags.Ephemeral });
    try {
        const summary = await require('../scrapeAndNotify').scrapeAndNotify(bot, site, type);
        try {
            await interaction.editReply({ content: `✅ Scrape completed for **${scopeLabel}**. Found ${summary.newEvents} new item(s), ${summary.errors} error(s). Check the logs channel for details.` });
        } catch (editError) {
            console.warn('⚠️ Could not update the /scrape reply (likely expired) — result was still logged to the logs channel.');
        }
    } catch (error) {
        console.error('❌ Manual scrape failed:', error);
        try { await interaction.editReply({ content: `❌ Scrape failed: ${error.message}` }); } catch (e) { /* expired */ }
    }
}

module.exports = { definition, handle };
