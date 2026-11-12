// src/posting/pipeline.js
// The scrape -> cache pipeline. Turns scrapeAll's items[] into
// pending/posted/skipped/expired cache transitions.
//
// Entry point: processScrapedEvents(bot, events, errors)
//   Called from bot.scrapeAndNotify() after scrapeAll returns. Runs under
//   the cache mutex (the caller wraps it). Classifies every scraped item
//   as:
//     already-posted      — dedup key hit postedEventKeys
//     already-pending     — dedup key hit pendingEvents
//     already-skipped     — dedup key hit skippedEvents
//     already-expired     — dedup key hit expiredEvents
//     already-pending-fuzzy-same-source — fuzzy title match + same source
//                          (same source re-emitted it — treat as pending)
//     new-possible-duplicate — fuzzy title match but DIFFERENT source
//                          (flag with data-quality warning, still add to
//                          pending so a human can review)
//     new                 — genuinely new
//
// Only 'new' and 'new-possible-duplicate' items get pushed to
// pendingEvents. Everything else is dropped silently from this batch (the
// audit log records WHY).
//
// Plus three cache-maintenance sweeps:
//   purgeExpiredPendingEvents    — past-dated items out of pending
//   purgeStuckNeedsAttentionEvents — items stuck with warnings/image-missing
//                                    past the expiry window out of pending
//   reconcilePendingAgainstMarkers — orphaned pending items that actually
//                                    have a confirmed marker on disk get
//                                    moved to posted on startup

const { auditLog } = require('../core/auditLogger');
const { isEventPast } = require('../core/dateUtils');
const { sanitizeEventFields } = require('../core/sanitize');
const { getEventDedupKey, findFuzzyDuplicateMatch, deduplicateEventsByKey } = require('./dedup');
const { hasValidImage, hasDataQualityWarnings } = require('./gates');
const markers = require('../core/markers');
const { CACHE_CAP, NEEDS_ATTENTION_EXPIRY_DAYS, DEFAULT_NEEDS_ATTENTION_EXPIRY_DAYS } = require('../config/constants');

// ---------- Cache maintenance sweeps ----------

// Move past-dated items from pendingEvents to expiredEvents (capped).
// Called on boot AND on every scrapeAndNotify pass.
function purgeExpiredPendingEvents(bot) {
    const stillPending = [];
    const justExpired = [];
    for (const event of bot.cache.pendingEvents) {
        if (isEventPast(event)) {
            justExpired.push(event);
        } else {
            stillPending.push(event);
        }
    }
    if (justExpired.length === 0) return 0;

    bot.cache.pendingEvents = stillPending;
    bot.cache.expiredEvents = bot.cache.expiredEvents || [];
    bot.cache.expiredEvents.push(...justExpired);
    if (bot.cache.expiredEvents.length > CACHE_CAP) {
        bot.cache.expiredEvents = bot.cache.expiredEvents.slice(-CACHE_CAP);
    }
    bot.saveCache();
    return justExpired.length;
}

// How many days before stuck items get archived? Overridable at runtime.
function getNeedsAttentionExpiryDays(bot) {
    const v = bot.cache.settings.needsAttentionExpiryDays;
    return Number.isFinite(v) && v >= 0 ? v : (NEEDS_ATTENTION_EXPIRY_DAYS || DEFAULT_NEEDS_ATTENTION_EXPIRY_DAYS);
}

// "Stuck" = flagged with data-quality warnings, OR missing a valid image
// (scholarships exempt from the image half). These can never clear the
// gates on their own and would accumulate in pending forever if no human
// visits /pending.
function isStuckNeedsAttentionEvent(bot, event) {
    if (event.itemType === 'scholarship') {
        return hasDataQualityWarnings(event);
    }
    return hasDataQualityWarnings(event) || !hasValidImage(bot, event);
}

// Move stuck items past the expiry window into needsAttentionExpiredEvents.
// NOT a delete — fully recoverable, and NEVER auto-live-posted.
function purgeStuckNeedsAttentionEvents(bot) {
    const expiryMs = getNeedsAttentionExpiryDays(bot) * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const stillPending = [];
    const justArchived = [];

    for (const event of bot.cache.pendingEvents) {
        const stuck = isStuckNeedsAttentionEvent(bot, event);
        const age = event.firstSeenAt ? (now - event.firstSeenAt) : 0;
        if (stuck && event.firstSeenAt && age >= expiryMs) {
            justArchived.push(event);
        } else {
            stillPending.push(event);
        }
    }

    if (justArchived.length === 0) return 0;

    bot.cache.pendingEvents = stillPending;
    bot.cache.needsAttentionExpiredEvents = bot.cache.needsAttentionExpiredEvents || [];
    for (const event of justArchived) {
        event.needsAttentionExpiredAt = now;
        event.needsAttentionExpiredReason = hasDataQualityWarnings(event) ? 'data_quality_warnings' : 'no_valid_image';
    }
    bot.cache.needsAttentionExpiredEvents.push(...justArchived);
    if (bot.cache.needsAttentionExpiredEvents.length > CACHE_CAP) {
        bot.cache.needsAttentionExpiredEvents = bot.cache.needsAttentionExpiredEvents.slice(-CACHE_CAP);
    }
    bot.saveCache();

    auditLog('needs_attention_expiry',
        `Archived ${justArchived.length} permanently-stuck event(s) into needs-attention-expired bucket`,
        { count: justArchived.length, expiryDays: getNeedsAttentionExpiryDays(bot),
          events: justArchived.map((e) => ({ id: e.id || null, title: e.title || null, reason: e.needsAttentionExpiredReason })) },
        'warn');
    return justArchived.length;
}

// ---------- Startup reconciliation ----------

// A crash between "confirm marker" and "remove from pendingEvents" leaves
// an item stuck in pending with a confirmed marker on disk. On boot, find
// these and move them to posted.
function reconcilePendingAgainstMarkers(bot, channelIds) {
    const stillPending = [];
    const reconciledEvents = [];

    for (const event of bot.cache.pendingEvents) {
        const dedupKey = getEventDedupKey(event);
        let confirmedChannelId = null;
        let confirmedAt = null;

        for (const channelId of channelIds) {
            const m = markers.read(dedupKey, channelId);
            if (m && m.data.postedAt) {
                confirmedChannelId = channelId;
                confirmedAt = m.data.postedAt;
                break;
            }
        }

        if (confirmedChannelId) {
            reconciledEvents.push(event);
            auditLog('startup_reconciliation',
                `"${event.title}" was stuck in pendingEvents but already has a CONFIRMED marker for channel ${confirmedChannelId} — moving to postedEvents`,
                { eventId: event.id || null, title: event.title || null, channelId: confirmedChannelId, postedAt: confirmedAt,
                  reason: 'orphaned_pending_after_confirmed_post' },
                'warn');
        } else {
            stillPending.push(event);
        }
    }

    if (reconciledEvents.length === 0) return 0;

    bot.cache.pendingEvents = stillPending;
    for (const event of reconciledEvents) {
        bot.markEventPosted(event);
    }
    bot.saveCache();
    return reconciledEvents.length;
}

// ---------- Main pipeline ----------

// Classify and route every scraped item. Caller must already hold the
// cache mutex (bot.scrapeAndNotify wraps this).
function processScrapedEvents(bot, events, errors) {
    // Defensive: filter out null/undefined/non-object entries ONCE at
    // function entry. Some callers may pass arrays from a source whose
    // .filter(Boolean) step was missed. Multiple downstream loops iterate
    // over `events` and read `e.id` — a single null would crash the whole
    // scrape pipeline (caught only by the audit log, not visible to
    // operators until they check /status).
    if (!Array.isArray(events)) events = [];
    events = events.filter((e) => e && typeof e === 'object');

    // ---- recentEvents tracking ----
    const existingIds = new Set(bot.cache.recentEvents.map((e) => e.id));
    const newScraped = events.filter((e) => !existingIds.has(e.id));
    bot.cache.recentEvents = [...bot.cache.recentEvents, ...newScraped];
    if (bot.cache.recentEvents.length > 100) {
        bot.cache.recentEvents = bot.cache.recentEvents.slice(-100);
    }

    // ---- classification ----
    const postedKeys = new Set(bot.cache.postedEventKeys);
    const pendingKeys = new Set(bot.cache.pendingEvents.map((e) => getEventDedupKey(e)));
    const skippedKeys = new Set(bot.cache.skippedEvents.map((e) => getEventDedupKey(e)));
    const expiredKeys = new Set((bot.cache.expiredEvents || []).map((e) => getEventDedupKey(e)));

    const newEvents = [];
    for (const e of events) {
        // Defensive: some callers may pass arrays containing null/undefined
        // (a failed extractor's .filter(Boolean) somewhere might be missed).
        // Skip rather than crash the whole pipeline.
        if (!e || typeof e !== 'object') continue;

        const key = getEventDedupKey(e);
        let classification;
        if (postedKeys.has(key)) classification = 'already-posted';
        else if (pendingKeys.has(key)) classification = 'already-pending';
        else if (skippedKeys.has(key)) classification = 'already-skipped';
        else if (expiredKeys.has(key)) classification = 'already-expired';
        else classification = 'new';

        let fuzzyMatch = null;
        if (classification === 'new') {
            const candidatePool = bot.cache.pendingEvents.concat(bot.cache.postedEvents, newEvents);
            fuzzyMatch = findFuzzyDuplicateMatch(e, candidatePool);
            if (fuzzyMatch) {
                const sameSource = Boolean(fuzzyMatch.candidate.source) && fuzzyMatch.candidate.source === e.source;
                if (sameSource) {
                    classification = 'already-pending-fuzzy-same-source';
                } else {
                    classification = 'new-possible-duplicate';
                }
            }
        }

        auditLog('dedup_decision', `"${e.title}" classified as ${classification}`, {
            eventId: e.id || null, title: e.title || null, source: e.source || null,
            dedupKey: key, classification, event: e,
            fuzzyMatch: fuzzyMatch ? {
                candidateId: fuzzyMatch.candidate.id || null,
                candidateTitle: fuzzyMatch.candidate.title || null,
                candidateSource: fuzzyMatch.candidate.source || null,
                similarity: fuzzyMatch.similarity
            } : null
        });

        if (classification === 'new') {
            newEvents.push(e);
            // Track this key so a second item in the SAME batch with the same
            // canonical key is caught by the 'already-pending' branch. Without
            // this, duplicate items within one scrape slip through.
            pendingKeys.add(key);
        } else if (classification === 'new-possible-duplicate') {
            e.dataQualityWarnings = (e.dataQualityWarnings || []).concat([
                `Possible duplicate: title is very similar ("${Math.round(fuzzyMatch.similarity * 100)}%" match) to "${fuzzyMatch.candidate.title}" (source: ${fuzzyMatch.candidate.source || 'unknown'}) on the same date — flagged for manual review, not auto-merged.`
            ]);
            newEvents.push(e);
            pendingKeys.add(key);
        }
    }

    // Filter out already-pending-by-id (defensive against id collisions
    // despite distinct dedup keys — shouldn't happen but cheap to guard).
    const pendingIds = new Set(bot.cache.pendingEvents.map((e) => e.id));
    const newEventsUnique = newEvents.filter((e) => !pendingIds.has(e.id));

    // ---- early return: nothing new ----
    if (newEventsUnique.length === 0) {
        bot.cache.lastCheck = Date.now();
        bot.saveCache();
        return { newEvents: 0, errors: errors.length, newEventsArray: [] };
    }

    // ---- assign ids / firstSeenAt / sanitize / push ----
    for (const e of newEventsUnique) {
        e.id = e.id || `event_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        e.firstSeenAt = e.firstSeenAt || Date.now();
        sanitizeEventFields(e);
        bot.cache.pendingEvents.push(e);
    }

    bot.cache.lastCheck = Date.now();
    bot.saveCache();

    const flaggedCount = newEventsUnique.filter((e) => hasDataQualityWarnings(e)).length;
    return {
        newEvents: newEventsUnique.length,
        errors: errors.length,
        newEventsArray: newEventsUnique,
        flaggedCount
    };
}

module.exports = {
    purgeExpiredPendingEvents,
    purgeStuckNeedsAttentionEvents,
    getNeedsAttentionExpiryDays,
    isStuckNeedsAttentionEvent,
    reconcilePendingAgainstMarkers,
    processScrapedEvents
};
