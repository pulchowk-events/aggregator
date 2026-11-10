// src/posting/reconcile.js
// Discord-backed verification for stale posted-markers.
//
// The marker file (in core/markers.js) is the authoritative "was this
// posted?" source of truth. But a marker can be in the "reserved" state
// forever if the posting process crashed mid-send — the marker exists,
// no `postedAt` was ever set, and the heartbeat has stopped. Is that a
// live in-flight post, or an abandoned reservation?
//
// We answer by asking Discord itself: fetch the last RECONCILIATION_MESSAGE_
// FETCH_LIMIT messages from the channel, look for one whose content
// contains the item's title. Three outcomes:
//
//   1. Found — the reservation is upgraded to confirmed (post actually went
//      through, we just lost track). NEVER repost.
//   2. Not found — the reservation is cleared, and the caller is free to
//      post. This is the one path where we DELETE a marker file.
//   3. Verification failed (rate limit, permissions, network error, no
//      title to match on) — FAIL CLOSED. The stale reservation is
//      treated as still blocking. Better to skip a real post than to
//      duplicate one.
//
// Every outcome is audited with the full context, so a "why didn't this
// post go through?" question is always answerable after the fact.

const { auditLog } = require('../core/auditLogger');
const markers = require('../core/markers');
const { RECONCILIATION_MESSAGE_FETCH_LIMIT, STALE_RESERVATION_MS } = require('../config/constants');

// Ask Discord whether an event is already posted to a channel, given a
// stale-looking reservation. Never throws — always returns a structured
// verdict { verified, found, messageId?, messageTimestamp?, error? }.
//
// "verified" means the check ran to completion (we can trust "found").
// "found" means the message actually exists on Discord.
async function verifyNotPostedOnDiscord(bot, event, channelId) {
    const baseLogData = {
        eventId: event.id || null,
        title: event.title || null,
        channelId
    };

    if (!bot.client || !bot.client.isReady || !bot.client.isReady()) {
        auditLog('discord_reconciliation',
            `Skipped reconciliation for "${event.title}" -> ${channelId}: client not ready`,
            baseLogData, 'warn');
        return { verified: false, found: false, error: 'client_not_ready' };
    }

    try {
        const channel = await bot.client.channels.fetch(channelId);
        if (!channel) {
            auditLog('discord_reconciliation',
                `Reconciliation for "${event.title}" -> ${channelId}: channel not found`,
                baseLogData, 'warn');
            return { verified: false, found: false, error: 'channel_not_found' };
        }

        const messages = await channel.messages.fetch({ limit: RECONCILIATION_MESSAGE_FETCH_LIMIT });

        const titleSnippet = (event.title || '').trim();
        if (!titleSnippet) {
            auditLog('discord_reconciliation',
                `Reconciliation for "${event.title}" -> ${channelId}: no title to match against`,
                baseLogData, 'warn');
            return { verified: false, found: false, error: 'no_title_to_match' };
        }

        for (const msg of messages.values()) {
            if (msg.content && msg.content.includes(titleSnippet)) {
                auditLog('discord_reconciliation',
                    `Reconciliation for "${event.title}" -> ${channelId}: FOUND existing message — reservation was not abandoned`,
                    { ...baseLogData, messageId: msg.id, messageTimestamp: msg.createdTimestamp },
                    'warn');
                return { verified: true, found: true, messageId: msg.id, messageTimestamp: msg.createdTimestamp };
            }
        }

        auditLog('discord_reconciliation',
            `Reconciliation for "${event.title}" -> ${channelId}: no matching message in last ${RECONCILIATION_MESSAGE_FETCH_LIMIT} — safe to treat reservation as abandoned`,
            baseLogData);
        return { verified: true, found: false };
    } catch (error) {
        auditLog('discord_reconciliation',
            `Reconciliation for "${event.title}" -> ${channelId}: fetch failed (${error.code || 'unknown'})`,
            { ...baseLogData, errorMessage: error.message, errorCode: error.code || null, errorStack: error.stack },
            'error');
        return { verified: false, found: false, error: error.code || error.message };
    }
}

// Has this item already been posted to this channel?
//
// Three cases, in order:
//   1. No marker at all → false (never posted).
//   2. Marker has postedAt → true (confirmed).
//   3. Marker is a reservation. If fresh (heartbeat within
//      STALE_RESERVATION_MS), still in flight → true. If stale, ask
//      Discord (verifyNotPostedOnDiscord). Upgrade or clear based on answer.
//
// Returns true if the item is considered posted (do NOT repost).
// Returns false only after Discord has definitively said "not there".
async function hasBeenPostedToChannel(bot, event, channelId) {
    const dedupKey = bot.getEventDedupKey(event);
    const marker = markers.read(dedupKey, channelId);
    if (!marker) return false;
    if (marker.data.postedAt) return true;

    // Reservation state. If heartbeat is fresh, trust it.
    const lastAlive = marker.data.heartbeatAt || marker.data.reservedAt || 0;
    const age = Date.now() - lastAlive;
    if (age <= STALE_RESERVATION_MS) return true;

    // Stale reservation — ask Discord.
    const reconciliation = await verifyNotPostedOnDiscord(bot, event, channelId);

    if (reconciliation.verified && reconciliation.found) {
        // Upgrade reservation -> confirmed.
        try {
            markers.confirm(dedupKey, channelId, { title: event.title });
            auditLog('discord_reconciliation',
                `Upgraded abandoned-looking reservation to CONFIRMED for "${event.title}" -> ${channelId} after finding it already on Discord`,
                { eventId: event.id || null, title: event.title || null, channelId, messageId: reconciliation.messageId },
                'warn');
        } catch (error) {
            console.warn('⚠️ Could not upgrade reconciled marker to confirmed:', error.message);
        }
        return true;
    }

    if (reconciliation.verified && !reconciliation.found) {
        markers.release(dedupKey, channelId, { title: event.title });
        return false;
    }

    // Verification failed — FAIL CLOSED.
    auditLog('discord_reconciliation',
        `Failing closed for "${event.title}" -> ${channelId}: could not verify via Discord, treating stale reservation as still blocking`,
        { eventId: event.id || null, title: event.title || null, channelId, error: reconciliation.error || null },
        'warn');
    return true;
}

// Timestamp of last confirmed post to this channel, or null.
// Convenience wrapper — never needs the async machinery above.
function lastPostedToChannelAt(bot, event, channelId) {
    const dedupKey = bot.getEventDedupKey(event);
    return markers.lastPostedAt(dedupKey, channelId);
}

module.exports = {
    verifyNotPostedOnDiscord,
    hasBeenPostedToChannel,
    lastPostedToChannelAt
};
