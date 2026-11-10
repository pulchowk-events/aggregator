const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.resolve(__dirname, '..', '..', 'data', 'cache.json');

const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));

// Remove scholarships from all event arrays
const arrays = ['pendingEvents', 'postedEvents', 'recentEvents', 'expiredEvents', 'skippedEvents', 'needsAttentionExpiredEvents'];
for (const arr of arrays) {
    if (cache[arr]) {
        cache[arr] = cache[arr].filter(e => e.itemType !== 'scholarship');
    }
}

// Also clean dedup keys (optional – if you want to force re‑sync of everything)
if (cache.settings?.supabaseSync?.syncedEventKeys) {
    // You can either clear the whole array or filter out scholarship keys.
    // Easier: clear it – events/jobs will be re‑uploaded (harmless duplicate upsert).
    cache.settings.supabaseSync.syncedEventKeys = [];
}
cache.postedEventKeys = cache.postedEventKeys.filter(k => !k.includes('scholarship')); // approximate
cache.postedEventNames = cache.postedEventNames.filter(n => !n.includes('scholarship')); // approximate

fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
console.log('✅ Scholarship entries removed from cache.');