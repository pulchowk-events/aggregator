// /ping — control role-ping notifications on live posts.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const env = require('../../config/env');

const CATEGORY_CHOICES = Object.keys(env.CHANNELS).map((k) => ({ name: k, value: k }));

const definition = new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Control role-ping notifications on live posts')
    .addSubcommand((sub) => sub.setName('on').setDescription('Enable role pings on live posts'))
    .addSubcommand((sub) => sub.setName('off').setDescription('Disable role pings on all live posts'))
    .addSubcommand((sub) => sub.setName('add').setDescription('Only ping if title/description/tags contain this keyword')
        .addStringOption((opt) => opt.setName('keyword').setDescription('Keyword to allow pinging for').setRequired(true)))
    .addSubcommand((sub) => sub.setName('remove').setDescription('Remove a keyword from the ping allow-list')
        .addStringOption((opt) => opt.setName('keyword').setDescription('Keyword to remove').setRequired(true)))
    .addSubcommand((sub) => sub.setName('list').setDescription('Show current ping settings'))
    .addSubcommand((sub) => sub.setName('category').setDescription('Turn pinging on/off for one category')
        .addStringOption((opt) => opt.setName('category').setDescription('Category').setRequired(true).addChoices(...CATEGORY_CHOICES))
        .addStringOption((opt) => opt.setName('state').setDescription('on or off').setRequired(true)
            .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })));

async function handle(bot, interaction) {
    const sub = interaction.options.getSubcommand();
    bot.cache.settings.pingKeywords = bot.cache.settings.pingKeywords || [];

    if (sub === 'on') {
        bot.cache.settings.pingEnabled = true;
        bot.flushCacheSync();
        return interaction.reply({ content: '🔔 Role pings **enabled** for live posts.', flags: MessageFlags.Ephemeral });
    }
    if (sub === 'off') {
        bot.cache.settings.pingEnabled = false;
        bot.flushCacheSync();
        return interaction.reply({ content: '🔕 Role pings **disabled** for all live posts.', flags: MessageFlags.Ephemeral });
    }
    if (sub === 'add') {
        const keyword = interaction.options.getString('keyword').trim().toLowerCase();
        if (!bot.cache.settings.pingKeywords.includes(keyword)) {
            bot.cache.settings.pingKeywords.push(keyword);
            bot.flushCacheSync();
        }
        return interaction.reply({ content: `✅ Added keyword **"${keyword}"**.\nCurrent: ${bot.cache.settings.pingKeywords.map((k) => `\`${k}\``).join(', ') || 'none'}`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'remove') {
        const keyword = interaction.options.getString('keyword').trim().toLowerCase();
        bot.cache.settings.pingKeywords = bot.cache.settings.pingKeywords.filter((k) => k !== keyword);
        bot.flushCacheSync();
        return interaction.reply({ content: `🗑️ Removed keyword **"${keyword}"**.\nCurrent: ${bot.cache.settings.pingKeywords.map((k) => `\`${k}\``).join(', ') || 'none'}`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'list') {
        const catStates = CATEGORY_CHOICES.map((c) => {
            const enabled = (bot.cache.settings.categoryPingEnabled || {})[c.value] !== false;
            return `${enabled ? '🔔' : '🔕'} ${c.value}`;
        }).join('\n');
        return interaction.reply({
            content: `**Ping settings**\nGlobal: ${bot.cache.settings.pingEnabled === false ? '🔕 off' : '🔔 on'}\nKeyword filter: ${bot.cache.settings.pingKeywords.length ? bot.cache.settings.pingKeywords.map((k) => `\`${k}\``).join(', ') : '*(none)*'}\n\n**Per-category:**\n${catStates}`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (sub === 'category') {
        const category = interaction.options.getString('category');
        const state = interaction.options.getString('state') === 'on';
        bot.cache.settings.categoryPingEnabled = bot.cache.settings.categoryPingEnabled || {};
        bot.cache.settings.categoryPingEnabled[category] = state;
        bot.flushCacheSync();
        return interaction.reply({ content: `${state ? '🔔' : '🔕'} Pings for **${category}** turned **${state ? 'on' : 'off'}**.`, flags: MessageFlags.Ephemeral });
    }
}

module.exports = { definition, handle };
