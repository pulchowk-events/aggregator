// src/discord/extensions/cleanup.js
// /cleanup — bulk-remove cached items by type and/or source.
//
// Two-step flow:
//   1. Preview: list up to 15 matching items, store the exact matched IDs
//      (not the filter) in bot._ext.pendingCleanups[token]. The token is
//      derived from the interaction, so a re-run of /cleanup gets a fresh
//      token — old pending cleanups can't be mistakenly confirmed.
//   2. Confirm: re-resolve by the stored IDs (protects against cache
//      changes between preview and confirm), then delete.
//
// Delete removes:
//   - the matching items from EVERY cache array
//   - their dedup keys from postedEventKeys
//   - their synced keys from supabaseSync.syncedEventKeys (so a re-sync
//     would re-upload them if they ever come back)
//   - their marker files on disk
//
// Confirm uses IDs, not the filter — so a concurrent scrape that adds
// new matching items between preview and confirm won't be swept into
// the deletion.

const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { auditLog } = require('../../core/auditLogger');
const { getEventDedupKey } = require('../../posting/dedup');

const CLEANUP_ARRAYS = ['pendingEvents', 'postedEvents', 'recentEvents', 'expiredEvents', 'skippedEvents', 'needsAttentionExpiredEvents'];
const MARKERS_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'posted-channel-markers');

function matchesCleanupFilter(event, itemType, source) {
    if (itemType !== 'all') {
        if (itemType === 'jobs' && event.itemType !== 'job') return false;
        if (itemType === 'scholarships' && event.itemType !== 'scholarship') return false;
        if (itemType === 'events' && event.itemType) return false;
    }
    if (source && (event.source || '').toLowerCase() !== source.toLowerCase()) return false;
    return true;
}

function findCleanupMatches(bot, itemType, source) {
    const matches = [];
    for (const arrName of CLEANUP_ARRAYS) {
        const arr = bot.cache[arrName];
        if (!Array.isArray(arr)) continue;
        for (const e of arr) {
            if (matchesCleanupFilter(e, itemType, source)) matches.push(e);
        }
    }
    return matches;
}

function performCleanup(bot, matches, channelIds) {
    const matchedIds = new Set(matches.map((e) => e.id).filter(Boolean));
    const matchedKeys = new Set(matches.map((e) => getEventDedupKey(e)));

    const removedCounts = {};
    for (const arrName of CLEANUP_ARRAYS) {
        const arr = bot.cache[arrName];
        if (!Array.isArray(arr)) continue;
        const before = arr.length;
        bot.cache[arrName] = arr.filter((e) => !(e.id && matchedIds.has(e.id)));
        removedCounts[arrName] = before - bot.cache[arrName].length;
    }

    let removedPostedKeys = 0;
    if (Array.isArray(bot.cache.postedEventKeys)) {
        const before = bot.cache.postedEventKeys.length;
        bot.cache.postedEventKeys = bot.cache.postedEventKeys.filter((k) => !matchedKeys.has(k));
        removedPostedKeys = before - bot.cache.postedEventKeys.length;
    }

    let removedSyncedKeys = 0;
    if (bot.cache.settings.supabaseSync && bot.cache.settings.supabaseSync.syncedEventKeys) {
        const before = bot.cache.settings.supabaseSync.syncedEventKeys.length;
        bot.cache.settings.supabaseSync.syncedEventKeys = bot.cache.settings.supabaseSync.syncedEventKeys.filter((k) => !matchedKeys.has(k));
        removedSyncedKeys = before - bot.cache.settings.supabaseSync.syncedEventKeys.length;
    }

    let removedPostedNames = 0;
    if (Array.isArray(bot.cache.postedEventNames)) {
        const matchedNames = new Set(matches.map((e) => bot.normalizeEventName(e.title || '')));
        const stillInUse = new Set((bot.cache.postedEvents || []).map((e) => bot.normalizeEventName(e.title || '')));
        const before = bot.cache.postedEventNames.length;
        bot.cache.postedEventNames = bot.cache.postedEventNames.filter((n) => !matchedNames.has(n) || stillInUse.has(n));
        removedPostedNames = before - bot.cache.postedEventNames.length;
    }

    let removedMarkers = 0;
    if (fs.existsSync(MARKERS_DIR)) {
        for (const key of matchedKeys) {
            for (const channelId of channelIds) {
                const hash = crypto.createHash('sha1').update(`${key}::${channelId}`).digest('hex');
                const markerPath = path.join(MARKERS_DIR, `${hash}.json`);
                try {
                    if (fs.existsSync(markerPath)) {
                        fs.unlinkSync(markerPath);
                        removedMarkers++;
                    }
                } catch (e) { /* ignore */ }
            }
        }
    }

    bot.saveCache();
    return { removedCounts, removedPostedKeys, removedSyncedKeys, removedPostedNames, removedMarkers };
}

async function handleCleanup(bot, interaction) {
    const itemType = interaction.options.getString('item_type', true);
    const source = interaction.options.getString('source') || null;

    const matches = findCleanupMatches(bot, itemType, source);
    if (matches.length === 0) {
        return interaction.reply({
            content: `✅ Nothing matched — no ${itemType === 'all' ? 'items' : itemType}${source ? ` from source "${source}"` : ''} found.`,
            flags: MessageFlags.Ephemeral
        });
    }

    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    bot._ext.pendingCleanups = bot._ext.pendingCleanups || new Map();
    bot._ext.pendingCleanups.set(token, { matchedIds: matches.map((e) => e.id).filter(Boolean), itemType, source });

    const preview = matches.slice(0, 15).map((e) => `• [${e.itemType || 'event'}] "${e.title}" (${e.source || 'unknown source'})`).join('\n');
    const more = matches.length > 15 ? `\n…and ${matches.length - 15} more.` : '';

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ext_cleanup_confirm:${token}`).setLabel(`Delete ${matches.length} item(s)`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`ext_cleanup_cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
        content: `⚠️ This will permanently remove **${matches.length}** item(s) matching **${itemType}**${source ? ` / source "${source}"` : ''} from every cache array, their dedup keys, and their marker files.\n\n${preview}${more}\n\nConfirm?`,
        components: [row],
        flags: MessageFlags.Ephemeral
    });
}

async function handleCleanupButton(bot, interaction) {
    const [action, token] = interaction.customId.split(':');
    const pending = bot._ext.pendingCleanups && bot._ext.pendingCleanups.get(token);

    if (!pending) {
        return interaction.update({ content: '❌ This cleanup request expired or was already handled — run `/cleanup` again.', components: [] });
    }
    bot._ext.pendingCleanups.delete(token);

    if (action === 'ext_cleanup_cancel') {
        return interaction.update({ content: '❌ Cleanup cancelled — nothing was removed.', components: [] });
    }

    await interaction.deferUpdate();

    const idSet = new Set(pending.matchedIds);
    const matches = [];
    for (const arrName of CLEANUP_ARRAYS) {
        const arr = bot.cache[arrName];
        if (!Array.isArray(arr)) continue;
        for (const e of arr) if (e.id && idSet.has(e.id)) matches.push(e);
    }

    const channelIds = Object.values(bot.CATEGORIES).flatMap((c) => [c.main, c.test]).filter(Boolean);
    const result = performCleanup(bot, matches, channelIds);

    const summary = Object.entries(result.removedCounts).filter(([, c]) => c > 0).map(([arr, c]) => `${arr}: ${c}`).join(', ') || 'none';
    await interaction.editReply({
        content: `✅ Removed **${matches.length}** item(s) matching **${pending.itemType}**${pending.source ? ` / source "${pending.source}"` : ''}.\n\nBy array: ${summary}\nDedup keys removed: ${result.removedPostedKeys}\nSynced keys removed: ${result.removedSyncedKeys}\nMarker files removed: ${result.removedMarkers}`,
        components: []
    });
    await bot.sendLogMessage(`🗑️ /cleanup by ${interaction.user.tag} — removed ${matches.length} item(s).`);
    auditLog('cleanup_command', `Bulk cleanup by ${interaction.user.tag}`, { itemType: pending.itemType, source: pending.source, removedCount: matches.length, ...result }, 'warn');
}

const definitions = [
    new SlashCommandBuilder().setName('cleanup').setDescription('Bulk-remove cached items by type and/or source')
        .addStringOption((opt) => opt.setName('item_type').setDescription('Which kind to target').setRequired(true)
            .addChoices({ name: 'Events', value: 'events' }, { name: 'Jobs', value: 'jobs' }, { name: 'Scholarships', value: 'scholarships' }, { name: 'All types', value: 'all' }))
        .addStringOption((opt) => opt.setName('source').setDescription('Exact source slug (e.g. erasmusmundus, katajaam) — omit to match every source').setRequired(false))
];

module.exports = { definitions, handlers: { cleanup: handleCleanup }, handleCleanupButton, findCleanupMatches, performCleanup };
