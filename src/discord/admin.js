// src/discord/admin.js
// Guild + permission gate for every command and interaction.
//
// Two checks, both required:
//   1. The interaction must come from HOME_GUILD_ID. Any other guild
//      (including DMs) is rejected — even with Administrator permission.
//      This is what stops someone from adding the bot to a foreign server
//      and running /shutdown there.
//   2. The user must have Discord's ADMINISTRATOR permission in that
//      guild. This is coarser than a per-command permission model, but
//      matches the original bot — every command is admin-only, so a
//      single check at the dispatch point is correct.
//
// Rejections are logged so an accidental add-to-wrong-server is visible
// in the audit trail.

const { auditLog } = require('../core/auditLogger');
const env = require('../config/env');

function isAdmin(bot, interaction) {
    if (!env.HOME_GUILD_ID || interaction.guildId !== env.HOME_GUILD_ID) {
        if (interaction.guildId) {
            console.warn(`⚠️ Rejected interaction from unauthorized guild ${interaction.guildId} (${(interaction.guild && interaction.guild.name) || 'unknown'}) — user ${interaction.user && interaction.user.tag} (${interaction.user && interaction.user.id})`);
            auditLog('unauthorized_guild', `Rejected command "${interaction.commandName || interaction.customId}" from unauthorized guild`, {
                guildId: interaction.guildId,
                guildName: (interaction.guild && interaction.guild.name) || null,
                userId: (interaction.user && interaction.user.id) || null,
                userTag: (interaction.user && interaction.user.tag) || null
            }, 'error');
        }
        return false;
    }
    return Boolean(interaction.memberPermissions && interaction.memberPermissions.has('ADMINISTRATOR'));
}

module.exports = { isAdmin };
