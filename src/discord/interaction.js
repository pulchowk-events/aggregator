// src/discord/interaction.js
// The interactionCreate router.
//
// Dispatches based on interaction type:
//   - Chat input command → admin check, then commands/index.handleCommand
//   - String select menu → handleCategorySelect (post-picker)
//   - Button → handleButton (post action buttons)
//   - Modal submit → handleModalSubmit (customize event modal)
//
// botExtensions monkey-patches bot.client's interactionCreate listeners
// by capturing and replaying them — that mechanism is preserved: this
// router is the SINGLE listener until extensions wraps it. See
// extensions/index.js for the wrapping logic.
//
// Error handling: 10062 (interaction expired) is expected and silent.
// Anything else gets a user-visible ephemeral reply, plus an audit log
// entry with the full error.

const { MessageFlags } = require('discord.js');
const { auditLog } = require('../core/auditLogger');

async function handleInteraction(bot, interaction) {
    try {
        if (interaction.isChatInputCommand()) {
            await dispatchCommand(bot, interaction);
        } else if (interaction.isStringSelectMenu()) {
            await require('./handleCategorySelect').handleCategorySelect(bot, interaction);
        } else if (interaction.isButton()) {
            await require('./handleButton').handleButton(bot, interaction);
        } else if (interaction.isModalSubmit()) {
            await require('./handleModalSubmit').handleModalSubmit(bot, interaction);
        }
    } catch (error) {
        if (error.code === 10062) {
            console.warn('⚠️ Interaction expired before we could respond (this is usually harmless — check the logs channel for the actual result).');
            return;
        }
        console.error('❌ Unhandled interaction error:', error);
        auditLog('interaction_error', `Unhandled interaction error: ${error.message}`, {
            commandName: interaction.commandName || null,
            customId: interaction.customId || null,
            userId: interaction.user && interaction.user.id,
            guildId: interaction.guildId,
            errorMessage: error.message,
            errorStack: error.stack
        }, 'error');

        try {
            const payload = { content: '❌ Something went wrong handling that. Check the logs.', flags: MessageFlags.Ephemeral };
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp(payload);
            } else {
                await interaction.reply(payload);
            }
        } catch (e) { /* interaction likely expired */ }
    }
}

async function dispatchCommand(bot, interaction) {
    // Admin gate. Every command in this bot requires it — there's no
    // public user-facing command.
    if (!require('./admin').isAdmin(bot, interaction)) {
        return interaction.reply({ content: '❌ You need Administrator permissions.', flags: MessageFlags.Ephemeral });
    }
    return require('./commands').handleCommand(bot, interaction);
}

module.exports = { handleInteraction };
