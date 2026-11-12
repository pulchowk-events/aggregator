// src/discord/extensions/autopublish.js
// Auto-publish (crosspost) for new live posts, SEQUENCED AFTER dedupe.
//
// The sequencing matters. Fire-and-forget publishing used to race the
// dedupe sweep — a duplicate could get crossposted before the sweep
// deleted it. Now the post flow is:
//   1. postEventToCategory sends the message (via attachment hook)
//   2. hook calls scanChannelForDuplicates for THAT channel and AWAITS it
//   3. hook checks whether the just-posted message was itself deleted as
//      a duplicate. If yes → do NOT publish.
//   4. If no → publish (crosspost) the new message.
//   5. Independently kick a background sweep of the OTHER live channels.

const { auditLog } = require('../../core/auditLogger');
const {
    DEDUPE_SCAN_MESSAGE_LIMIT,
    scanChannelForDuplicates,
    scanAllLiveChannelsForDuplicates,
    liveChannelIds,
    fetchBotMessages,
    deleteDuplicateMessages,
    sleep,
    PUBLISH_PREVIOUS_CROSSPOST_PAUSE_MS
} = require('./dedupe');

function isAutopublishEnabled(bot) {
    return Boolean(bot.cache.settings.autopublishEnabled);
}

async function tryCrosspost(bot, channelId, message, auditContext = {}) {
    // Log non-crosspostable skips so operators can distinguish "not
    // an announcement channel" from "crosspost failed" from "already
    // published." Without this, /publish-previous counts them as
    // "skipped" with no audit trail.
    if (!message.crosspostable) {
        auditLog('autopublish_skipped', `Message ${message.id} in ${channelId} is not crosspostable`, {
            channelId, messageId: message.id, reason: 'not_crosspostable', ...auditContext
        }, 'info');
        return false;
    }
    try {
        await message.crosspost();
        auditLog('autopublish', `Crossposted ${message.id} in ${channelId}`, { channelId, messageId: message.id, ...auditContext });
        return true;
    } catch (error) {
        auditLog('autopublish_error', `Crosspost failed for ${message.id}`, {
            channelId, messageId: message.id, errorMessage: error.message, errorCode: error.code || null, ...auditContext
        }, 'error');
        return false;
    }
}

// The post-hook sequence. Called from extensions/index.js after
// postEventToCategory succeeds, for LIVE mode only.
async function sequencedPostPublish(bot, event, mode, categoryKey, channelId) {
    if (mode !== 'main') return { published: false, reason: 'not_live_mode' };
    if (!isAutopublishEnabled(bot)) return { published: false, reason: 'disabled' };
    if (!channelId) return { published: false, reason: 'no_channel' };

    // Step 1: fetch the newest message on the channel — that should be the
    // one we just sent, since postEventToCategory serializes per channel.
    let newMessageId = null;
    let newMessage = null;
    try {
        const channel = await bot.client.channels.fetch(channelId);
        const recent = await channel.messages.fetch({ limit: 1 });
        newMessage = recent.first();
        newMessageId = newMessage ? newMessage.id : null;
    } catch (error) {
        return { published: false, reason: 'fetch_failed', error: error.message };
    }
    if (!newMessageId) return { published: false, reason: 'no_message_found' };

    // Step 2: dedupe THIS channel (await it, not fire-and-forget).
    const deleted = await scanChannelForDuplicates(bot, channelId, DEDUPE_SCAN_MESSAGE_LIMIT);
    const wasDeleted = deleted.some((d) => d.messageId === newMessageId);

    if (wasDeleted) {
        auditLog('autopublish_skipped', `Skipped autopublish for "${event.title}" — new message removed as duplicate`, {
            channelId, eventId: event.id || null, title: event.title || null
        }, 'warn');
        return { published: false, reason: 'was_duplicate' };
    }

    // Step 3: publish.
    try {
        const channel = await bot.client.channels.fetch(channelId);
        newMessage = await channel.messages.fetch(newMessageId);
    } catch (error) {
        return { published: false, reason: 'refetch_failed', error: error.message };
    }

    const published = await tryCrosspost(bot, channelId, newMessage, { eventId: event.id, title: event.title, trigger: 'post_hook' });

    // Step 4 (background, non-gating): sweep the OTHER live channels.
    scanAllLiveChannelsForDuplicates(bot, {
        channelIds: liveChannelIds(bot).filter((id) => id !== channelId)
    }).catch((err) => console.error('❌ Background dedupe scan failed:', err));

    return { published, reason: published ? 'ok' : 'crosspost_failed' };
}

// /publish-previous helper — dedupe a set of channels (small window OR
// entire history), then crosspost every survivor that's eligible.
async function publishPreviousInChannels(bot, channelIds, amount) {
    let totalDeleted = 0;
    let totalPublished = 0;
    let totalSkipped = 0;

    for (const channelId of channelIds) {
        try {
            const channel = await bot.client.channels.fetch(channelId);
            if (!channel || !channel.isTextBased()) continue;

            const botMessages = await fetchBotMessages(bot, channel, amount);
            const deleted = await deleteDuplicateMessages(bot, channelId, botMessages);
            const deletedIds = new Set(deleted.map((d) => d.messageId));
            const survivors = botMessages.filter((m) => !deletedIds.has(m.id));

            let publishedHere = 0;
            let skippedHere = 0;
            for (const msg of survivors) {
                const ok = await tryCrosspost(bot, channelId, msg, { trigger: 'publish_previous' });
                if (ok) {
                    publishedHere++;
                    await sleep(PUBLISH_PREVIOUS_CROSSPOST_PAUSE_MS);
                } else {
                    skippedHere++;
                }
            }
            totalDeleted += deleted.length;
            totalPublished += publishedHere;
            totalSkipped += skippedHere;
        } catch (error) {
            console.error(`❌ [autopublish] publish-previous failed for ${channelId}:`, error.message);
        }
    }

    return { deleted: totalDeleted, published: totalPublished, skipped: totalSkipped };
}

module.exports = {
    isAutopublishEnabled,
    tryCrosspost,
    sequencedPostPublish,
    publishPreviousInChannels
};
