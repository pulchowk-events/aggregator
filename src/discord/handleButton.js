// src/discord/handleButton.js
// Button routing. Four families:
//   confirm_post_force: / confirm_post: → handleConfirmPost (post)
//   cancel_post:                       → handleCancelPost
//   post_live / post_test:             → sendCategoryPicker (which category?)
//   customize / skip:                  → open modal / move to skipped

const { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const { parseCustomId, buildCustomId } = require('./customId');

async function handleButton(bot, interaction) {
    if (!require('./admin').isAdmin(bot, interaction)) {
        return interaction.reply({ content: '❌ You need Administrator permissions.', flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId.startsWith('confirm_post_force:') || interaction.customId.startsWith('confirm_post:')) {
        return require('./handleConfirmPost').handleConfirmPost(bot, interaction);
    }
    if (interaction.customId.startsWith('cancel_post:')) {
        return require('./handleConfirmPost').handleCancelPost(bot, interaction);
    }

    const { action, eventId } = parseCustomId(interaction.customId);
    const event = bot.cache.pendingEvents.find((e) => e.id === eventId);
    if (!event) {
        return interaction.reply({ content: '❌ Item not found (it may have already been handled).', flags: MessageFlags.Ephemeral });
    }

    if (action === 'post_live' || action === 'post_test') {
        const mode = action === 'post_live' ? 'main' : 'test';
        return require('./handleCategorySelect').sendCategoryPicker(bot, interaction, mode, event);
    }

    if (action === 'customize') {
        const modal = new ModalBuilder()
            .setCustomId(buildCustomId('customize', eventId))
            .setTitle('Customize Item');

        const titleInput = new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setValue(event.title || '').setRequired(true);
        const descInput = new TextInputBuilder().setCustomId('description').setLabel('Description').setStyle(TextInputStyle.Paragraph).setValue(event.description || '').setRequired(false);
        const dateInput = new TextInputBuilder().setCustomId('date').setLabel('Date & Time').setStyle(TextInputStyle.Short).setValue(event.date || '').setRequired(false);
        const locationInput = new TextInputBuilder().setCustomId('location').setLabel('Location').setStyle(TextInputStyle.Short).setValue(event.location || '').setRequired(false);
        const imageInput = new TextInputBuilder().setCustomId('image').setLabel('Image URL (required for Live posts)').setStyle(TextInputStyle.Short).setValue(event.image || '').setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(descInput),
            new ActionRowBuilder().addComponents(dateInput),
            new ActionRowBuilder().addComponents(locationInput),
            new ActionRowBuilder().addComponents(imageInput)
        );

        return interaction.showModal(modal);
    }

    if (action === 'skip') {
        await interaction.deferUpdate();
        bot.removeFromPending(eventId);
        require('../core/cache').pushToSkipped(bot, event);
        bot.saveCache();
        return interaction.editReply({ content: `⏭️ Item "${event.title}" skipped.` });
    }

    return interaction.reply({ content: `❌ Unknown action "${action}".`, flags: MessageFlags.Ephemeral });
}

module.exports = { handleButton };
