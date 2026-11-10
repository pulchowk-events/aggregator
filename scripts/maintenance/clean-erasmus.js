// ---------- cleanup-erasmus-scholarships.js ----------
// Removes ALL scholarship entries whose source === 'erasmusmundus' from
// cache.json — from every array they could be sitting in, plus their
// dedup-tracking keys and their posted-marker files on disk. Leaves
// everything else (events, jobs, scholarshipsads scholarships) untouched.
//
// STOP THE BOT before running this — it edits cache.json directly on disk,
// and the running bot process has its own in-memory copy that would
// overwrite this the next time it calls saveCache().
//
// Usage:
//   node cleanup-erasmus-scholarships.js --dry-run   # preview only, no changes
//   node cleanup-erasmus-scholarships.js             # actually delete

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const CACHE_FILE = path.resolve(__dirname, '..', '..', 'data', 'cache.json');
const POSTED_MARKERS_DIR = path.resolve(__dirname, '..', '..', 'data', 'posted-channel-markers');
const TARGET_SOURCE = 'erasmusmundus';
const DRY_RUN = process.argv.includes('--dry-run');

if (!fs.existsSync(CACHE_FILE)) {
    console.error(`❌ ${CACHE_FILE} not found.`);
    process.exit(1);
}

const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));

// ---------- Same normalizeEventName / dedup-key logic as bot.js ----------
// Copied rather than imported so this script has zero dependency on a live
// bot instance (no Discord login needed just to clean up a cache file).
function normalizeEventName(name) {
    if (!name) return '';
    return name.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function getCanonicalDateForDedup(event) {
    // Scholarships store their canonical date in deadlineParsed (ISO
    // yyyy-LL-dd), same field bot.js's parseEventDate() reads first.
    if (event.deadlineParsed && /^\d{4}-\d{2}-\d{2}/.test(event.deadlineParsed)) {
        return event.deadlineParsed.slice(0, 10);
    }
    return null;
}

function getDedupFallbackComponent(event) {
    const url = (event.registrationUrl || event.url || '').trim();
    if (url) return `url:${url.toLowerCase()}`;
    const desc = (event.description || '').trim().slice(0, 200).toLowerCase();
    const source = (event.source || '').toLowerCase();
    const hash = crypto.createHash('sha1').update(`${source}|${desc}`).digest('hex').slice(0, 12);
    return `hash:${hash}`;
}

function getEventDedupKey(event) {
    const normalizedTitle = normalizeEventName(event.title || '');
    const canonicalDate = getCanonicalDateForDedup(event);
    if (canonicalDate) return `${normalizedTitle}|${canonicalDate}`.toLowerCase();
    const fallback = getDedupFallbackComponent(event);
    return `${normalizedTitle}|nodate:${fallback}`.toLowerCase();
}

function postedMarkerPath(dedupKey, channelId) {
    const key = `${dedupKey}::${channelId}`;
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    return path.join(POSTED_MARKERS_DIR, `${hash}.json`);
}

// ---------- Find every matching event across all arrays ----------
const isTarget = (e) => e && e.itemType === 'scholarship' && e.source === TARGET_SOURCE;

const arrays = ['pendingEvents', 'postedEvents', 'recentEvents', 'expiredEvents', 'skippedEvents', 'needsAttentionExpiredEvents'];
const matchedEvents = [];

for (const arrName of arrays) {
    if (Array.isArray(cache[arrName])) {
        for (const e of cache[arrName]) {
            if (isTarget(e)) matchedEvents.push(e);
        }
    }
}

console.log(`🔍 Found ${matchedEvents.length} "${TARGET_SOURCE}" scholarship(s) across ${arrays.length} arrays:`);
for (const e of matchedEvents) {
    console.log(`   - "${e.title}" (id: ${e.id || 'no-id'})`);
}

if (matchedEvents.length === 0) {
    console.log('✅ Nothing to remove.');
    process.exit(0);
}

// ---------- Compute dedup keys for matched events (for key/marker cleanup) ----------
const matchedKeys = new Set(matchedEvents.map(e => getEventDedupKey(e)));

// ---------- Remove matched events from every array ----------
const removedCounts = {};
for (const arrName of arrays) {
    if (Array.isArray(cache[arrName])) {
        const before = cache[arrName].length;
        cache[arrName] = cache[arrName].filter(e => !isTarget(e));
        removedCounts[arrName] = before - cache[arrName].length;
    }
}

// ---------- Clean dedup-tracking arrays precisely (not string-matching) ----------
let removedPostedKeys = 0, removedSyncedKeys = 0, removedPostedNames = 0;

if (Array.isArray(cache.postedEventKeys)) {
    const before = cache.postedEventKeys.length;
    cache.postedEventKeys = cache.postedEventKeys.filter(k => !matchedKeys.has(k));
    removedPostedKeys = before - cache.postedEventKeys.length;
}

if (cache.settings?.supabaseSync?.syncedEventKeys) {
    const before = cache.settings.supabaseSync.syncedEventKeys.length;
    cache.settings.supabaseSync.syncedEventKeys = cache.settings.supabaseSync.syncedEventKeys.filter(k => !matchedKeys.has(k));
    removedSyncedKeys = before - cache.settings.supabaseSync.syncedEventKeys.length;
}

// postedEventNames is normalized-title only (no date), so it can't be
// matched via matchedKeys directly — match by normalized title of the
// matched events instead. NOTE: only remove a name if NO remaining posted
// event (of any source/type) still uses that same title, so we don't wipe
// out a name that's legitimately shared with an unrelated posted item.
if (Array.isArray(cache.postedEventNames)) {
    const matchedNames = new Set(matchedEvents.map(e => normalizeEventName(e.title || '')));
    const stillInUse = new Set(
        (cache.postedEvents || []).map(e => normalizeEventName(e.title || ''))
    );
    const before = cache.postedEventNames.length;
    cache.postedEventNames = cache.postedEventNames.filter(n => !matchedNames.has(n) || stillInUse.has(n));
    removedPostedNames = before - cache.postedEventNames.length;
}

// ---------- Remove posted-marker files on disk for these events ----------
// Markers are keyed by dedupKey + channelId, so we need every channel this
// scholarship COULD have been posted to (scholarships main + test channel).
const SCHOLARSHIPS_CHANNEL_IDS = [
    process.env.SCHOLARSHIPS_CHANNEL_ID,
    process.env.TEST_SCHOLARSHIPS_CHANNEL_ID
].filter(Boolean);

let removedMarkers = 0;
if (fs.existsSync(POSTED_MARKERS_DIR) && SCHOLARSHIPS_CHANNEL_IDS.length > 0) {
    for (const key of matchedKeys) {
        for (const channelId of SCHOLARSHIPS_CHANNEL_IDS) {
            const markerPath = postedMarkerPath(key, channelId);
            if (fs.existsSync(markerPath)) {
                if (!DRY_RUN) fs.unlinkSync(markerPath);
                removedMarkers++;
            }
        }
    }
} else if (SCHOLARSHIPS_CHANNEL_IDS.length === 0) {
    console.warn('⚠️ SCHOLARSHIPS_CHANNEL_ID / TEST_SCHOLARSHIPS_CHANNEL_ID not set in .env — skipping marker file cleanup (cache entries still removed).');
}

// ---------- Summary ----------
console.log('\n📊 Summary:');
for (const [arrName, count] of Object.entries(removedCounts)) {
    if (count > 0) console.log(`   ${arrName}: removed ${count}`);
}
console.log(`   postedEventKeys: removed ${removedPostedKeys}`);
console.log(`   postedEventNames: removed ${removedPostedNames}`);
console.log(`   supabaseSync.syncedEventKeys: removed ${removedSyncedKeys}`);
console.log(`   posted-marker files: removed ${removedMarkers}`);

if (DRY_RUN) {
    console.log('\n🧪 Dry run — no files were modified. Re-run without --dry-run to apply.');
    process.exit(0);
}

// ---------- Backup before writing, same pattern bot.js uses on corruption ----------
const backupPath = `${CACHE_FILE}.bak.${Date.now()}`;
fs.copyFileSync(CACHE_FILE, backupPath);
console.log(`\n💾 Backed up original cache.json to: ${backupPath}`);

fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
console.log(`✅ Removed ${matchedEvents.length} "${TARGET_SOURCE}" scholarship(s) from cache.json.`);