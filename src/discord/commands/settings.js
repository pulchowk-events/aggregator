// /settings — runtime config overrides.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const cron = require('node-cron');

const definition = new SlashCommandBuilder()
    .setName('settings')
    .setDescription('View or update bot settings')
    .addSubcommand((sub) => sub.setName('set-logs').setDescription('Set the logs channel')
        .addChannelOption((opt) => opt.setName('channel').setDescription('The channel to send logs to').setRequired(true)))
    .addSubcommand((sub) => sub.setName('set-schedule').setDescription('Change the automatic scrape schedule (cron expression)')
        .addStringOption((opt) => opt.setName('cron').setDescription("e.g. '0 * * * *' for hourly").setRequired(true)))
    .addSubcommand((sub) => sub.setName('set-lead-days').setDescription('Minimum days before an item date for autopost to consider it (default 3)')
        .addIntegerOption((opt) => opt.setName('days').setDescription('Minimum lead days (0 = no minimum)').setRequired(true)))
    .addSubcommand((sub) => sub.setName('set-needs-attention-expiry-days').setDescription('Days a flagged/imageless item sits in pending before being archived (default 14)')
        .addIntegerOption((opt) => opt.setName('days').setDescription('Expiry in days').setRequired(true)))
    .addSubcommand((sub) => sub.setName('toggle-missed-scrape-catchup').setDescription('Turn automatic catch-up scraping (after a missed cycle) on/off — default on')
        .addStringOption((opt) => opt.setName('state').setDescription('on or off').setRequired(true)
            .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })));

async function handle(bot, interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'set-logs') {
        const channel = interaction.options.getChannel('channel');
        bot.cache.settings.logsChannelId = channel.id;
        bot.saveCache();
        return interaction.reply({ content: `✅ Logs channel set to <#${channel.id}>`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'set-schedule') {
        const expr = interaction.options.getString('cron');
        if (!cron.validate(expr)) {
            return interaction.reply({ content: `❌ "${expr}" is not a valid cron expression.`, flags: MessageFlags.Ephemeral });
        }
        bot.cache.settings.scrapeCron = expr;
        bot.saveCache();
        bot.rescheduleWithCustomCron(expr);
        return interaction.reply({ content: `✅ Automatic scrape schedule updated to \`${expr}\``, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'set-lead-days') {
        const days = interaction.options.getInteger('days');
        if (days < 0) return interaction.reply({ content: '❌ Days must be 0 or more.', flags: MessageFlags.Ephemeral });
        bot.cache.settings.autopostMinLeadDays = days;
        bot.saveCache();
        return interaction.reply({ content: `✅ Autopost minimum lead time set to **${days} day(s)**.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'set-needs-attention-expiry-days') {
        const days = interaction.options.getInteger('days');
        if (days < 0) return interaction.reply({ content: '❌ Days must be 0 or more.', flags: MessageFlags.Ephemeral });
        bot.cache.settings.needsAttentionExpiryDays = days;
        bot.saveCache();
        return interaction.reply({ content: `✅ Needs-attention expiry set to **${days} day(s)**.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'toggle-missed-scrape-catchup') {
        const state = interaction.options.getString('state') === 'on';
        bot.cache.settings.missedScrapeCatchupEnabled = state;
        bot.saveCache();
        return interaction.reply({ content: `${state ? '✅ Enabled' : '🔕 Disabled'} automatic catch-up scraping after a missed cycle.`, flags: MessageFlags.Ephemeral });
    }
}

module.exports = { definition, handle };
