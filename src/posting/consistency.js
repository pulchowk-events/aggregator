// src/posting/consistency.js
// Cache vs. posted-marker drift detection, plus the daily maintenance cron.
//
// Two independent stores of "was this posted?" exist:
//   - cache.postedEvents (in-memory + cache.json)
//   - posted-channel-markers/*.json (on disk)
//
// These can drift apart:
//   - marker confirmed, crash before removeFromPending → orphaned pending
//     (auto-fixed at boot by pipeline.reconcilePendingAgainstMarkers)
//   - event in postedEvents, no marker on disk → unverifiable; a too-
//     aggressive marker cleanup could produce this
//   - marker confirmed, cache.postedEvents never updated → invisible to
//     /pending and /stats
//
// This module reports drift in BOTH directions. It does NOT auto-fix —
// only the startup reconciliation auto-fixes, and only for the specific
// orphaned-pending case.

const cron = require('node-cron');
const { auditLog } = require('../core/auditLogger');
const markers = require('../core/markers');
const { getEventDedupKey } = require('./dedup');
const { normalizeEventName } = require('../core/normalize');
const { MARKER_RETENTION_MS } = require('../config/constants');

function allConfiguredChannelIds(bot) {
    const out = [];
    if (!bot.CATEGORIES) return out;
    for (const cat of Object.values(bot.CATEGORIES)) {
        if (cat.main) out.push(cat.main);
        if (cat.test) out.push(cat.test);
    }
    return out;
}

function runConsistencyCheck(bot) {
    const channelIds = allConfiguredChannelIds(bot);
    const discrepancies = [];

    // Direction 1: cache says posted, no marker.
    for (const event of bot.cache.postedEvents) {
        const dedupKey = getEventDedupKey(event);
        let foundMarker = false;
        for (const channelId of channelIds) {
            const m = markers.read(dedupKey, channelId);
            if (m && m.data.postedAt) { foundMarker = true; break; }
        }
        if (!foundMarker) {
            discrepancies.push({
                type: 'cache_posted_event_has_no_marker',
                eventId: event.id || null,
                title: event.title || null,
                dedupKey
            });
        }
    }

    // Direction 2: marker confirmed, title not in postedEventNames.
    const postedNames = new Set(bot.cache.postedEventNames || []);
    for (const marker of markers.readAll()) {
        if (!marker.data.postedAt) continue;
        const normalizedTitle = normalizeEventName(marker.data.title || '');
        if (normalizedTitle && !postedNames.has(normalizedTitle)) {
            discrepancies.push({
                type: 'confirmed_marker_missing_from_cache',
                title: marker.data.title || null,
                channelId: marker.data.channelId || null,
                postedAt: marker.data.postedAt,
                markerFile: marker.file
            });
        }
    }

    if (discrepancies.length > 0) {
        auditLog('consistency_check',
            `Found ${discrepancies.length} discrepancy(ies) between cache.postedEvents and marker files`,
            { discrepancies }, 'warn');
    } else {
        auditLog('consistency_check',
            'No discrepancies between cache.postedEvents and marker files', {});
    }
    return discrepancies;
}

function scheduleConsistencyCheck(bot) {
    if (bot.consistencyCheckCronTask) bot.consistencyCheckCronTask.stop();
    const expr = '0 3 * * *';
    bot.consistencyCheckCronTask = cron.schedule(expr, () => {
        console.log('🔎 Running scheduled cache/marker consistency check...');
        try {
            runConsistencyCheck(bot);
        } catch (error) {
            console.error('❌ Scheduled consistency check failed:', error);
        }
        try {
            const removed = markers.cleanupStaleMarkers(MARKER_RETENTION_MS);
            if (removed > 0) console.log(`🧹 Marker cleanup removed ${removed} marker file(s).`);
        } catch (error) {
            console.error('❌ Scheduled marker cleanup failed:', error);
        }
        try {
            const pipeline = require('./pipeline');
            const archived = pipeline.purgeStuckNeedsAttentionEvents(bot);
            if (archived > 0) {
                bot.sendLogMessage(
                    `🗄️ Daily sweep archived ${archived} permanently-stuck event(s) (data-quality warnings / no image, unresolved for ${pipeline.getNeedsAttentionExpiryDays(bot)}+ days).`
                ).catch((err) => console.error('❌ Failed to send needs-attention-expiry log message:', err));
            }
        } catch (error) {
            console.error('❌ Scheduled needs-attention-expiry sweep failed:', error);
        }
    });
    console.log(`🔎 Cache/marker consistency check scheduled with cron "${expr}"`);
}

module.exports = {
    runConsistencyCheck,
    scheduleConsistencyCheck,
    allConfiguredChannelIds
};
