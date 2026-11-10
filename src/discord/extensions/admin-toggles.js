// src/discord/extensions/admin-toggles.js
// Runtime admin toggles that don't have their own command namespace:
//   /category pause|resume|list    — block a category from going LIVE
//   /blacklist add|remove|list     — auto-skip scraped items by keyword/org
//   /autopublish on|off|status     — crosspost new posts after dedupe clears

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { auditLog } = require('../../core/auditLogger');
const env = require('../../config/env');

const CATEGORY_CHOICES = Object.keys(env.CHANNELS).map((k) => ({ name: k, value: k }));

function isCategoryPaused(bot, key) {
    return Boolean((bot.cache.settings.pausedCategories || {})[key]);
}
function setCategoryPaused(bot, key, value) {
    bot.cache.settings.pausedCategories = bot.cache.settings.pausedCategories || {};
    bot.cache.settings.pausedCategories[key] = value;
    bot.saveCache();
}

function isAutopublishEnabled(bot) {
    return Boolean(bot.cache.settings.autopublishEnabled);
}
function setAutopublishEnabled(bot, value) {
    bot.cache.settings.autopublishEnabled = value;
    bot.saveCache();
}

async function handleCategory(bot, interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'pause') {
        const category = interaction.options.getString('category', true);
        setCategoryPaused(bot, category, true);
        await interaction.reply({ content: `⏸️ Category **${category}** paused.`, flags: MessageFlags.Ephemeral });
        await bot.sendLogMessage(`⏸️ ${interaction.user.tag} paused category **${category}**.`);
    } else if (sub === 'resume') {
        const category = interaction.options.getString('category', true);
        setCategoryPaused(bot, category, false);
        await interaction.reply({ content: `▶️ Category **${category}** resumed.`, flags: MessageFlags.Ephemeral });
        await bot.sendLogMessage(`▶️ ${interaction.user.tag} resumed category **${category}**.`);
    } else {
        const paused = Object.entries(bot.cache.settings.pausedCategories || {}).filter(([, v]) => v).map(([k]) => k);
        await interaction.reply({ content: paused.length ? `⏸️ Paused: ${paused.join(', ')}` : '✅ No categories are currently paused.', flags: MessageFlags.Ephemeral });
    }
}

async function handleBlacklist(bot, interaction) {
    const sub = interaction.options.getSubcommand();
    bot.cache.settings.blacklist = bot.cache.settings.blacklist || { keywords: [], organizers: [] };
    const blacklist = bot.cache.settings.blacklist;

    if (sub === 'add') {
        const type = interaction.options.getString('type', true);
        const value = interaction.options.getString('value', true).trim();
        const list = type === 'keyword' ? blacklist.keywords : blacklist.organizers;
        if (list.some((v) => v.toLowerCase() === value.toLowerCase())) {
            return interaction.reply({ content: `ℹ️ "${value}" is already on the ${type} blacklist.`, flags: MessageFlags.Ephemeral });
        }
        list.push(value);
        bot.saveCache();
        await interaction.reply({ content: `🚫 Added "${value}" to the ${type} blacklist.`, flags: MessageFlags.Ephemeral });
        await bot.sendLogMessage(`🚫 ${interaction.user.tag} added "${value}" (${type}) to the blacklist.`);
    } else if (sub === 'remove') {
        const type = interaction.options.getString('type', true);
        const value = interaction.options.getString('value', true).trim();
        const list = type === 'keyword' ? blacklist.keywords : blacklist.organizers;
        const idx = list.findIndex((v) => v.toLowerCase() === value.toLowerCase());
        if (idx === -1) return interaction.reply({ content: `❌ "${value}" is not on the ${type} blacklist.`, flags: MessageFlags.Ephemeral });
        list.splice(idx, 1);
        bot.saveCache();
        await interaction.reply({ content: `✅ Removed "${value}" from the ${type} blacklist.`, flags: MessageFlags.Ephemeral });
    } else {
        const kw = blacklist.keywords.length ? blacklist.keywords.map((v) => `• ${v}`).join('\n') : '(none)';
        const org = blacklist.organizers.length ? blacklist.organizers.map((v) => `• ${v}`).join('\n') : '(none)';
        await interaction.reply({ content: `**Keywords:**\n${kw}\n\n**Organizers:**\n${org}`.slice(0, 1900), flags: MessageFlags.Ephemeral });
    }
}

async function handleAutopublish(bot, interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'on') {
        setAutopublishEnabled(bot, true);
        await interaction.reply({ content: '✅ Auto-publish enabled.', flags: MessageFlags.Ephemeral });
        await bot.sendLogMessage(`📢 Auto-publish turned ON by ${interaction.user.tag}.`);
    } else if (sub === 'off') {
        setAutopublishEnabled(bot, false);
        await interaction.reply({ content: '🛑 Auto-publish disabled.', flags: MessageFlags.Ephemeral });
        await bot.sendLogMessage(`📢 Auto-publish turned OFF by ${interaction.user.tag}.`);
    } else {
        await interaction.reply({ content: `Auto-publish is currently **${isAutopublishEnabled(bot) ? 'ON 🟢' : 'OFF ⚪'}**.`, flags: MessageFlags.Ephemeral });
    }
}

const definitions = [
    new SlashCommandBuilder().setName('category').setDescription('Pause or resume a category from being posted live')
        .addSubcommand((sub) => sub.setName('pause').setDescription('Pause a category')
            .addStringOption((o) => o.setName('category').setDescription('Category').setRequired(true).addChoices(...CATEGORY_CHOICES)))
        .addSubcommand((sub) => sub.setName('resume').setDescription('Resume a paused category')
            .addStringOption((o) => o.setName('category').setDescription('Category').setRequired(true).addChoices(...CATEGORY_CHOICES)))
        .addSubcommand((sub) => sub.setName('list').setDescription('List paused categories')),
    new SlashCommandBuilder().setName('blacklist').setDescription('Auto-skip scraped items matching a keyword or organizer')
        .addSubcommand((sub) => sub.setName('add').setDescription('Add a blacklist entry')
            .addStringOption((o) => o.setName('type').setDescription('What to match').setRequired(true)
                .addChoices({ name: 'Keyword (title/description)', value: 'keyword' }, { name: 'Organizer', value: 'organizer' }))
            .addStringOption((o) => o.setName('value').setDescription('Text to match').setRequired(true)))
        .addSubcommand((sub) => sub.setName('remove').setDescription('Remove a blacklist entry')
            .addStringOption((o) => o.setName('type').setDescription('What to match').setRequired(true)
                .addChoices({ name: 'Keyword', value: 'keyword' }, { name: 'Organizer', value: 'organizer' }))
            .addStringOption((o) => o.setName('value').setDescription('Exact text to remove').setRequired(true)))
        .addSubcommand((sub) => sub.setName('list').setDescription('List current blacklist entries')),
    new SlashCommandBuilder().setName('autopublish').setDescription('Auto-crosspost new live posts once dedupe clears them')
        .addSubcommand((sub) => sub.setName('on').setDescription('Turn on'))
        .addSubcommand((sub) => sub.setName('off').setDescription('Turn off'))
        .addSubcommand((sub) => sub.setName('status').setDescription('Check whether it is on'))
];

const handlers = {
    category: handleCategory,
    blacklist: handleBlacklist,
    autopublish: handleAutopublish
};

module.exports = {
    definitions,
    handlers,
    isCategoryPaused,
    setCategoryPaused,
    isAutopublishEnabled,
    setAutopublishEnabled
};
