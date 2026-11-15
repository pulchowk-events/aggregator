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

        // Per-command POST loop, NOT bulk PUT. Reasons:
        //
        //   1. PUT on /guilds/{id}/commands REPLACES the entire guild
        //      command list. Extensions (supabase, websiteSync, extensions/
        //      index.js) each POST their own commands at ready time. Both
        //      run on the 'ready' event with no ordering guarantee. If the
        //      base PUT fires LAST, it wipes every extension command that
        //      was just added -- silently, because PUT succeeds. That is
        //      why /website-sync and /supabase disappeared in production
        //      after ~200ms last session.
        //
        //   2. POST is additive and idempotent by (name, type). Re-POSTing
        //      an existing command updates it in place, doesn't error, and
        //      doesn't wipe anything. Safe regardless of which listener
        //      fires first.
        //
        //   3. Failures are isolated per-command. If one command's payload
        //      is malformed (DiscordAPIError[50035]), the others still
        //      register, and we log exactly which command failed.
        //
        // Note: POST body is ONE command dict, not an array. The first
        // attempt at this fix sent an array and got DiscordAPIError[50035].
        const failed = [];
        for (const cmd of defs) {
            const payload = cmd.toJSON();
            try {
                await rest.post(
                    Routes.applicationGuildCommands(bot.client.user.id, env.HOME_GUILD_ID),
                    { body: payload }
                );
            } catch (e) {
                failed.push({ name: payload.name, error: e.message });
                console.warn(`   \u26a0\ufe0f [registerSlashCommands] POST failed for "/${payload.name}": ${e.message}`);
            }
        }
        const okCount = defs.length - failed.length;
        console.log(`   [registerSlashCommands] ${okCount}/${defs.length} base command(s) registered to guild ${env.HOME_GUILD_ID} only${failed.length ? ' · ' + failed.length + ' failed' : ''}`);

        // One-time (idempotent) cleanup of previously-registered globals.
        // Different route (/applications/{id}/commands, not /guilds/...).
        // PUT with empty body is correct here -- it must REPLACE the global
        // list with nothing, and no other listener registers globals.
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
