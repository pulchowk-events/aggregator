#!/usr/bin/env node
// scripts/maintenance/migrate-from-legacy.js
//
// One-time migration from the old repo layout to the new one.
//
// Old layout:   <repo>/cache.json, <repo>/audit-log.jsonl,
//               <repo>/posted-channel-markers/
// New layout:   <repo>/data/cache.json, <repo>/data/audit-log.jsonl,
//               <repo>/data/posted-channel-markers/
//
// This script copies (does NOT move) the old files into data/ so the
// legacy bot can keep running against the old paths unchanged while the
// new bot gets its own fresh copy. If the new data dir already has a
// cache.json, this exits without touching anything — idempotent.
//
// Usage:
//   node scripts/maintenance/migrate-from-legacy.js --from /path/to/old/repo
//   node scripts/maintenance/migrate-from-legacy.js --from /path/to/old/repo --dry-run
//
// STOP THE NEW BOT before running this. It writes cache.json directly to
// disk; a running bot has its own in-memory copy that would overwrite this
// on the next saveCache().

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function arg(name, fallback = null) {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : (args[i + 1] || fallback);
}
const DRY_RUN = args.includes('--dry-run');
const SRC = arg('from');
if (!SRC) {
    console.error('❌ Usage: node scripts/maintenance/migrate-from-legacy.js --from <legacy-repo-path> [--dry-run]');
    process.exit(1);
}
if (!fs.existsSync(SRC)) {
    console.error(`❌ Source path does not exist: ${SRC}`);
    process.exit(1);
}

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const DEST_CACHE = path.join(DATA_DIR, 'cache.json');
const DEST_AUDIT = path.join(DATA_DIR, 'audit-log.jsonl');
const DEST_MARKERS_DIR = path.join(DATA_DIR, 'posted-channel-markers');

const SRC_CACHE = path.join(SRC, 'cache.json');
const SRC_AUDIT = path.join(SRC, 'audit-log.jsonl');
const SRC_MARKERS_DIR = path.join(SRC, 'posted-channel-markers');

function ok(msg) { console.log(`✅ ${msg}`); }
function warn(msg) { console.log(`⚠️  ${msg}`); }
function info(msg) { console.log(`ℹ️  ${msg}`); }

// ---------- Preflight ----------
console.log('🔍 Preflight check...');
console.log(`   source:      ${SRC}`);
console.log(`   destination: ${DATA_DIR}`);
console.log(`   mode:        ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (will write files)'}`);
console.log('');

if (fs.existsSync(DEST_CACHE) && !DRY_RUN) {
    const stat = fs.statSync(DEST_CACHE);
    if (stat.size > 100) {
        console.error(`❌ ${DEST_CACHE} already exists (${stat.size} bytes) — refusing to overwrite.`);
        console.error('   If you want to force-overwrite, delete data/cache.json first.');
        process.exit(1);
    }
}
if (!fs.existsSync(SRC_CACHE)) {
    console.error(`❌ No cache.json at ${SRC_CACHE} — is --from the right path?`);
    process.exit(1);
}

// ---------- Sanity-check the source cache ----------
let parsed;
try {
    parsed = JSON.parse(fs.readFileSync(SRC_CACHE, 'utf8'));
} catch (e) {
    console.error(`❌ Source cache.json is not valid JSON: ${e.message}`);
    process.exit(1);
}
const counts = {
    pendingEvents: (parsed.pendingEvents || []).length,
    postedEvents: (parsed.postedEvents || []).length,
    skippedEvents: (parsed.skippedEvents || []).length,
    expiredEvents: (parsed.expiredEvents || []).length,
    needsAttentionExpiredEvents: (parsed.needsAttentionExpiredEvents || []).length
};
console.log('📊 Source cache contents:');
for (const [k, v] of Object.entries(counts)) console.log(`   ${k}: ${v}`);
console.log('');

// ---------- Marker files sanity ----------
const markerFiles = fs.existsSync(SRC_MARKERS_DIR) ? fs.readdirSync(SRC_MARKERS_DIR) : [];
console.log(`📊 Source posted-channel-markers: ${markerFiles.length} file(s)`);
console.log('');

if (DRY_RUN) {
    info('DRY RUN — nothing will be written. Re-run without --dry-run to apply.');
    process.exit(0);
}

// ---------- Backup existing destination if present ----------
if (fs.existsSync(DEST_CACHE) && fs.statSync(DEST_CACHE).size > 0) {
    const backupPath = `${DEST_CACHE}.bak.${Date.now()}`;
    fs.copyFileSync(DEST_CACHE, backupPath);
    warn(`Existing ${DEST_CACHE} backed up to ${backupPath}`);
}

// ---------- Apply ----------
fs.mkdirSync(DATA_DIR, { recursive: true });

// Copy cache.json
fs.copyFileSync(SRC_CACHE, DEST_CACHE);
ok(`Copied ${SRC_CACHE} -> ${DEST_CACHE} (${fs.statSync(DEST_CACHE).size} bytes)`);

// Copy audit-log.jsonl if it exists (append-safe by nature — no side effects)
if (fs.existsSync(SRC_AUDIT)) {
    fs.copyFileSync(SRC_AUDIT, DEST_AUDIT);
    ok(`Copied ${SRC_AUDIT} -> ${DEST_AUDIT} (${fs.statSync(DEST_AUDIT).size} bytes)`);
} else {
    info(`No ${SRC_AUDIT} — skipped (new audit log will be created on first run).`);
}

// Copy marker files
if (markerFiles.length > 0) {
    fs.mkdirSync(DEST_MARKERS_DIR, { recursive: true });
    let copied = 0;
    for (const file of markerFiles) {
        const src = path.join(SRC_MARKERS_DIR, file);
        const dest = path.join(DEST_MARKERS_DIR, file);
        try {
            fs.copyFileSync(src, dest);
            copied++;
        } catch (e) {
            warn(`Could not copy marker ${file}: ${e.message}`);
        }
    }
    ok(`Copied ${copied} / ${markerFiles.length} marker files -> ${DEST_MARKERS_DIR}`);
} else {
    info('No marker files in source — skipped.');
}

console.log('');
console.log('✅ Migration complete.');
console.log('');
console.log('   The LEGACY bot is unaffected — its files still live at the');
console.log('   original paths. Only the NEW bot reads data/.');
console.log('');
console.log('   Next: start the new bot with `npm start`. It will pick up');
console.log('   cache.json and posted-channel-markers/ from data/ and behave');
console.log('   exactly as the legacy bot did — same dedup, same posted-state.');
