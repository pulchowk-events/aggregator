// src/scrapers/registry.js
// Filesystem-discovered scraper plugin loader.
//
// Discovery: at module load, walk
//   src/scrapers/sources/{events,jobs,scholarships}/*.js
// require each file, validate the plugin contract, and build an in-memory
// lookup. Dropping a new file into one of those directories is the ONLY
// step required to add a source — no changes here, no changes to bot.js.
//
// Plugin contract (must be an object):
//   {
//     name:   string,                    // unique, ideally matches filename stem
//     type:   'events' | 'jobs' | 'scholarships',
//     scrape: async (ctx) => Item[]      // ctx: { withPage, progress, log }
//   }
//
// Invalid plugins do NOT crash the process — they log a loud warning and
// are skipped, so a single bad file can't take down every source. A
// duplicate `name` within the same type likewise gets skipped (first one
// wins), so a mis-copied file doesn't silently shadow a working one.
//
// Order of iteration is deterministic: sorted by filename stem. This
// matters for progress-reporting order and for the errors array in
// scrapeAll's result.

const fs = require('fs');
const path = require('path');
const { auditLog } = require('../core/auditLogger');

const SOURCES_ROOT = path.join(__dirname, 'sources');
const SOURCE_TYPES = ['events', 'jobs', 'scholarships'];

let registry = null;

function listJsFiles(dir) {
    try {
        return fs.readdirSync(dir)
            .filter((f) => f.endsWith('.js'))
            .sort();
    } catch (e) {
        return [];
    }
}

function validatePlugin(mod, filePath, type) {
    const errors = [];
    if (!mod || typeof mod !== 'object') {
        errors.push('module does not export an object');
        return errors;
    }
    if (typeof mod.name !== 'string' || !mod.name.trim()) {
        errors.push('`name` must be a non-empty string');
    }
    if (mod.type !== type) {
        errors.push(`\`type\` must be "${type}" (file lives under sources/${type}/), got ${JSON.stringify(mod.type)}`);
    }
    if (typeof mod.scrape !== 'function') {
        errors.push('`scrape` must be a function');
    }
    return errors;
}

function loadAll() {
    if (registry) return registry;

    const r = {
        events: new Map(),
        jobs: new Map(),
        scholarships: new Map()
    };
    const all = [];
    const loadErrors = [];

    for (const type of SOURCE_TYPES) {
        const dir = path.join(SOURCES_ROOT, type);
        const files = listJsFiles(dir);

        for (const filename of files) {
            const stem = filename.replace(/\.js$/, '');
            const filePath = path.join(dir, filename);
            let mod;
            try {
                mod = require(filePath);
            } catch (error) {
                loadErrors.push({ file: `sources/${type}/${filename}`, error: error.message });
                console.error(`❌ [registry] Failed to require ${type}/${filename}:`, error.message);
                continue;
            }
            const errors = validatePlugin(mod, filePath, type);
            if (errors.length > 0) {
                loadErrors.push({ file: `sources/${type}/${filename}`, errors });
                console.error(`❌ [registry] Invalid plugin ${type}/${filename}: ${errors.join('; ')}`);
                continue;
            }
            if (mod.name !== stem) {
                console.warn(`⚠️ [registry] ${type}/${filename}: \`name\` ("${mod.name}") does not match filename stem ("${stem}") — this is fine but makes debugging confusing.`);
            }
            if (r[type].has(mod.name)) {
                console.error(`❌ [registry] Duplicate plugin name "${mod.name}" in ${type} — skipping ${filename} (first one won).`);
                continue;
            }
            r[type].set(mod.name, mod);
            all.push(mod);
        }
    }

    registry = r;
    registry._all = all;
    registry._loadErrors = loadErrors;

    const summary = SOURCE_TYPES.map((t) => `${t}=${r[t].size}`).join(', ');
    console.log(`🔌 [registry] Loaded ${all.length} scraper plugin(s): ${summary}`);
    if (loadErrors.length > 0) {
        console.warn(`⚠️ [registry] ${loadErrors.length} plugin(s) failed to load — see above for details.`);
        auditLog('scraper_registry', `Scraper registry loaded with ${loadErrors.length} failure(s)`, {
            summary, loadErrors
        }, 'warn');
    }

    return r;
}

// Return the plugin object for (type, name), or null.
function getSource(type, name) {
    const r = loadAll();
    return r[type] ? (r[type].get(name) || null) : null;
}

// Return array of plugin names for a given type (sorted deterministically).
function listSources(type) {
    const r = loadAll();
    return r[type] ? Array.from(r[type].keys()) : [];
}

// Return all plugin objects across all types.
function getAllSources() {
    return loadAll()._all;
}

// Return array of load failures (for /health or diagnostics).
function getLoadErrors() {
    return loadAll()._loadErrors;
}

module.exports = {
    SOURCE_TYPES,
    getSource,
    listSources,
    getAllSources,
    getLoadErrors
};
