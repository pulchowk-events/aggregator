// src/discord/extensions/diagnostics.js
// Two data commands: /stats (posting volume) and /health (permission check).
//
// /stats  — read from posted-channel-markers/*.json. Every successful post
//           writes a marker with postedAt + channelId, so this is a
//           forensically accurate count that doesn't depend on the cache.
// /health — fetch each configured channel, check the bot's permission set,
//           report problems. Useful after a Discord permission change.

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');

const MARKERS_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'posted-channel-markers');

async function handleStats(bot, interaction) {
    const days = interaction.options.getInteger('days') || 7;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let files = [];
    try { files = fs.readdirSync(MARKERS_DIR); } catch (e) { /* empty */ }

    const byChannel = new Map();
    let totalInWindow = 0;
    for (const file of files) {
        try {
            const raw = fs.readFileSync(path.join(MARKERS_DIR, file), 'utf8');
            const data = JSON.parse(raw);
            if (!data.postedAt || data.postedAt < cutoff) continue;
            totalInWindow++;
            byChannel.set(data.channelId, (byChannel.get(data.channelId) || 0) + 1);
        } catch (e) { /* skip unreadable marker */ }
    }

    const channelLines = [...byChannel.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => `<#${id}>: ${count}`);

    const pending = (bot.cache.pendingEvents || []).length;
    const flagged = (bot.cache.pendingEvents || []).filter((e) => bot.hasDataQualityWarnings(e)).length;
    const skipped = (bot.cache.skippedEvents || []).length;
    const archived = (bot.cache.needsAttentionExpiredEvents || []).length;

    const embed = new EmbedBuilder()
        .setTitle(`Posting Stats — last ${days} day(s)`)
        .addFields(
            { name: 'Confirmed posts (all channels)', value: String(totalInWindow), inline: true },
            { name: 'Currently pending', value: String(pending), inline: true },
            { name: 'Flagged (data-quality)', value: String(flagged), inline: true },
            { name: 'Skipped (all-time)', value: String(skipped), inline: true },
            { name: 'Archived needs-attention', value: String(archived), inline: true }
        )
        .setColor(0x00AE86);
    if (channelLines.length > 0) embed.addFields({ name: 'By channel', value: channelLines.slice(0, 15).join('\n').slice(0, 1024) });
    await interaction.editReply({ embeds: [embed] });
}

async function handleHealth(bot, interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const requiredPerms = ['SendMessages', 'EmbedLinks', 'AttachFiles', 'ManageMessages'];
    const problems = [];
    let checkedCount = 0;

    for (const [key, chans] of Object.entries(bot.CATEGORIES)) {
        for (const [mode, channelId] of Object.entries(chans)) {
            if (!channelId || typeof channelId !== 'string') continue;
            checkedCount++;
            try {
                const channel = await bot.client.channels.fetch(channelId);
                if (!channel) { problems.push(`${key}/${mode}: channel not found`); continue; }
                const me = channel.guild ? await channel.guild.members.fetchMe() : null;
                const perms = me ? channel.permissionsFor(me) : null;
                const missing = perms ? requiredPerms.filter((p) => !perms.has(p)) : requiredPerms;
                if (missing.length > 0) problems.push(`${key}/${mode} (<#${channelId}>): missing ${missing.join(', ')}`);
            } catch (error) {
                problems.push(`${key}/${mode}: unreachable (${error.message})`);
            }
        }
    }

    let cacheWritable = true;
    try { bot.flushCacheSync(); } catch (e) { cacheWritable = false; }

    const embed = new EmbedBuilder()
        .setTitle('Bot Health Check')
        .addFields(
            { name: 'Gateway ping', value: bot.client.ws.ping >= 0 ? `${bot.client.ws.ping}ms` : 'unknown', inline: true },
            { name: 'Cache writable', value: cacheWritable ? '✅ yes' : '❌ NO', inline: true },
            { name: 'Channels checked', value: String(checkedCount), inline: true }
        )
        .setColor(problems.length > 0 ? 0xE67E22 : 0x00AE86);
    if (problems.length > 0) embed.addFields({ name: `⚠️ ${problems.length} problem(s)`, value: problems.slice(0, 10).join('\n').slice(0, 1024) });
    else embed.addFields({ name: 'Result', value: '✅ All channels have required permissions.' });
    await interaction.editReply({ embeds: [embed] });
}

const definitions = [
    new SlashCommandBuilder().setName('stats').setDescription('Posting stats for the last N days')
        .addIntegerOption((opt) => opt.setName('days').setDescription('Lookback window in days (default 7)').setRequired(false)),
    new SlashCommandBuilder().setName('health').setDescription('Check bot permissions across all channels')
];

module.exports = { definitions, handlers: { stats: handleStats, health: handleHealth } };
