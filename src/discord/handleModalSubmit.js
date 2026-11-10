// src/discord/handleModalSubmit.js
// Customize modal submit. Updates the item, clears field-level warnings the
// human just fixed, re-runs sanitize (so if the new value is also bad it
// gets re-flagged), re-renders the four action buttons.
//
// Customize is the only path that can clear data-quality warnings short of
// skipping. /pending renders them; force=true on the LIVE button is the
// other escape hatch (skip the warning, post anyway).

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { parseCustomId, buildCustomId } = require('./customId');

async function handleModalSubmit(bot, interaction) {
    if (!require('./admin').isAdmin(bot, interaction)) {
        return interaction.reply({ content: '❌ You need Administrator permissions.', flags: MessageFlags.Ephemeral });
    }

    const { eventId } = parseCustomId(interaction.customId);
    const event = bot.cache.pendingEvents.find((e) => e.id === eventId);
    if (!event) {
        return interaction.reply({ content: '❌ Item not found.', flags: MessageFlags.Ephemeral });
    }

    event.title = interaction.fields.getTextInputValue('title');
    event.description = interaction.fields.getTextInputValue('description') || '';
    event.date = interaction.fields.getTextInputValue('date') || '';
    event.location = interaction.fields.getTextInputValue('location') || '';
    const newImage = interaction.fields.getTextInputValue('image') || '';
    if (newImage) {
        event.image = newImage;
    } else if (!bot.hasValidImage(event)) {
        event.image = null;
    }

    if (event.dataQualityWarnings) {
        delete event.dataQualityWarnings;
        delete event.rawSuspectDate;
        delete event.rawSuspectPrice;
        delete event.rawSuspectLocation;
        delete event.rawSuspectImage;
        delete event.rawSuspectTime;
        delete event.rawSuspectOrganizer;
        delete event.rawSuspectCategory;
        delete event.rawSuspectRegistrationUrl;
        delete event.rawSuspectUrl;
    }
    bot.sanitizeEventFields(event);
    bot.saveCache();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(buildCustomId('post_live', eventId)).setLabel('Post to Live').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(buildCustomId('post_test', eventId)).setLabel('Post to Test').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(buildCustomId('customize', eventId)).setLabel('Customize').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(buildCustomId('skip', eventId)).setLabel('Skip').setStyle(ButtonStyle.Danger)
    );

    const warningNote = bot.hasDataQualityWarnings(event)
        ? '\n\n⚠️ Note: one of the fields you entered still looks off and has been flagged/cleared — check the warnings in `/pending` before posting.'
        : '';

    await interaction.reply({
        content: `✅ Item "${event.title}" updated. Choose where to post:${warningNote}`,
        components: [row],
        flags: MessageFlags.Ephemeral
    });
}

module.exports = { handleModalSubmit };
