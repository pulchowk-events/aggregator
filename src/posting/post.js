// src/posting/post.js
// postEventToCategory — the SINGLE choke point for every Discord post.
//
// Every caller routes here:
//   - manual "Post to Live" / "Post to Test" button (bot.js handleConfirmPost)
//   - autopost tick (per-track per-mode)
//   - dashboard /api/send-event
//   - test -> live auto-promotion sweep (currently disabled)
//
// Two guarantees this function exists to provide:
//
//   1. No duplicate post can go out to the same (item, channel) pair. The
//      marker file acts as the lock: reserve() uses wx (fails if exists),
//      and the only way to release a reservation is a confirmed delete
//      (reconciliation) or a failed send. Two concurrent callers can't
//      both win the reserve.
//
//   2. Every attempt is audited, win or lose. The category-implied
//      outcome (success / already_posted / no_image / data_quality_warning
//      / category_paused / send_failed / no_channel / in_progress) is
//      written to audit-log.jsonl in every branch.
//
// Category pause is handled at this layer (not by callers) because it's
// mode === 'main' specific — a paused category still allows test posts.
//
// All four gates run BEFORE reserve — the marker is expensive to lose if
// the gates would have rejected anyway:
//   - category paused
//   - has-valid-image (live only; scholarships exempt)
//   - has-data-quality-warnings (live only; force bypasses)
//   - dedup (marker existence / stale reconciliation)

const axios = require('axios');
const { AttachmentBuilder } = require('discord.js');
const { auditLog } = require('../core/auditLogger');
const markers = require('../core/markers');
const { sanitizeEventFields } = require('../core/sanitize');
const { buildPostContent } = require('../core/formatting');
const { hasValidImage, shouldPingForEvent, hasDataQualityWarnings } = require('./gates');
const { hasBeenPostedToChannel, lastPostedToChannelAt } = require('./reconcile');
const { getPingMention } = require('../config/roles');

const IMAGE_FETCH_TIMEOUT_MS = 15000;
const IMAGE_FETCH_UA = 'Mozilla/5.0 (compatible; PulchowkEventsBot/1.0)';

// Helper: does this category have a paused flag set in cache?
function isCategoryPaused(bot, categoryKey) {
    return Boolean((bot.cache.settings.pausedCategories || {})[categoryKey]);
}

// Channel id resolver. Uses bot.CATEGORIES (populated from config/env at
// bot construction time). Returns null if the category/mode combo has no
// channel configured.
function resolveChannelId(bot, categoryKey, mode) {
    const cat = bot.CATEGORIES && bot.CATEGORIES[categoryKey];
    if (!cat) return null;
    return mode === 'main' ? cat.main : cat.test;
}

// Main entry point.
//
// Returns one of:
//   { ok: true }
//   { ok: false, reason: 'no_category' }
//   { ok: false, reason: 'no_channel' }
//   { ok: false, reason: 'no_image' }
//   { ok: false, reason: 'data_quality_warning', warnings }
//   { ok: false, reason: 'already_posted', lastPostedAt }
//   { ok: false, reason: 'in_progress' }
//   { ok: false, reason: 'already_posted_or_racing' }
//   { ok: false, reason: 'category_paused' }
//   { ok: false, reason: 'send_failed', error }
async function postEventToCategory(bot, event, mode, categoryKeyOverride = null, force = false) {
    // Re-sanitize before any gate. Customize may have fixed the issue,
    // and this also ensures freshly-rendered messages use clean fields.
    sanitizeEventFields(event);

    const categoryKey = categoryKeyOverride || bot.determineCategory(event);
    const postOutcomeBase = { eventId: event.id || null, title: event.title || null, mode, categoryKey, force };

    // ---------- Category exists? ----------
    if (!bot.CATEGORIES[categoryKey]) {
        console.warn(`No category mapping for event "${event.title}"`);
        await bot.sendLogMessage(`⚠️ No category mapping found for "${event.title}" (resolved category: ${categoryKey}).`);
        auditLog('post_event_outcome', `Post outcome for "${event.title}": failed (no_category)`,
            { ...postOutcomeBase, ok: false, reason: 'no_category' }, 'warn');
        return { ok: false, reason: 'no_category' };
    }

    // ---------- Category paused (LIVE only) ----------
    if (mode === 'main' && isCategoryPaused(bot, categoryKey) && !force) {
        auditLog('post_event_outcome', `Post outcome for "${event.title}": failed (category_paused)`,
            { ...postOutcomeBase, ok: false, reason: 'category_paused' }, 'warn');
        bot.sendLogMessage(`⏸️ Blocked post of "${event.title}" — category **${categoryKey}** is currently paused. Use \`/category resume\` to re-enable.`).catch(() => {});
        return { ok: false, reason: 'category_paused' };
    }

    // ---------- Channel configured? ----------
    const channelId = resolveChannelId(bot, categoryKey, mode);
    if (!channelId) {
        console.warn(`No ${mode} channel for category ${categoryKey}`);
        await bot.sendLogMessage(`⚠️ No ${mode} channel configured for category "${categoryKey}" — cannot post "${event.title}".`);
        auditLog('post_event_outcome', `Post outcome for "${event.title}": failed (no_channel)`,
            { ...postOutcomeBase, ok: false, reason: 'no_channel' }, 'warn');
        return { ok: false, reason: 'no_channel' };
    }

    // ---------- Live gates: image + data quality ----------
    if (mode === 'main' && !hasValidImage(bot, event)) {
        auditLog('post_event_outcome', `Post outcome for "${event.title}": failed (no_image)`,
            { ...postOutcomeBase, channelId, ok: false, reason: 'no_image' }, 'warn');
        return { ok: false, reason: 'no_image' };
    }

    if (mode === 'main' && hasDataQualityWarnings(event) && !force) {
        auditLog('post_event_outcome', `Post outcome for "${event.title}": failed (data_quality_warning)`,
            { ...postOutcomeBase, channelId, ok: false, reason: 'data_quality_warning', warnings: event.dataQualityWarnings }, 'warn');
        return { ok: false, reason: 'data_quality_warning' };
    }

    // ---------- In-flight lock ----------
    // (The marker reservation below is the real dedup lock; this in-memory
    // Set is a cheap fast-path that avoids even the file check for the
    // common case of the same event racing itself within one process.)
    const lockKey = `${event.id}::${channelId}`;
    if (bot.postingLocks.has(lockKey)) {
        auditLog('post_event_outcome', `Post outcome for "${event.title}": failed (in_progress)`,
            { ...postOutcomeBase, channelId, ok: false, reason: 'in_progress' }, 'warn');
        return { ok: false, reason: 'in_progress' };
    }

    // ---------- Dedup: has it already been posted? ----------
    if (!force && await hasBeenPostedToChannel(bot, event, channelId)) {
        const when = lastPostedToChannelAt(bot, event, channelId);
        auditLog('post_event_outcome', `Post outcome for "${event.title}": failed (already_posted)`,
            { ...postOutcomeBase, channelId, ok: false, reason: 'already_posted', lastPostedAt: when }, 'warn');
        return { ok: false, reason: 'already_posted', lastPostedAt: when };
    }

    // ---------- Reserve the marker ----------
    const dedupKey = bot.getEventDedupKey(event);
    const reserved = markers.reserve(dedupKey, channelId, { title: event.title, force });
    if (!reserved) {
        console.warn(`⚠️ Blocked duplicate post for "${event.title}" -> ${channelId} (lost the reservation race, or already posted).`);
        await bot.sendLogMessage(`🚫 Blocked duplicate post: "${event.title}" to <#${channelId}> — already posted or in progress.`);
        auditLog('post_event_outcome', `Post outcome for "${event.title}": failed (already_posted_or_racing)`,
            { ...postOutcomeBase, channelId, ok: false, reason: 'already_posted_or_racing' }, 'warn');
        return { ok: false, reason: 'already_posted_or_racing' };
    }

    bot.postingLocks.add(lockKey);

    try {
        // ---------- Fetch the channel ----------
        let channel;
        try {
            channel = await bot.client.channels.fetch(channelId);
        } catch (fetchError) {
            auditLog('discord_api_error', `channels.fetch(${channelId}) failed while posting "${event.title}"`,
                { ...postOutcomeBase, channelId, errorMessage: fetchError.message, errorCode: fetchError.code || null, errorStack: fetchError.stack, errorRaw: fetchError },
                'error');
            throw fetchError;
        }

        // ---------- Ping decision ----------
        // Set _pingCategoryKey so shouldPingForEvent can check the
        // per-category switch without needing to recompute the category.
        event._pingCategoryKey = categoryKey;
        const shouldPing = mode === 'main' && shouldPingForEvent(bot, event);
        const pingMention = shouldPing ? getPingMention(categoryKey) : null;

        // ---------- Render the message ----------
        const message = buildPostContent(event, pingMention);

        // ---------- Image fetch (with heartbeat refreshes) ----------
        // Refreshes the marker's heartbeatAt right before and after the
        // slow image download so a genuinely-alive-but-slow send never
        // reads as abandoned. Best-effort — a failed heartbeat write is
        // not fatal to the send itself.
        markers.heartbeat(dedupKey, channelId);

        if (hasValidImage(bot, event)) {
            try {
                const response = await axios.get(event.image, {
                    responseType: 'arraybuffer',
                    timeout: IMAGE_FETCH_TIMEOUT_MS,
                    headers: { 'User-Agent': IMAGE_FETCH_UA }
                });
                const buffer = Buffer.from(response.data);
                markers.heartbeat(dedupKey, channelId);
                const attachment = new AttachmentBuilder(buffer, { name: 'event.jpg' });
                await channel.send({ content: message, files: [attachment] });
            } catch (error) {
                console.error('Failed to fetch/send image, sending text only:', error.message);
                auditLog('discord_api_error', `Image fetch/attach failed for "${event.title}", falling back to text-only`,
                    { ...postOutcomeBase, channelId, imageUrl: event.image, errorMessage: error.message, errorCode: error.code || null, errorStack: error.stack, errorRaw: error },
                    'error');
                markers.heartbeat(dedupKey, channelId);
                await channel.send(message);
            }
        } else {
            await channel.send(message);
        }

        // ---------- Success ----------
        markers.confirm(dedupKey, channelId, { title: event.title });
        auditLog('post_event_outcome', `Post outcome for "${event.title}": success`,
            { ...postOutcomeBase, channelId, ok: true });
        return { ok: true };
    } catch (error) {
        // ---------- Send failed ----------
        console.error(`❌ Failed to post event "${event.title}" to channel ${channelId}:`, error);
        await bot.sendLogMessage(`❌ Failed to post "${event.title}" to <#${channelId}>: ${error.message}`);
        auditLog('discord_api_error', `Send failed for "${event.title}" -> channel ${channelId}`,
            { ...postOutcomeBase, channelId, errorMessage: error.message, errorCode: error.code || null, errorStack: error.stack, errorRaw: error },
            'error');
        markers.release(dedupKey, channelId, { title: event.title });
        auditLog('post_event_outcome', `Post outcome for "${event.title}": failed (send_failed)`,
            { ...postOutcomeBase, channelId, ok: false, reason: 'send_failed', errorMessage: error.message }, 'error');
        return { ok: false, reason: 'send_failed', error };
    } finally {
        bot.postingLocks.delete(lockKey);
        // Clean up the transient helper field so it doesn't leak into
        // cache.json on the next save.
        if (event._pingCategoryKey) delete event._pingCategoryKey;
    }
}

module.exports = { postEventToCategory, isCategoryPaused, resolveChannelId };
