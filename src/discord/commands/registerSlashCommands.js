// src/discord/commands/registerSlashCommands.js
// One-shot slash command registration at startup.
//
// Guild-scoped to HOME_GUILD_ID only. Two reasons:
//   1. Guild commands appear ONLY in that guild. Adding the bot to
//      another server grants no command access.
//   2. Guild command updates propagate in seconds. Global commands can
//      take up to an hour.
//
// The PUT (bulk) call is the one that OVERWRITES the guild's command list.
// Every command this repo defines must be present in that PUT — omitting
// one and then running the bot would DELETE that command. Right now
// defs come from commands/index.definitions(), which is the single source
// of truth.
//
// The second PUT (applicationCommands, empty array) wipes any globally-
// registered commands from a previous version of the bot. Safe to run
// permanently — a no-op once the global list is already empty.

const { REST, Routes } = require('discord.js');
const { definitions } = require('./index');
const { auditLog } = require('../../core/auditLogger');
const env = require('../../config/env');

async function registerSlashCommands(bot) {
    const defs = definitions();
    if (!env.HOME_GUILD_ID) {
        console.error('❌ HOME_GUILD_ID is not set — refusing to register commands globally. Set HOME_GUILD_ID in .env.');
        return;
    }

    try {
        const rest = new REST({ version: '10' }).setToken(env.DISCORD_TOKEN);

        await rest.put(
            Routes.applicationGuildCommands(bot.client.user.id, env.HOME_GUILD_ID),
            { body: defs.map((cmd) => cmd.toJSON()) }
        );
        console.log(`✅ Slash commands registered to guild ${env.HOME_GUILD_ID} only (${defs.length} command(s)).`);

        // One-time (idempotent) cleanup of previously-registered globals.
        await rest.put(
            Routes.applicationCommands(bot.client.user.id),
            { body: [] }
        );
    } catch (error) {
        console.error('❌ Failed to register slash commands:', error);
        auditLog('slash_command_registration_failed', `Slash command registration failed: ${error.message}`, {
            errorMessage: error.message, errorStack: error.stack
        }, 'error');
    }
}

module.exports = { registerSlashCommands };
