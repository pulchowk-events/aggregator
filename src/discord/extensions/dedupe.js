// src/discord/extensions/dedupe.js
// Anti-duplicate sweep for LIVE channels.
//
// Two grouping signals determine whether two bot messages are duplicates:
//   - normalized title extracted from the first line (## <emoji> Title)
//   - detail line extracted from the message (🗓️ Time / ⏳ Apply by / Deadline)
//
// A group is a set of messages with the same (title, detail) pair. Only
// the OLDEST message in each group is kept; all others are deleted. Two
// events that share a title but not a date are NOT duplicates (different
// groups) — this is deliberate, it prevents weekly meetups from being
// silently merged.
//
// Two entry points:
//   scanAllLiveChannelsForDuplicates(bot, {channelIds, limit}) — small
//     window sweep, used after each post and on the /dedupe command.
//     This is fast; it scans only the last ~7 messages per channel.
//
//   publish-previous — full-history variant. Paginates through the
//     ENTIRE channel history (bounded by a hard cap so a runaway loop
//     can't melt a rate limit), dedupes, then crossposts every surviving
//     message that's eligible. Slower; meant as a one-time cleanup.

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { auditLog } = require('../../core/auditLogger');

const DEDUPE_SCAN_MESSAGE_LIMIT = 7;
const DEDUPE_SCAN_STAGGER_MS = 750;
const PUBLISH_PREVIOUS_PAGE_SIZE = 100;
const PUBLISH_PREVIOUS_HARD_CAP = 5000;
const PUBLISH_PREVIOUS_PAGINATION_PAUSE_MS = 300;
const PUBLISH_PREVIOUS_CROSSPOST_PAUSE_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function liveChannelIds(bot) {
    return Object.values(bot.CATEGORIES).map((c) => c.main).filter(Boolean);
}

// Extract the "## <emoji> Title" line as plain title text.
function extractTitleFromMessage(content) {
    const firstLine = (content || '').split('\n')[0] || '';
    const match = firstLine.match(/^##\s*(?:<a?:\w+:\d+>\s*)?(.+)$/);
    if (!match) return null;
    return match[1].trim();
}

// Extract the "detail line" that distinguishes otherwise-identical titles.
function extractDetailLineFromMessage(content) {
    const dateMatch = (content || '').match(/🗓️ \*\*Time:\*\* (.+?)(?:\n|$)/);
    if (dateMatch) return dateMatch[1].trim();
    const applyMatch = (content || '').match(/⏳ \*\*Apply by:\*\* (.+?)(?:\n|$)/);
    if (applyMatch) return applyMatch[1].trim();
    const deadlineMatch = (content || '').match(/🗓️ \*\*(?:Deadline|For Year):\*\* (.+?)(?:\n|$)/);
    if (deadlineMatch) return deadlineMatch[1].trim();
    return null;
}

function getDedupeGroupKey(bot, message) {
    const title = extractTitleFromMessage(message.content);
    if (!title) return null;
    const normalizedTitle = bot.normalizeEventName(title);
    if (!normalizedTitle) return null;
    const detail = extractDetailLineFromMessage(message.content) || '';
    return `${normalizedTitle}||${detail.toLowerCase()}`;
}

function filterToBotFormattedMessages(bot, messages) {
    return messages
        .filter((m) => m.author && bot.client.user && m.author.id === bot.client.user.id)
        .filter((m) => typeof m.content === 'string' && m.content.trim().startsWith('##'));
}

async function deleteDuplicateMessages(bot, channelId, botMessages) {
    const sorted = [...botMessages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const groups = new Map();
    for (const msg of sorted) {
        const key = getDedupeGroupKey(bot, msg);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(msg);
    }

    const deleted = [];
    for (const [key, msgs] of groups) {
        if (msgs.length < 2) continue;
        const [keep, ...extras] = msgs;
        for (const extra of extras) {
            try {
                await extra.delete();
                deleted.push({
                    channelId,
                    title: extractTitleFromMessage(extra.content) || extra.content.slice(0, 80),
                    messageId: extra.id,
                    keptMessageId: keep.id
                });
                auditLog('dedupe_delete', `Deleted duplicate post in channel ${channelId} (kept ${keep.id})`, {
                    channelId, keptMessageId: keep.id, removedMessageId: extra.id, groupKey: key
                }, 'warn');
            } catch (error) {
                auditLog('dedupe_delete_error', `Failed to delete duplicate ${extra.id} in ${channelId}`, {
                    channelId, messageId: extra.id, errorMessage: error.message, errorCode: error.code || null
                }, 'error');
            }
        }
    }
    return deleted;
}

// Fetch bot messages from a channel, newest-first. `amount` is a cap or
// null for "entire history" (bounded by PUBLISH_PREVIOUS_HARD_CAP).
async function fetchBotMessages(bot, channel, amount) {
    const collected = [];
    let before;
    while (true) {
        if (amount && collected.length >= amount) break;
        if (!amount && collected.length >= PUBLISH_PREVIOUS_HARD_CAP) break;
        const remaining = amount ? amount - collected.length : PUBLISH_PREVIOUS_PAGE_SIZE;
        const fetchLimit = Math.min(PUBLISH_PREVIOUS_PAGE_SIZE, remaining > 0 ? remaining : PUBLISH_PREVIOUS_PAGE_SIZE);
        const options = before ? { limit: fetchLimit, before } : { limit: fetchLimit };
        const batch = await channel.messages.fetch(options);
        if (batch.size === 0) break;
        const arr = [...batch.values()];
        collected.push(...arr);
        before = arr[arr.length - 1].id;
        if (batch.size < fetchLimit) break;
        await sleep(PUBLISH_PREVIOUS_PAGINATION_PAUSE_MS);
    }
    return filterToBotFormattedMessages(bot, collected);
}

async function scanChannelForDuplicates(bot, channelId, limit) {
    const channel = await bot.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return [];
    const botMessages = await fetchBotMessages(bot, channel, limit);
    return deleteDuplicateMessages(bot, channelId, botMessages);
}

async function scanAllLiveChannelsForDuplicates(bot, options = {}) {
    const channelIds = options.channelIds || liveChannelIds(bot);
    const limit = options.limit || DEDUPE_SCAN_MESSAGE_LIMIT;
    const allDeleted = [];
    for (const channelId of channelIds) {
        try {
            allDeleted.push(...await scanChannelForDuplicates(bot, channelId, limit));
        } catch (error) {
            auditLog('dedupe_scan_error', `Dedupe scan failed for ${channelId}`, {
                channelId, errorMessage: error.message, errorCode: error.code || null
            }, 'warn');
        }
        await sleep(DEDUPE_SCAN_STAGGER_MS);
    }
    if (allDeleted.length > 0) {
        const summary = allDeleted.map((d) => `"${d.title}" in <#${d.channelId}>`).join(', ');
        await bot.sendLogMessage(`🧹 Anti-duplicate sweep removed ${allDeleted.length} duplicate post(s): ${summary}`);
    }
    return allDeleted;
}

// ---------- Commands ----------

async function handleDedupe(bot, interaction) {
    const channelOption = interaction.options.getChannel('channel');
    const limitOption = interaction.options.getInteger('limit');
    const limit = (limitOption && limitOption > 0) ? limitOption : DEDUPE_SCAN_MESSAGE_LIMIT;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channelIds = channelOption ? [channelOption.id] : liveChannelIds(bot);
    if (channelIds.length === 0) return interaction.editReply({ content: '❌ No live channels are configured.' });

    const deleted = await scanAllLiveChannelsForDuplicates(bot, { channelIds, limit });
    if (deleted.length === 0) return interaction.editReply({ content: `✅ Scanned ${channelIds.length} channel(s) (last ${limit}) — no duplicates.` });
    const lines = deleted.map((d) => `• "${d.title}" removed from <#${d.channelId}>`);
    await interaction.editReply({ content: `🧹 Removed ${deleted.length} duplicate(s):\n${lines.join('\n')}`.slice(0, 1900) });
}

async function handlePublishPrevious(bot, interaction) {
    const channelOption = interaction.options.getChannel('channel');
    const amountOption = interaction.options.getInteger('amount');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channelIds = channelOption ? [channelOption.id] : liveChannelIds(bot);
    if (channelIds.length === 0) return interaction.editReply({ content: '❌ No live channels are configured.' });

    const publishResult = await require('./autopublish').publishPreviousInChannels(bot, channelIds, amountOption || null);
    const scope = amountOption ? `last ${amountOption}` : 'entire history';
    await interaction.editReply({
        content: `📢 Publish-previous complete (${scope}).\nTotal: ${publishResult.deleted} dupe(s) removed, ${publishResult.published} published, ${publishResult.skipped} skipped.`.slice(0, 1900)
    });
    await bot.sendLogMessage(`📢 /publish-previous by ${interaction.user.tag} (${scope}) — ${publishResult.deleted} dupe(s), ${publishResult.published} published.`);
}

const definitions = [
    new SlashCommandBuilder().setName('dedupe').setDescription('Scan live channels for duplicate posts and remove extras')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Scan only this channel').setRequired(false))
        .addIntegerOption((opt) => opt.setName('limit').setDescription('How many recent messages to check per channel (default 7)').setRequired(false)),
    new SlashCommandBuilder().setName('publish-previous').setDescription('Dedupe, then publish (crosspost) previous live posts')
        .addChannelOption((opt) => opt.setName('channel').setDescription('Only this channel').setRequired(false))
        .addIntegerOption((opt) => opt.setName('amount').setDescription('How many recent messages to consider (default: ALL)').setRequired(false))
];

const handlers = { dedupe: handleDedupe, 'publish-previous': handlePublishPrevious };

module.exports = {
    definitions,
    handlers,
    DEDUPE_SCAN_MESSAGE_LIMIT,
    PUBLISH_PREVIOUS_PAGE_SIZE,
    PUBLISH_PREVIOUS_HARD_CAP,
    PUBLISH_PREVIOUS_CROSSPOST_PAUSE_MS,
    sleep,
    liveChannelIds,
    filterToBotFormattedMessages,
    fetchBotMessages,
    deleteDuplicateMessages,
    scanChannelForDuplicates,
    scanAllLiveChannelsForDuplicates
};
