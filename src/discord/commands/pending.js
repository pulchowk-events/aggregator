// /pending — list pending items with per-item action buttons.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { isEventPast } = require('../../core/dateUtils');
const { deduplicateEventsByKey } = require('../../posting/dedup');
const { matchesAutopostItemType } = require('../../posting/autopost');

const definition = new SlashCommandBuilder()
    .setName('pending')
    .setDescription('List all pending items with action buttons')
    .addStringOption((opt) => opt
        .setName('type')
        .setDescription('Filter')
        .setRequired(false)
        .addChoices(
            { name: 'All', value: 'all' },
            { name: 'Events only', value: 'events' },
            { name: 'Jobs only', value: 'jobs' },
            { name: 'Scholarships only', value: 'scholarships' }
        ));

async function handle(bot, interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const type = interaction.options.getString('type') || 'all';

    let futureEvents = bot.cache.pendingEvents.filter((e) => !isEventPast(e));
    if (type !== 'all') futureEvents = futureEvents.filter((e) => matchesAutopostItemType(e, type));
    const uniqueFuture = deduplicateEventsByKey(futureEvents);

    await require('../sendPendingEventsMessage').sendPendingEventsMessage(bot, interaction.channel, uniqueFuture);
    await interaction.editReply({ content: `📋 ${uniqueFuture.length} pending item(s) listed (${type}).` });
}

module.exports = { definition, handle };
