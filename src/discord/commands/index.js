// src/discord/commands/index.js
// Command dispatcher. Every command file exports { definition, handle } —
// definition is a SlashCommandBuilder, handle is an async function taking
// (bot, interaction).
//
// registerSlashCommands.js imports the DEFINITIONS array (via `definitions()`);
// this file imports the HANDLERS map (via `handleCommand`).

const { MessageFlags } = require('discord.js');

// Lazy-require to avoid a circular dependency: command files themselves
// require ../.. /bot for state, but the definitions array only needs the
// builders. The handlers require nothing from this file, so a plain map
// at module scope is safe.
const COMMAND_NAMES = ['scrape', 'pending', 'status', 'settings', 'autopost', 'shutdown', 'ping'];

function definitions() {
    const defs = COMMAND_NAMES.map((name) => {
        try {
            return require(`./${name}`).definition;
        } catch (error) {
            console.error(`❌ Command "${name}" failed to load definition:`, error.message);
            return null;
        }
    }).filter(Boolean);
    return defs;
}

async function handleCommand(bot, interaction) {
    const name = interaction.commandName;
    if (!COMMAND_NAMES.includes(name)) {
        return interaction.reply({ content: `❌ Unknown command "${name}".`, flags: MessageFlags.Ephemeral });
    }
    const handler = require(`./${name}`).handle;
    if (typeof handler !== 'function') {
        return interaction.reply({ content: `❌ Command "${name}" has no handler.`, flags: MessageFlags.Ephemeral });
    }
    return handler(bot, interaction);
}

module.exports = { COMMAND_NAMES, definitions, handleCommand };
