// /scrape — manual scrape of one source or all.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
// Source names are validated against the plugin registry at call time (no 25-choice cap).

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
        .setDescription('Source name (type to search; leave empty for all)')
        .setRequired(false)
        .setAutocomplete(true));

async function handle(bot, interaction) {
    if (bot.isScraping) {
        return interaction.reply({ content: '⏳ A scrape is already in progress. Please wait for it to finish.', flags: MessageFlags.Ephemeral });
    }
    const rawSite = (interaction.options.getString('site') || 'all').trim();
    let site = 'all';
    if (rawSite && rawSite.toLowerCase() !== 'all') {
        const match = require('../../scrapers/registry').getAllSources()
            .find((p) => p.name.toLowerCase() === rawSite.toLowerCase());
        if (!match) {
            return interaction.reply({ content: 'Unknown source: ' + rawSite.slice(0, 50) + '. Use a source file name, e.g. blacktech.', flags: MessageFlags.Ephemeral });
        }
        site = match.name;
    }
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

// Autocomplete: case-insensitive substring match on source name, prefix
// matches first, hard-capped at 25 (Discord limit). Empty query gets an
// 'All Sites' entry on top.
function siteChoices(query, sources) {
    const q = String(query || '').trim().toLowerCase();
    const seen = new Set();
    const hits = [];
    for (const p of (sources || [])) {
        if (!p || !p.name || seen.has(p.name)) continue;
        if (q && !p.name.toLowerCase().includes(q)) continue;
        seen.add(p.name);
        hits.push(p);
    }
    hits.sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return (ap - bp) || a.name.localeCompare(b.name);
    });
    const out = [];
    if (!q) out.push({ name: 'All Sites', value: 'all' });
    for (const p of hits) {
        out.push({ name: (p.name + ' (' + p.type + ')').slice(0, 100), value: p.name.slice(0, 100) });
    }
    return out.slice(0, 25);
}

// Autocomplete can only respond with choices -- never text.
async function autocomplete(bot, interaction) {
    let choices = [];
    try {
        const focused = interaction.options.getFocused(true);
        if (focused && focused.name === 'site') {
            choices = siteChoices(focused.value, require('../../scrapers/registry').getAllSources());
        }
    } catch (e) { choices = []; }
    try { await interaction.respond(choices); } catch (e) { /* expired */ }
}

module.exports = { definition, handle, autocomplete, siteChoices };
