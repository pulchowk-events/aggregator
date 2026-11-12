// src/core/cache.js
// Cache lifecycle: load from disk, save debounced + atomic, corrupt-file
// quarantine, plus the two common cache mutations that every path needs
// (mark posted, remove pending).
//
// Every function takes `bot` (the EventsBot instance) as its first arg —
// keeps them stateless and testable, while still letting the caller reach
// bot.cache / bot.cacheMutex / bot._cacheDirty as needed.

const fs = require('fs');
const path = require('path');
const { auditLog } = require('./auditLogger');
const { deduplicateEventsByKey, getEventDedupKey } = require('../posting/dedup');
const { normalizeEventName } = require('./normalize');
const { LOGS_CHANNEL_ID, CACHE_SAVE_DEBOUNCE_MS } = require('../config/env');
const { CACHE_CAP } = require('../config/constants');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');

function ensureDataDir() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (e) {
        console.error('❌ Failed to create data directory:', e);
    }
}

// Rename a corrupt cache to cache.json.bak.<timestamp> so we preserve it
// for forensics while starting fresh. Returns the backup path (or null on
// failure).
function quarantineCorruptCacheFile() {
    try {
        const backupPath = `${CACHE_FILE}.bak.${Date.now()}`;
        fs.renameSync(CACHE_FILE, backupPath);
        return backupPath;
    } catch (e) {
        return null;
    }
}

// Normalize the parsed cache object — every array present, settings
// defaults filled in, pendingEvents deduped and backfilled with
// firstSeenAt (needed by the needs-attention expiry sweep).
function loadCache(bot) {
    ensureDataDir();
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const data = fs.readFileSync(CACHE_FILE, 'utf8');
            const cache = JSON.parse(data);

            // Structural defaults.
            cache.pendingEvents = cache.pendingEvents || [];
            cache.postedEvents = cache.postedEvents || [];
            cache.skippedEvents = cache.skippedEvents || [];
            cache.recentEvents = cache.recentEvents || [];
            cache.expiredEvents = cache.expiredEvents || [];
            cache.needsAttentionExpiredEvents = cache.needsAttentionExpiredEvents || [];
            cache.settings = cache.settings || { logsChannelId: LOGS_CHANNEL_ID };
            cache.settings.autopostDeliberateStop = cache.settings.autopostDeliberateStop || {};
            cache.settings.pingEnabled = cache.settings.pingEnabled !== false;
            cache.settings.pingKeywords = cache.settings.pingKeywords || [];
            cache.settings.categoryPingEnabled = cache.settings.categoryPingEnabled || {};
            cache.lastEventIds = cache.lastEventIds || [];
            cache.postedEventNames = cache.postedEventNames || [];
            cache.postedEventKeys = cache.postedEventKeys || [];
            cache.lastCheck = cache.lastCheck || 0;

            // Dedup by canonical key (defensive — sometimes two pending
            // items slip in with the same key across scraper restarts).
            cache.pendingEvents = deduplicateEventsByKey(cache.pendingEvents);

            // Backfill firstSeenAt (needed by needs-attention sweep) and
            // dedupe already-duplicated warnings on disk.
            const now = Date.now();
            for (const event of cache.pendingEvents) {
                if (!event.firstSeenAt) event.firstSeenAt = now;
                if (Array.isArray(event.dataQualityWarnings)) {
                    event.dataQualityWarnings = Array.from(new Set(event.dataQualityWarnings));
                }
            }

            return cache;
        }
    } catch (error) {
        console.error('Error loading cache:', error);
        const backupPath = quarantineCorruptCacheFile();
        console.error(`⚠️ Cache load failed — starting from an EMPTY cache. Corrupt file quarantined to: ${backupPath || '(quarantine also failed)'}`);
        auditLog(
            'cache_corruption_fallback',
            `Cache load failed (${error.message}) — bot is starting from a FRESH EMPTY CACHE. Corrupt file quarantined to ${backupPath || '(quarantine failed)'}.`,
            { errorMessage: error.message, errorStack: error.stack, quarantinedTo: backupPath },
            'error'
        );
    }

    // Fresh state.
    return {
        pendingEvents: [],
        postedEvents: [],
        skippedEvents: [],
        recentEvents: [],
        expiredEvents: [],
        needsAttentionExpiredEvents: [],
        settings: { logsChannelId: LOGS_CHANNEL_ID, autopostDeliberateStop: {} },
        lastCheck: 0,
        lastEventIds: [],
        postedEventNames: [],
        postedEventKeys: []
    };
}

// Atomic write: temp file + rename. Debounced timer is cleared first, so
// a scheduled save isn't left dangling after a manual flush.
function flushCacheToDisk(bot) {
    if (bot._saveCacheTimer) {
        clearTimeout(bot._saveCacheTimer);
        bot._saveCacheTimer = null;
    }
    if (!bot._cacheDirty) return;
    try {
        ensureDataDir();
        const tmpFile = `${CACHE_FILE}.tmp`;
        fs.writeFileSync(tmpFile, JSON.stringify(bot.cache, null, 2));
        fs.renameSync(tmpFile, CACHE_FILE);
        bot._cacheDirty = false;
    } catch (error) {
        console.error('Error saving cache:', error);
    }
}

// Debounced save. Multiple rapid mutations collapse into one disk write
// CACHE_SAVE_DEBOUNCE_MS later.
function saveCache(bot) {
    bot._cacheDirty = true;
    if (bot._saveCacheTimer) return;
    bot._saveCacheTimer = setTimeout(() => flushCacheToDisk(bot), CACHE_SAVE_DEBOUNCE_MS);
    if (bot._saveCacheTimer.unref) bot._saveCacheTimer.unref();
}

function flushCacheSync(bot) {
    flushCacheToDisk(bot);
}

// ---------- Common cache mutations ----------

function removeFromPending(bot, eventId) {
    bot.cache.pendingEvents = bot.cache.pendingEvents.filter((e) => e.id !== eventId);
}

// Move an item from pending → posted: push to postedEvents, register its
// dedup key, its name, its id. Every tracking array is capped at CACHE_CAP
// (oldest dropped) so cache.json can't grow unbounded.
function markEventPosted(bot, event) {
    // Idempotent: a crash between removeFromPending and this call leaves the
    // event in pending, and startup reconciliation will re-markEventPosted
    // after finding the confirmed marker. Without this guard the postedEvents
    // array would accumulate duplicate entries. postedEventKeys is the
    // canonical "already posted" set; check that first.
    const key = getEventDedupKey(event);
    if (!bot.cache.postedEventKeys.includes(key)) {
        bot.cache.postedEvents.push(event);
        bot.cache.postedEventKeys.push(key);
    }

    const name = normalizeEventName(event.title || '');
    if (name && !bot.cache.postedEventNames.includes(name)) {
        bot.cache.postedEventNames.push(name);
    }
    if (event.id && !bot.cache.lastEventIds.includes(event.id)) {
        bot.cache.lastEventIds.push(event.id);
    }

    if (bot.cache.postedEventNames.length > CACHE_CAP) bot.cache.postedEventNames = bot.cache.postedEventNames.slice(-CACHE_CAP);
    if (bot.cache.lastEventIds.length > CACHE_CAP)     bot.cache.lastEventIds     = bot.cache.lastEventIds.slice(-CACHE_CAP);
    if (bot.cache.postedEvents.length > CACHE_CAP)     bot.cache.postedEvents     = bot.cache.postedEvents.slice(-CACHE_CAP);
    if (bot.cache.postedEventKeys.length > CACHE_CAP)  bot.cache.postedEventKeys  = bot.cache.postedEventKeys.slice(-CACHE_CAP);
}

// Cap-enforced push to skippedEvents. Used by /skip and the blacklist
// filter, both of which can accumulate unbounded entries in a long-running
// deployment.
function pushToSkipped(bot, event) {
    bot.cache.skippedEvents = bot.cache.skippedEvents || [];
    bot.cache.skippedEvents.push(event);
    if (bot.cache.skippedEvents.length > CACHE_CAP) {
        bot.cache.skippedEvents = bot.cache.skippedEvents.slice(-CACHE_CAP);
    }
}

module.exports = {
    CACHE_FILE,
    loadCache,
    saveCache,
    flushCacheSync,
    flushCacheToDisk,
    quarantineCorruptCacheFile,
    removeFromPending,
    markEventPosted,
    pushToSkipped
};
