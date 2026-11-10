const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.resolve(__dirname, '..', '..', 'data', 'cache.json');
const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));

let changed = 0;
for (const e of cache.pendingEvents || []) {
    if (Array.isArray(e.dataQualityWarnings)) {
        const before = e.dataQualityWarnings.length;
        e.dataQualityWarnings = Array.from(new Set(e.dataQualityWarnings));
        if (e.dataQualityWarnings.length !== before) changed++;
    }
}

fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
console.log(`Cleaned duplicate warnings on ${changed} event(s).`);