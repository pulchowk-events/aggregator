// src/integrations/websiteSync/clubs.js
// Clubs feed -> website Supabase (clubs + club_posts).
// Session 4: sync module. Session 5: classifier from insta-classifier, optional image re-hosting.
// No hook, no cron here (later sessions).
//
// Inputs are ROWS already mapped with clubToRow / postToRow. The optional enrich step
// (enrichPostRow / enrichClubRow, gated by WEBSITE_CLUBS_IMAGES_ENABLED, default off)
// fills avatar_url / image_url / image_path before anything is synced.
// Gate order matches syncWebsite: DEV_MODE -> enabled -> configured -> DRY_RUN.
// In DEV_MODE the rows are printed and nothing else happens.
//
// is_event / post_type come from the insta classifier (src/scrapers/lib/insta-classifier.js),
// called with {caption, takenAt: postedAt}. post_type = result.hints.type, null when not an event.
//
// syncClubPosts = FULL-SET sync (upsert + prune guarded by the engine).
// upsertClubPost = single row, upsert only, never prunes (for the session 6 hook).
'use strict';

const env = require('../../config/env');
const engine = require('./engine');
const devMode = require('../../core/devMode');
const { auditLog } = require('../../core/auditLogger');
const sf = require('../../posting/socialFormat');
const { normUser } = require('../../posting/socialClubs');
const instaClassifier = require('../../scrapers/lib/insta-classifier');
const images = require('./clubImages');

const CAPTION_MAX = 2000;
const ORIGIN = 'scraper:instagram';

function truthy(v) { return v === true || /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim()); }
function setting(name) { return (env[name] !== undefined && env[name] !== '') ? env[name] : process.env[name]; }
function isEnabled() { return truthy(setting('WEBSITE_CLUBS_SYNC_ENABLED')); }
function imagesEnabled() { return truthy(setting('WEBSITE_CLUBS_IMAGES_ENABLED')); }
function clubsTableName() { return setting('WEBSITE_CLUBS_TABLE') || 'clubs'; }
function clubPostsTableName() { return setting('WEBSITE_CLUB_POSTS_TABLE') || 'club_posts'; }
function log(msg) { console.log('[clubsSync] ' + msg); }

// ---------- mapping ----------
function clip(s, n) {
    const t = String(s == null ? '' : s);
    return t.length > n ? t.slice(0, n - 3).trimEnd() + '...' : t;
}

function cleanCap(raw) {
    if (!raw || !String(raw).trim()) return null;
    let c;
    try { c = sf.cleanCaption(String(raw)); } catch (e) { c = String(raw); }
    if (typeof c !== 'string') c = String(raw);
    c = c.trim();
    return c ? clip(c, CAPTION_MAX) : null;
}

// is_event = classifier verdict. post_type = hints.type, only when it is an event.
function classifyPost(rec) {
    let r = null;
    try {
        r = instaClassifier.classifyPost({ caption: rec && rec.caption, takenAt: rec && rec.postedAt });
    } catch (e) { r = null; }
    const isEvent = !!(r && r.is_event === true);
    const t = r && r.hints && typeof r.hints.type === 'string' ? r.hints.type : '';
    return { postType: (isEvent && t) ? t : null, isEvent };
}

function clubToRow(club, avatarUrl) {
    const username = normUser(club && club.username);
    if (!username) return null;
    const label = club.label && club.label !== username ? club.label : null;
    const row = { username, enabled: true, updated_at: new Date().toISOString() };
    // display_name / avatar_url are OMITTED when empty so an upsert never wipes a stored value
    const dn = club.displayName || club.display_name || label;
    if (dn) row.display_name = dn;
    if (avatarUrl) row.avatar_url = avatarUrl;
    return row;
}

// Returns null when the record cannot be synced (no url, bad postedAt, no club).
function postToRow(rec, shortcode, club, opts) {
    const o = opts || {};
    if (!rec || !shortcode) return null;
    const postUrl = String(rec.url || '').trim();
    if (!postUrl) return null;
    const ms = Number(rec.postedAt);
    if (!isFinite(ms) || ms <= 0) return null;
    const username = normUser((club && club.username) || rec.club);
    if (!username) return null;
    const key = 'ig:' + shortcode;
    const t = classifyPost(rec);
    const row = {
        id: engine.deterministicUUID(key),
        bot_dedup_key: key,
        origin: ORIGIN,
        shortcode: String(shortcode),
        club_username: username,
        caption: cleanCap(rec.caption),
        post_url: postUrl,
        is_event: t.isEvent,
        post_type: t.postType,
        posted_at: new Date(ms).toISOString(),
        synced_at: new Date().toISOString()
    };
    // image columns are OMITTED when empty so an upsert never overwrites a stored URL with null
    if (o.imageUrl) row.image_url = o.imageUrl;
    if (o.imagePath) row.image_path = o.imagePath;
    return row;
}

// ---------- optional image enrich (WEBSITE_CLUBS_IMAGES_ENABLED, default off) ----------
function recImageUrl(rec) {
    const u = rec && (rec.image || rec.imageUrl || rec.thumbnailUrl || rec.thumb);
    return (typeof u === 'string' && sf.isHttp(u)) ? u : null;
}

// Returns a NEW row with image_url / image_path set, or the SAME row when off / nothing to add.
async function enrichPostRow(row, rec, io) {
    if (!imagesEnabled() || !row) return row;
    if (row.image_url && row.image_path) return row;
    try {
        const r = await images.uploadPostImage(row.shortcode, row.club_username, io, recImageUrl(rec));
        if (r && r.imageUrl && r.imagePath) return Object.assign({}, row, { image_url: r.imageUrl, image_path: r.imagePath });
    } catch (e) { log('enrich post failed: ' + e.message); }
    return row;
}

// Returns a NEW row with avatar_url set, or the SAME row when off / nothing to add.
async function enrichClubRow(row, io) {
    if (!imagesEnabled() || !row || !row.username) return row;
    if (row.avatar_url) return row;
    try {
        const url = await images.uploadAvatar(row.username, io);
        if (url) return Object.assign({}, row, { avatar_url: url });
    } catch (e) { log('enrich club failed: ' + e.message); }
    return row;
}

// ---------- preview (dry run / dev mode) ----------
function ascii(s) { return String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '?'); }
function previewLine(row) {
    const o = {};
    Object.keys(row).forEach((k) => {
        let v = row[k];
        if (typeof v === 'string') {
            v = ascii(v);
            if (k === 'caption') v = v.slice(0, 80);
            else if (v.length > 120) v = v.slice(0, 120) + '...';
        }
        o[k] = v;
    });
    return ascii(JSON.stringify(o));
}
function printRows(table, rows, tag) {
    log(tag + ' ' + table + ': ' + rows.length + ' row(s)');
    rows.forEach((r) => log('  ' + previewLine(r)));
}

function precheck() {
    if (!engine.isEnabled()) return { ok: false, reason: 'disabled' };
    if (!isEnabled()) return { ok: false, reason: 'clubs_disabled' };
    if (!engine.isConfigured()) return { ok: false, reason: 'not_configured' };
    return null;
}

// ---------- clubs: plain upsert on username, no prune ----------
async function syncClubs(bot, rows) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.username);
    const table = clubsTableName();
    if (devMode.noteBlocked('syncClubs')) {
        printRows(table, list, '[DEV_MODE, nothing written]');
        return { skipped: 'dev_mode', devMode: true, dryRun: true };
    }
    const gate = precheck();
    if (gate) return gate;
    if (engine.DRY_RUN) {
        printRows(table, list, '[DRY RUN]');
        return { ok: true, dryRun: true, table, syncedCount: list.length, failedCount: 0, prunedCount: 0, errors: [] };
    }
    const hg = images.checkHost('syncClubs');
    if (hg) return hg;
    const db = engine.getWebsiteSupabase();
    const res = { ok: true, dryRun: false, table, syncedCount: 0, failedCount: 0, prunedCount: 0, errors: [] };
    // group by key shape so a batch never mixes rows with and without optional columns
    const groups = {};
    list.forEach((r) => { const k = Object.keys(r).sort().join(','); (groups[k] = groups[k] || []).push(r); });
    const batches = [];
    Object.keys(groups).forEach((k) => engine.chunkArray(groups[k], engine.BATCH_SIZE).forEach((b) => batches.push(b)));
    for (let i = 0; i < batches.length; i++) {
        try {
            const { error } = await db.from(table).upsert(batches[i], { onConflict: 'username' });
            if (error) throw error;
            res.syncedCount += batches[i].length;
        } catch (err) {
            res.failedCount += batches[i].length;
            res.errors.push(err.message);
            log('[clubs] batch ' + (i + 1) + '/' + batches.length + ' FAILED: ' + err.message);
            auditLog('website_sync', '[clubs] batch ' + (i + 1) + ' failed: ' + err.message, { table, error: err.message }, 'error');
        }
        if (i < batches.length - 1) await engine.sleep(50);
    }
    res.ok = res.failedCount === 0;
    if (res.syncedCount > 0) await engine.triggerRevalidation(['clubs']);
    return res;
}

// ---------- club_posts: full-set sync through the engine (upsert + guarded prune) ----------
async function syncClubPosts(bot, rows) {
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id && r.bot_dedup_key);
    const table = clubPostsTableName();
    if (devMode.noteBlocked('syncClubPosts')) {
        printRows(table, list, '[DEV_MODE, nothing written]');
        return { skipped: 'dev_mode', devMode: true, dryRun: true };
    }
    const gate = precheck();
    if (gate) return gate;
    if (engine.DRY_RUN) printRows(table, list, '[DRY RUN]');
    else { const hg = images.checkHost('syncClubPosts'); if (hg) return hg; }
    const res = await engine.syncOneTable(bot, {
        tableName: table, rows: list, label: 'club_posts', emit: () => {}, log, startMs: Date.now(), skippedInfo: {}
    });
    if (!engine.DRY_RUN && (res.syncedCount > 0 || res.prunedCount > 0)) await engine.triggerRevalidation(['clubs']);
    return Object.assign({}, res, { dryRun: engine.DRY_RUN });
}

// ---------- single post: upsert only, NEVER prune (session 6 hook) ----------
async function upsertClubPost(row, opts) {
    if (!row || !row.id || !row.bot_dedup_key) return { ok: false, reason: 'invalid_row' };
    const table = clubPostsTableName();
    if (devMode.noteBlocked('upsertClubPost')) {
        printRows(table, [row], '[DEV_MODE, nothing written]');
        return { skipped: 'dev_mode', devMode: true, dryRun: true };
    }
    const gate = precheck();
    if (gate) return gate;
    if (engine.DRY_RUN) {
        printRows(table, [row], '[DRY RUN]');
        return { ok: true, dryRun: true, table, syncedCount: 1, failedCount: 0, prunedCount: 0 };
    }
    const hg = images.checkHost('upsertClubPost');
    if (hg) return hg;
    try {
        const { error } = await engine.getWebsiteSupabase().from(table).upsert(row, { onConflict: 'id' });
        if (error) throw error;
    } catch (err) {
        auditLog('website_sync', '[club_posts] single upsert failed: ' + err.message, { table, error: err.message }, 'error');
        return { ok: false, dryRun: false, table, syncedCount: 0, failedCount: 1, prunedCount: 0, reason: err.message };
    }
    if (!opts || opts.revalidate !== false) await engine.triggerRevalidation(['clubs']);
    return { ok: true, dryRun: false, table, syncedCount: 1, failedCount: 0, prunedCount: 0 };
}

module.exports = {
    clubToRow, postToRow, classifyPost,
    enrichPostRow, enrichClubRow, imagesEnabled,
    syncClubs, syncClubPosts, upsertClubPost,
    isEnabled, clubsTableName, clubPostsTableName,
    CAPTION_MAX, ORIGIN
};
