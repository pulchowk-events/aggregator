// src/integrations/websiteSync/clubsOps.js
// Clubs feed operations: Discord-post hook, backfill, orphan-file cleanup, club takedown.
// Everything is gated by WEBSITE_CLUBS_SYNC_ENABLED (via clubs.js) and every live write goes
// through the target-host guard (clubImages.checkHost). Single posts are UPSERT ONLY, never pruned.
'use strict';

const engine = require('./engine');
const devMode = require('../../core/devMode');
const { auditLog } = require('../../core/auditLogger');
const sf = require('../../posting/socialFormat');
const { normUser } = require('../../posting/socialClubs');
const clubs = require('./clubs');
const images = require('./clubImages');

const GRACE_MS = 6 * 3600 * 1000;
const ensured = new Set();

function ascii(s) { return String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '?'); }
function log(msg) { console.log('[clubsOps] ' + ascii(msg)); }
function resetEnsured() { ensured.clear(); }
function errMsg(e) { return e && e.message ? e.message : String(e); }
function chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

// ---------- item -> record (hook) ----------
function toMs(v) {
    if (v instanceof Date) v = v.getTime();
    let n = NaN;
    if (typeof v === 'number') n = v;
    else if (typeof v === 'string' && v.trim()) n = /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : Date.parse(v);
    if (!isFinite(n) || n <= 0) return 0;
    return n < 1e11 ? n * 1000 : n;
}
function itemMs(it) {
    const c = [it.postedAt, it.takenAt, it.timestamp];
    for (let i = 0; i < c.length; i++) { const n = toMs(c[i]); if (n) return n; }
    try { return toMs(sf.itemTime(it)); } catch (e) { return 0; }
}
function shortcodeOf(it) {
    const direct = it && (it.shortcode || it.code);
    if (typeof direct === 'string' && direct) return direct;
    const m = String((it && (it.url || it.link)) || '').match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
}
function recFromItem(it, club) {
    return {
        club: club && club.username,
        label: club && club.label,
        caption: String(it.caption || it.description || it.text || ''),
        url: it.url || it.link || '',
        image: it.thumbnailUrl || it.thumb || it.thumbnail || it.image || null,
        postedAt: itemMs(it),
        hints: it.hints || null
    };
}

// One posted item: club row first (once per club per process, FK), enrich images, upsert the post.
async function syncPostedItem(it, club, opts) {
    const o = opts || {};
    if (!clubs.isEnabled()) return { skipped: 'disabled' };
    if (!it || !club) return { skipped: 'bad_input' };
    const rec = recFromItem(it, club);
    const row0 = clubs.postToRow(rec, shortcodeOf(it), club, {});
    if (!row0) { log('skip: item not syncable (needs url, post time and shortcode)'); return { skipped: 'unusable' }; }
    const user = row0.club_username;
    if (!ensured.has(user)) {
        const crow = await clubs.enrichClubRow(clubs.clubToRow(Object.assign({}, club, { username: user }), null), o.io);
        if (!crow) return { skipped: 'bad_club' };
        const r = await clubs.syncClubs(null, [crow]);
        const live = !!(r && r.ok === true && r.dryRun === false);
        if (live) ensured.add(user);
        else if (!(r && (r.skipped === 'dev_mode' || r.dryRun === true))) {
            log('club row for ' + user + ' not synced (' + ascii((r && (r.reason || (r.errors && r.errors[0]))) || 'unknown') + '), post skipped');
            return { skipped: 'club_not_synced' };
        }
    }
    const row = await clubs.enrichPostRow(row0, rec, o.io);
    return clubs.upsertClubPost(row);
}

// Never blocks and never throws: the Discord post must not depend on the website.
function fireAndForget(it, club, opts) {
    try {
        Promise.resolve().then(() => syncPostedItem(it, club, opts)).catch((e) => log('hook failed: ' + errMsg(e)));
    } catch (e) { /* never block the post */ }
}

// ---------- backfill ----------
function loadRecs(raw) {
    const out = []; const seen = new Set();
    const push = (rec, key) => {
        if (!rec || typeof rec !== 'object' || !rec.url) return;
        const m = String(rec.url).match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
        const sc = (m && m[1]) || rec.shortcode || key;
        if (!sc || !/^[A-Za-z0-9_-]+$/.test(String(sc)) || seen.has(String(sc))) return;
        seen.add(String(sc)); out.push({ rec, sc: String(sc) });
    };
    if (Array.isArray(raw)) raw.forEach((r) => push(r, null));
    else {
        const src = raw && raw.posts !== undefined ? raw.posts : raw;
        if (Array.isArray(src)) src.forEach((r) => push(r, null));
        else Object.keys(src || {}).forEach((k) => push(src[k], k));
    }
    return out;
}

// Clubs first (FK), then posts one by one (upsert only, no prune), one revalidation at the end.
async function backfill(recs, opts) {
    const o = opts || {};
    const out = { posts: 0, dry: 0, failed: 0, skipped: 0, aborted: null, clubsResult: null };
    const clubMap = {}; const items = [];
    (recs || []).forEach(({ rec, sc }) => {
        const base = (o.clubList || []).find((c) => c && c.username === normUser(rec.club)) || {};
        const club = Object.assign({ username: rec.club, label: rec.label }, base);
        const row = clubs.postToRow(rec, sc, club, {});
        if (!row) { out.skipped++; return; }
        items.push({ rec, row });
        if (!clubMap[row.club_username]) clubMap[row.club_username] = clubs.clubToRow(club, null);
    });
    const crows = [];
    const names = Object.keys(clubMap);
    for (let i = 0; i < names.length; i++) {
        const r = await clubs.enrichClubRow(clubMap[names[i]], o.io);
        if (r) crows.push(r);
    }
    const rc = await clubs.syncClubs(null, crows);
    out.clubsResult = rc;
    const clubsOk = !!(rc && (rc.ok === true || rc.dryRun === true || rc.skipped === 'dev_mode'));
    if (!clubsOk) { out.aborted = 'clubs_not_synced'; return out; }
    for (let i = 0; i < items.length; i++) {
        const row = await clubs.enrichPostRow(items[i].row, items[i].rec, o.io);
        const r = await clubs.upsertClubPost(row, { revalidate: false });
        if (r && r.ok === true && r.dryRun === false) out.posts++;
        else if (r && (r.dryRun === true || r.skipped)) out.dry++;
        else out.failed++;
    }
    if (out.posts > 0) await engine.triggerRevalidation(['clubs']);
    return out;
}

// ---------- storage helpers ----------
async function listFolder(storage, prefix) {
    const all = []; let offset = 0;
    for (;;) {
        const { data, error } = await storage.list(prefix, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
        if (error) throw new Error(error.message || String(error));
        const page = data || [];
        page.forEach((e) => all.push(e));
        if (page.length < 100) break;
        offset += 100;
    }
    return all;
}
async function listPostFiles(db) {
    const st = db.storage.from(images.POSTS_BUCKET);
    const top = await listFolder(st, '');
    const files = [];
    for (let i = 0; i < top.length; i++) {
        const e = top[i];
        if (e.id) { files.push(e); continue; }
        const sub = await listFolder(st, e.name);
        sub.forEach((f) => { if (f.id) files.push(Object.assign({}, f, { name: e.name + '/' + f.name })); });
    }
    return files;
}
async function livePaths(db, table) {
    const set = new Set(); let total = 0; let from = 0; const size = 1000;
    for (;;) {
        const { data, error } = await db.from(table).select('image_path').range(from, from + size - 1);
        if (error) throw new Error(error.message || String(error));
        const page = data || [];
        page.forEach((r) => { total++; if (r && r.image_path) set.add(String(r.image_path)); });
        if (page.length < size) break;
        from += size;
    }
    return { set, total };
}
async function removeFiles(db, bucket, paths) {
    let n = 0;
    const parts = chunk(paths, 100);
    for (let i = 0; i < parts.length; i++) {
        const { error } = await db.storage.from(bucket).remove(parts[i]);
        if (error) throw new Error(error.message || String(error));
        n += parts[i].length;
    }
    return n;
}

function gate(fn) {
    if (devMode.noteBlocked(fn)) return { skipped: 'dev_mode', devMode: true, dryRun: true };
    if (!engine.isEnabled()) return { ok: false, reason: 'disabled' };
    if (!clubs.isEnabled()) return { ok: false, reason: 'clubs_disabled' };
    if (!engine.isConfigured()) return { ok: false, reason: 'not_configured' };
    return null;
}

// ---------- nightly cleanup: files in club-posts that no club_posts row points at ----------
async function cleanupOrphans(opts) {
    const o = opts || {};
    const g = gate('cleanupOrphans');
    if (g) return g;
    const table = clubs.clubPostsTableName();
    const db = engine.getWebsiteSupabase();
    const res = { ok: true, dryRun: engine.DRY_RUN, scanned: 0, orphans: 0, young: 0, deleted: 0, aborted: null, errors: [] };
    try {
        const live = await livePaths(db, table);
        const files = (await listPostFiles(db)).filter((f) => !String(f.name).split('/').pop().startsWith('.'));
        res.scanned = files.length;
        if (live.total === 0) { res.aborted = 'empty_row_set'; log('cleanup aborted: club_posts has no rows, refusing to treat every file as an orphan'); return res; }
        const now = o.now || Date.now();
        const grace = o.graceMs === undefined ? GRACE_MS : o.graceMs;
        const orphans = [];
        files.forEach((f) => {
            if (live.set.has(f.name)) return;
            const ts = Date.parse(f.updated_at || f.created_at || '');
            if (!isFinite(ts) || now - ts < grace) { res.young++; return; }
            orphans.push(f.name);
        });
        res.orphans = orphans.length;
        if (!orphans.length) return res;
        if (orphans.length / files.length > 0.5) { res.aborted = 'delete_threshold_exceeded'; log('cleanup aborted: ' + orphans.length + ' of ' + files.length + ' files would be deleted'); return res; }
        if (engine.DRY_RUN) {
            orphans.forEach((p) => log('[DRY RUN] would delete ' + images.POSTS_BUCKET + '/' + p));
            return res;
        }
        const hg = images.checkHost('cleanupOrphans');
        if (hg) { res.ok = false; res.reason = hg.reason; return res; }
        res.deleted = await removeFiles(db, images.POSTS_BUCKET, orphans);
        if (res.deleted > 0) await engine.triggerRevalidation(['clubs']);
    } catch (e) {
        res.ok = false; res.errors.push(errMsg(e));
        log('cleanup failed: ' + errMsg(e));
        try { auditLog('website_sync', '[clubsOps] cleanup failed: ' + errMsg(e), { error: errMsg(e) }, 'error'); } catch (x) { /* ignore */ }
    }
    return res;
}

// ---------- /club remove: take the club off the website ----------
async function takedownClub(username) {
    const u = normUser(username);
    if (!u) return { ok: false, reason: 'bad_username' };
    ensured.delete(u);
    const g = gate('takedownClub');
    if (g) return g;
    if (engine.DRY_RUN) {
        log('[DRY RUN] would delete club_posts rows, ' + images.POSTS_BUCKET + '/' + u + '/*, ' + images.AVATARS_BUCKET + '/' + u + '.jpg and the clubs row for ' + u);
        return { ok: true, dryRun: true, username: u };
    }
    const hg = images.checkHost('takedownClub ' + u);
    if (hg) return hg;
    const db = engine.getWebsiteSupabase();
    const res = { ok: true, dryRun: false, username: u, files: 0, errors: [] };
    try {
        const { error } = await db.from(clubs.clubPostsTableName()).delete().eq('club_username', u);
        if (error) throw new Error(error.message || String(error));
    } catch (e) { res.errors.push('rows: ' + errMsg(e)); }
    try {
        const entries = await listFolder(db.storage.from(images.POSTS_BUCKET), u);
        const paths = entries.filter((e) => e.id).map((e) => u + '/' + e.name);
        if (paths.length) res.files = await removeFiles(db, images.POSTS_BUCKET, paths);
    } catch (e) { res.errors.push('files: ' + errMsg(e)); }
    try { await removeFiles(db, images.AVATARS_BUCKET, [u + '.jpg']); } catch (e) { res.errors.push('avatar: ' + errMsg(e)); }
    try {
        const { error } = await db.from(clubs.clubsTableName()).delete().eq('username', u);
        if (error) throw new Error(error.message || String(error));
    } catch (e) { res.errors.push('club: ' + errMsg(e)); }
    res.ok = res.errors.length === 0;
    if (!res.ok) { try { auditLog('website_sync', '[clubsOps] takedown ' + u + ' errors: ' + res.errors.join(' | '), { errors: res.errors }, 'error'); } catch (x) { /* ignore */ } }
    await engine.triggerRevalidation(['clubs']);
    return res;
}

module.exports = {
    syncPostedItem, fireAndForget, resetEnsured,
    loadRecs, backfill, cleanupOrphans, takedownClub,
    GRACE_MS
};
