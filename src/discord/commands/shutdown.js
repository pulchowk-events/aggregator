// /shutdown — emergency stop. Halts every autopost track, logs the actor,
// then exits the process. Process supervisor (pm2/systemd/docker) is
// expected to bring it back up if configured for that; otherwise the
// operator restarts manually.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');

const definition = new SlashCommandBuilder()
    .setName('shutdown')
    .setDescription('Emergency stop: halts autopost immediately and shuts the bot process down');

async function handle(bot, interaction) {
    for (const t of bot.getAutopostItemTypes()) {
        for (const m of bot.getAutopostModes()) {
            bot.stopAutopostDeliberately(t, m);
        }
    }
    await interaction.reply({ content: '🛑 Autopost halted. Shutting the bot process down now — you will need to start it again manually.', flags: MessageFlags.Ephemeral });
    await bot.sendLogMessage(`🛑 /shutdown invoked by ${interaction.user.tag} (${interaction.user.id}) — autopost stopped, bot process is exiting now.`);
    await bot.shutdown();
    process.exit(0);
}

module.exports = { definition, handle };
