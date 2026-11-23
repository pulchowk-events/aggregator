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

// postedEvents over the cap: drop the oldest items, but keep unexpired jobs and
// scholarships. The website sync deletes any site row whose item is missing from
// postedEvents, so trimming a live one removes it from the public site.
// POSTED_HARD_CAP bounds growth if too many items stay live.
const POSTED_HARD_CAP = CACHE_CAP * 2;
function isLiveWebsiteItem(bot, e) {
    if (!e || (e.itemType !== 'job' && e.itemType !== 'scholarship')) return false;
    try { return !(bot && typeof bot.isEventPast === 'function' && bot.isEventPast(e)); } catch (_) { return false; }
}
function trimPostedEvents(bot) {
    const arr = bot.cache.postedEvents;
    if (!Array.isArray(arr) || arr.length <= CACHE_CAP) return;
    let excess = arr.length - CACHE_CAP;
    const drop = new Set();
    for (let i = 0; i < arr.length && excess > 0; i++) {
        if (isLiveWebsiteItem(bot, arr[i])) continue;
        drop.add(i);
        excess--;
    }
    let next = arr.filter((_, i) => !drop.has(i));
    if (next.length > POSTED_HARD_CAP) {
        const cut = next.length - POSTED_HARD_CAP;
        const lost = next.slice(0, cut).filter((e) => isLiveWebsiteItem(bot, e));
        if (lost.length > 0) warnLiveDropped(bot, lost, cut);
        next = next.slice(-POSTED_HARD_CAP);
    }
    bot.cache.postedEvents = next;
}

// The hard ceiling drops the oldest items even when they are live, which
// removes their website rows on the next sync. Never do that quietly.
let lastLiveDropWarnAt = 0;
const LIVE_DROP_WARN_INTERVAL_MS = 10 * 60 * 1000;
function warnLiveDropped(bot, lost, cut) {
    const sample = lost.slice(0, 5).map((e) => (e.itemType || '?') + ':' + String(e.title || e.id || '?').slice(0, 40)).join(' | ');
    const msg = 'postedEvents hard ceiling (' + POSTED_HARD_CAP + ') dropped ' + lost.length + ' live job/scholarship item(s) of ' + cut + ' cut; their website rows may be pruned. Sample: ' + sample;
    console.warn('[cache] WARNING ' + msg);
    const now = Date.now();
    if (now - lastLiveDropWarnAt >= LIVE_DROP_WARN_INTERVAL_MS && bot && typeof bot.sendLogMessage === 'function') {
        lastLiveDropWarnAt = now;
        try { Promise.resolve(bot.sendLogMessage('WARNING: ' + msg)).catch(() => {}); } catch (_) { /* logging only */ }
    }
}

// postedEventKeys / postedEventNames / lastEventIds: trim oldest first, but never
// drop the entry of an item that is still in postedEvents. A live item whose
// key fell off would look new to the already-posted check and be pushed again.
// Result is bounded by POSTED_HARD_CAP.
function trimKeepingProtected(arr, keep) {
    if (!Array.isArray(arr) || arr.length <= CACHE_CAP) return arr;
    let excess = arr.length - CACHE_CAP;
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        if (excess > 0 && !keep.has(arr[i])) { excess--; continue; }
        out.push(arr[i]);
    }
    return out.length > POSTED_HARD_CAP ? out.slice(-POSTED_HARD_CAP) : out;
}
function trimTrackingArrays(bot) {
    const c = bot.cache;
    const over = (a) => Array.isArray(a) && a.length > CACHE_CAP;
    if (!over(c.postedEventKeys) && !over(c.postedEventNames) && !over(c.lastEventIds)) return;
    const posted = Array.isArray(c.postedEvents) ? c.postedEvents : [];
    const keepKeys = new Set();
    const keepNames = new Set();
    const keepIds = new Set();
    for (const e of posted) {
        if (!e) continue;
        try { keepKeys.add(getEventDedupKey(e)); } catch (_) { /* unkeyable item: not protected */ }
        const n = normalizeEventName(e.title || '');
        if (n) keepNames.add(n);
        if (e.id) keepIds.add(e.id);
    }
    if (Array.isArray(c.postedEventKeys)) c.postedEventKeys = trimKeepingProtected(c.postedEventKeys, keepKeys);
    if (Array.isArray(c.postedEventNames)) c.postedEventNames = trimKeepingProtected(c.postedEventNames, keepNames);
    if (Array.isArray(c.lastEventIds)) c.lastEventIds = trimKeepingProtected(c.lastEventIds, keepIds);
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

    trimPostedEvents(bot);
    trimTrackingArrays(bot);
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
    trimTrackingArrays,
    loadCache,
    saveCache,
    flushCacheSync,
    flushCacheToDisk,
    quarantineCorruptCacheFile,
    removeFromPending,
    markEventPosted,
    trimPostedEvents,
    pushToSkipped
};
