// src/discord/extensions/helpers.js
// Small utility commands ported from the original botExtensions.js:
//   /uptime      — process uptime, memory, version
//   /find        — search events by title across all cache arrays
//   /backup      — download cache.json
//   /clear-skipped — empty the skipped-events list
//   /restore     — bring a skipped item back to pending
//   /preview     — render how a pending item will look when posted

const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const path = require('path');
const { CACHE_FILE } = require('../../core/cache');

function formatDuration(totalSeconds) {
    const d = Math.floor(totalSeconds / 86400);
    const h = Math.floor((totalSeconds % 86400) / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

async function handleUptime(bot, interaction) {
    const mem = process.memoryUsage();
    const embed = new EmbedBuilder()
        .setTitle('Process Info')
        .addFields(
            { name: 'Uptime', value: formatDuration(Math.floor(process.uptime())), inline: true },
            { name: 'Node version', value: process.version, inline: true },
            { name: 'PID', value: String(process.pid), inline: true },
            { name: 'RSS memory', value: `${(mem.rss / 1024 / 1024).toFixed(1)} MB`, inline: true },
            { name: 'Heap used', value: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`, inline: true }
        )
        .setColor(0x00AE86);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleFind(bot, interaction) {
    const query = (interaction.options.getString('query', true) || '').toLowerCase().trim();
    if (!query) return interaction.reply({ content: '❌ Give me something to search for.', flags: MessageFlags.Ephemeral });

    const pools = [
        { label: 'Pending', list: bot.cache.pendingEvents || [] },
        { label: 'Posted', list: bot.cache.postedEvents || [] },
        { label: 'Skipped', list: bot.cache.skippedEvents || [] },
        { label: 'Needs-attention (archived)', list: bot.cache.needsAttentionExpiredEvents || [] }
    ];
    const matches = [];
    outer:
    for (const { label, list } of pools) {
        for (const ev of list) {
            if ((ev.title || '').toLowerCase().includes(query)) {
                matches.push({ label, ev });
                if (matches.length >= 15) break outer;
            }
        }
    }
    if (matches.length === 0) return interaction.reply({ content: `🔍 No items found matching "${query}".`, flags: MessageFlags.Ephemeral });
    const lines = matches.map(({ label, ev }) => `**[${label}]** ${ev.title} — ${ev.date || 'no date'} (id: \`${ev.id}\`)`);
    await interaction.reply({ content: `🔍 Found ${matches.length} match(es) for "${query}":\n${lines.join('\n')}`.slice(0, 1900), flags: MessageFlags.Ephemeral });
}

async function handleBackup(bot, interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        bot.flushCacheSync();
        const attachment = new AttachmentBuilder(CACHE_FILE, { name: `cache-backup-${Date.now()}.json` });
        await interaction.editReply({ content: '📦 Current cache.json:', files: [attachment] });
    } catch (error) {
        await interaction.editReply({ content: `❌ Backup failed: ${error.message}` });
    }
}

async function handleClearSkipped(bot, interaction) {
    const count = (bot.cache.skippedEvents || []).length;
    bot.cache.skippedEvents = [];
    bot.saveCache();
    await interaction.reply({ content: `🧹 Cleared ${count} skipped item(s) from memory.`, flags: MessageFlags.Ephemeral });
    await bot.sendLogMessage(`🧹 /clear-skipped by ${interaction.user.tag} — removed ${count} skipped item(s).`);
}

async function handleRestore(bot, interaction) {
    const query = (interaction.options.getString('query', true) || '').toLowerCase();
    const matches = (bot.cache.skippedEvents || []).filter((e) => (e.title || '').toLowerCase().includes(query));
    if (matches.length === 0) return interaction.reply({ content: `❌ No skipped item found matching "${query}".`, flags: MessageFlags.Ephemeral });
    if (matches.length > 1) {
        const lines = matches.slice(0, 10).map((e) => `• ${e.title} (id: \`${e.id}\`)`);
        return interaction.reply({ content: `🔍 Multiple matches — be more specific:\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
    }
    const event = matches[0];
    bot.cache.skippedEvents = bot.cache.skippedEvents.filter((e) => e.id !== event.id);
    event.firstSeenAt = Date.now();
    bot.sanitizeEventFields(event);
    bot.cache.pendingEvents.push(event);
    bot.saveCache();
    await interaction.reply({ content: `↩️ Restored "${event.title}" to pending.`, flags: MessageFlags.Ephemeral });
    await bot.sendLogMessage(`↩️ ${interaction.user.tag} restored "${event.title}" from skipped to pending.`);
}

async function handlePreview(bot, interaction) {
    const query = (interaction.options.getString('query', true) || '').toLowerCase();
    const matches = (bot.cache.pendingEvents || []).filter((e) => (e.title || '').toLowerCase().includes(query));
    if (matches.length === 0) return interaction.reply({ content: `🔍 No pending item found matching "${query}".`, flags: MessageFlags.Ephemeral });
    if (matches.length > 1) {
        const lines = matches.slice(0, 10).map((e) => `• ${e.title} (id: \`${e.id}\`)`);
        return interaction.reply({ content: `🔍 Multiple matches — be more specific:\n${lines.join('\n')}`, flags: MessageFlags.Ephemeral });
    }
    const event = matches[0];
    bot.sanitizeEventFields(event);
    const rendered = bot.formatEventMessage(event);
    const content = `👁️ Preview of "${event.title}" — this is NOT posted anywhere:\n\n${rendered}`.slice(0, 1950);
    const payload = { content, flags: MessageFlags.Ephemeral };
    if (bot.hasValidImage(event)) payload.embeds = [new EmbedBuilder().setImage(event.image)];
    await interaction.reply(payload);
}

const definitions = [
    new SlashCommandBuilder().setName('uptime').setDescription('Show process uptime, memory, and version info'),
    new SlashCommandBuilder().setName('find').setDescription('Search pending/posted/skipped/archived items by title')
        .addStringOption((opt) => opt.setName('query').setDescription('Text to search for in item titles').setRequired(true)),
    new SlashCommandBuilder().setName('backup').setDescription('Download the current cache.json'),
    new SlashCommandBuilder().setName('clear-skipped').setDescription('Clear the in-memory skipped-events list'),
    new SlashCommandBuilder().setName('restore').setDescription('Restore a skipped item back to pending')
        .addStringOption((opt) => opt.setName('query').setDescription('Title text to search for among skipped items').setRequired(true)),
    new SlashCommandBuilder().setName('preview').setDescription('Preview how a pending item will render before posting it live')
        .addStringOption((opt) => opt.setName('query').setDescription('Title text to search for among pending items').setRequired(true))
];

const handlers = {
    uptime: handleUptime,
    find: handleFind,
    backup: handleBackup,
    'clear-skipped': handleClearSkipped,
    restore: handleRestore,
    preview: handlePreview
};

module.exports = { definitions, handlers };
