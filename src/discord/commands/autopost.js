// /autopost — start/stop/interval/status for the 6 track × mode combinations.
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { AUTOPOST_LIVE_WINDOW_START_HOUR, AUTOPOST_LIVE_WINDOW_END_HOUR } = require('../../config/constants');

const AUTOPOST_TYPE_CHOICES = [
    { name: 'Events', value: 'events' },
    { name: 'Jobs', value: 'jobs' },
    { name: 'Scholarships', value: 'scholarships' },
    { name: 'Events + Jobs', value: 'events_jobs' },
    { name: 'Events + Scholarships', value: 'events_scholarships' },
    { name: 'Jobs + Scholarships', value: 'jobs_scholarships' },
    { name: 'All Three', value: 'all' }
];

const definition = new SlashCommandBuilder()
    .setName('autopost')
    .setDescription('Automatically post pending items one at a time')
    .addSubcommand((sub) => sub.setName('start-test').setDescription('Start auto-posting to TEST channels')
        .addStringOption((opt) => opt.setName('type').setDescription('What to auto-post').setRequired(true).addChoices(...AUTOPOST_TYPE_CHOICES))
        .addIntegerOption((opt) => opt.setName('interval_minutes').setDescription('Minutes between posts (default: 60, 0 = back-to-back)').setRequired(false)))
    .addSubcommand((sub) => sub.setName('start-live').setDescription('Start auto-posting to LIVE channels')
        .addStringOption((opt) => opt.setName('type').setDescription('What to auto-post').setRequired(true).addChoices(...AUTOPOST_TYPE_CHOICES))
        .addIntegerOption((opt) => opt.setName('interval_minutes').setDescription('Minutes between posts (default: 60, 0 = back-to-back)').setRequired(false)))
    .addSubcommand((sub) => sub.setName('stop').setDescription('Stop auto-posting')
        .addStringOption((opt) => opt.setName('type').setDescription('Which track to stop').setRequired(true).addChoices(...AUTOPOST_TYPE_CHOICES))
        .addStringOption((opt) => opt.setName('target').setDescription('Which channel-mode to stop').setRequired(true)
            .addChoices({ name: 'Test', value: 'test' }, { name: 'Live', value: 'live' }, { name: 'Both', value: 'all' })))
    .addSubcommand((sub) => sub.setName('set-interval').setDescription('Change the posting interval for a track')
        .addStringOption((opt) => opt.setName('type').setDescription('Which track').setRequired(true)
            .addChoices({ name: 'Events', value: 'events' }, { name: 'Jobs', value: 'jobs' }, { name: 'Scholarships', value: 'scholarships' }))
        .addStringOption((opt) => opt.setName('target').setDescription('Test or live').setRequired(true)
            .addChoices({ name: 'Test', value: 'test' }, { name: 'Live', value: 'live' }))
        .addIntegerOption((opt) => opt.setName('interval_minutes').setDescription('New interval in minutes (0 = back-to-back)').setRequired(true)))
    .addSubcommand((sub) => sub.setName('status').setDescription('Show autopost status for all tracks'));

function expandType(t) {
    const map = {
        events: ['events'], jobs: ['jobs'], scholarships: ['scholarships'],
        events_jobs: ['events', 'jobs'], events_scholarships: ['events', 'scholarships'],
        jobs_scholarships: ['jobs', 'scholarships'],
        all: ['events', 'jobs', 'scholarships'],
        both: ['events', 'jobs']
    };
    return map[t] || [t];
}

async function handle(bot, interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'start-test' || sub === 'start-live') {
        const mode = sub === 'start-test' ? 'test' : 'live';
        const type = interaction.options.getString('type');
        const rawInterval = interaction.options.getInteger('interval_minutes');
        const interval = (rawInterval === null || rawInterval === undefined) ? 60 : rawInterval;
        if (interval < 0) return interaction.reply({ content: '❌ Interval must be 0 or more.', flags: MessageFlags.Ephemeral });
        const types = expandType(type);
        for (const t of types) bot.startAutopost(t, mode, interval);
        const intervalText = interval === 0 ? 'back-to-back, instantly' : `every **${interval} minute(s)**`;
        return interaction.reply({
            content: `✅ Autopost started for **${types.join(' + ')}** (**${mode.toUpperCase()}**) — one pending item posted ${intervalText}, per track.`,
            flags: MessageFlags.Ephemeral
        });
    }
    if (sub === 'stop') {
        const type = interaction.options.getString('type');
        const target = interaction.options.getString('target');
        const types = expandType(type);
        const modes = target === 'all' ? ['test', 'live'] : [target];
        for (const t of types) for (const m of modes) bot.stopAutopostDeliberately(t, m);
        return interaction.reply({ content: `🛑 Autopost stopped for **${types.join(' + ')}** / **${modes.join(', ')}**. Won't auto-resume on next restart.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'set-interval') {
        const type = interaction.options.getString('type');
        const target = interaction.options.getString('target');
        const minutes = interaction.options.getInteger('interval_minutes');
        if (minutes < 0) return interaction.reply({ content: '❌ Interval must be 0 or more.', flags: MessageFlags.Ephemeral });
        bot.setAutopostInterval(type, target, minutes);
        return interaction.reply({ content: `✅ ${type}/${target} interval set to ${minutes === 0 ? 'back-to-back' : `${minutes}m`}.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'status') {
        const line = (t) => `Test: ${bot.autopostConfig[t].test.active ? `🟢 ${bot.formatAutopostInterval(bot.autopostConfig[t].test.intervalMinutes)}` : '⚪ off'}\nLive: ${bot.autopostConfig[t].live.active ? `🟢 ${bot.formatAutopostInterval(bot.autopostConfig[t].live.intervalMinutes)}` : '⚪ off'}`;
        const embed = new EmbedBuilder()
            .setTitle('Autopost Status')
            .addFields(
                { name: '📅 Events', value: line('events'), inline: true },
                { name: '💼 Jobs', value: line('jobs'), inline: true },
                { name: '🎓 Scholarships', value: line('scholarships'), inline: true },
                { name: 'Live posting window', value: `${AUTOPOST_LIVE_WINDOW_START_HOUR}:00-${AUTOPOST_LIVE_WINDOW_END_HOUR}:00 NPT`, inline: false }
            )
            .setColor(0x00AE86);
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
}

module.exports = { definition, handle };
