// src/integrations/websiteSync/clubImages.js
// Re-hosts club post images and avatars into the website Supabase Storage buckets.
// Reuses engine.getWebsiteSupabase() (no new client). NEVER throws into the caller:
// any failure returns nulls and logs one line.
//
// Buckets (public, created by the clubs SQL record): club-posts and club-avatars.
// uploadPostImage(shortcode, club, io, cdnUrl) -> { imageUrl, imagePath } or nulls
//   source order: local data/instagram/thumbs/<shortcode>.(webp|jpg|jpeg|png),
//   then the stored CDN url (one fetch, 5 MB cap, image/* only), else nulls.
//   bucket club-posts, object path <club>/<shortcode>.<ext>, upsert:true (image_path = that path)
// uploadAvatar(club, io) -> public url or null
//   source: data/instagram/dp/<club>.jpg -> bucket club-avatars, object path <club>.jpg
// DEV_MODE / DRY_RUN: nothing is uploaded, the would-be bucket/path and url are returned and printed.
// checkHost(what): target-host guard. Every LIVE write prints the target host and is refused
//   unless WEBSITE_CLUBS_CONFIRM_HOST matches it. DRY_RUN / DEV_MODE never reach it.
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../config/env');
const engine = require('./engine');
const devMode = require('../../core/devMode');
const { auditLog } = require('../../core/auditLogger');
const { ROOT, DP_DIR } = require('../../posting/socialPaths');
const { normUser } = require('../../posting/socialClubs');

const MAX_BYTES = 5 * 1024 * 1024;
const POSTS_BUCKET = 'club-posts';
const AVATARS_BUCKET = 'club-avatars';
const THUMB_DIR = path.join(ROOT, 'data', 'instagram', 'thumbs');
const LOCAL_EXTS = ['webp', 'jpg', 'jpeg', 'png'];
const EXT_TYPE = { webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const TYPE_EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/avif': 'avif' };
const SAFE_CODE = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_USER = /^[a-z0-9._]{1,64}$/;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function setting(name) { return (env[name] !== undefined && env[name] !== '') ? env[name] : process.env[name]; }
function ascii(s) { return String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '?'); }
function log(msg) { console.log('[clubImages] ' + ascii(msg)); }
function isHttp(u) { return typeof u === 'string' && /^https?:\/\//i.test(u); }

// ---------- target host guard ----------
function targetHost() {
    const raw = String(setting('WEBSITE_SUPABASE_URL') || '').trim();
    if (!raw) return '';
    try { return new URL(raw).host.toLowerCase(); } catch (e) { return raw.toLowerCase(); }
}
function confirmedHost() {
    const raw = String(setting('WEBSITE_CLUBS_CONFIRM_HOST') || '').trim().toLowerCase();
    if (!raw) return '';
    try { return new URL(/^[a-z]+:\/\//.test(raw) ? raw : 'https://' + raw).host; } catch (e) { return raw; }
}
// Returns null when the write may go ahead, or { ok:false, reason, host } when refused.
function checkHost(what) {
    const host = targetHost();
    const want = confirmedHost();
    console.log('[hostGuard] ' + ascii(what) + ' -> target host ' + (host || '(none)'));
    if (!host || !want || host !== want) {
        console.warn('[hostGuard] REFUSED ' + ascii(what) + ': target host ' + (host || '(none)') + ' is not confirmed (set WEBSITE_CLUBS_CONFIRM_HOST=' + (host || '<host>') + ')');
        return { ok: false, reason: 'host_not_confirmed', host };
    }
    return null;
}

function publicUrl(bucket, objPath, allowPlaceholder) {
    let base = String(setting('WEBSITE_SUPABASE_URL') || '').replace(/\/+$/, '');
    if (!base) {
        if (!allowPlaceholder) return null;
        base = '<WEBSITE_SUPABASE_URL>';
    }
    return base + '/storage/v1/object/public/' + bucket + '/' + objPath.split('/').map(encodeURIComponent).join('/');
}

function guessExt(url) {
    try {
        const m = new URL(url).pathname.match(/\.(webp|jpe?g|png|gif|avif)$/i);
        if (m) { const e = m[1].toLowerCase(); return e === 'jpeg' ? 'jpg' : e; }
    } catch (e) { /* fall through */ }
    return 'jpg';
}

const defaultIo = {
    readLocal(p) { try { return fs.readFileSync(p); } catch (e) { return null; } },
    async download(url) {
        const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!/^image\//.test(type)) throw new Error('not an image (' + (type || 'no content-type') + ')');
        if (!TYPE_EXT[type]) throw new Error('unsupported image type (' + type + ')');
        const len = Number(res.headers.get('content-length'));
        if (isFinite(len) && len > MAX_BYTES) throw new Error('too large (' + len + ' bytes)');
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length || buf.length > MAX_BYTES) throw new Error('bad image size ' + buf.length);
        return { buf, contentType: type };
    }
};

function mode(fn) {
    if (devMode.noteBlocked(fn)) return 'dev';
    if (!engine.isEnabled()) return 'disabled';
    if (!engine.isConfigured()) return 'not_configured';
    return engine.DRY_RUN ? 'dry' : 'live';
}

async function localSource(dir, base, io) {
    for (let i = 0; i < LOCAL_EXTS.length; i++) {
        const ext = LOCAL_EXTS[i];
        const buf = await io.readLocal(path.join(dir, base + '.' + ext));
        if (buf && buf.length) {
            if (buf.length > MAX_BYTES) { log('local ' + base + '.' + ext + ' too large, skipped'); continue; }
            return { buf, ext, contentType: EXT_TYPE[ext] };
        }
    }
    return null;
}

async function putObject(bucket, objPath, buf, contentType) {
    const db = engine.getWebsiteSupabase();
    const { error } = await db.storage.from(bucket).upload(objPath, buf, { contentType, upsert: true });
    if (error) throw new Error(error.message || String(error));
}

function noteFail(what, err) {
    log(what + ' failed: ' + (err && err.message ? err.message : err));
    try { auditLog('website_sync', '[clubImages] ' + what + ' failed: ' + (err && err.message ? err.message : err), { error: String(err && err.message) }, 'error'); } catch (e) { /* ignore */ }
}

async function uploadPostImage(shortcode, club, io, cdnUrl) {
    const nulls = { imageUrl: null, imagePath: null };
    try {
        const sc = String(shortcode == null ? '' : shortcode);
        const user = normUser(club && typeof club === 'object' ? club.username : club);
        if (!SAFE_CODE.test(sc) || !user || !SAFE_USER.test(user)) { log('skip: bad shortcode or club'); return nulls; }
        const m = mode('uploadPostImage');
        if (m === 'disabled' || m === 'not_configured') { log('skip ' + sc + ': website sync ' + m); return nulls; }
        if (m === 'live' && checkHost('upload ' + POSTS_BUCKET + '/' + user + '/' + sc)) return nulls;
        const I = Object.assign({}, defaultIo, io || {});
        const dry = m === 'dev' || m === 'dry';
        let buf = null; let ext; let contentType; let from;
        const local = await localSource(THUMB_DIR, sc, I);
        if (local) {
            buf = local.buf; ext = local.ext; contentType = local.contentType; from = 'local';
        } else if (isHttp(cdnUrl)) {
            if (dry) { ext = guessExt(cdnUrl); from = 'cdn, not fetched, ext guessed'; }
            else {
                let d;
                try { d = await I.download(cdnUrl); } catch (e) { log('skip ' + sc + ': cdn download: ' + e.message); return nulls; }
                const ct = d && String(d.contentType || '').toLowerCase();
                if (!d || !d.buf || !d.buf.length || !TYPE_EXT[ct]) { log('skip ' + sc + ': cdn response is not a usable image'); return nulls; }
                if (d.buf.length > MAX_BYTES) { log('skip ' + sc + ': cdn image too large'); return nulls; }
                buf = d.buf; contentType = ct; ext = TYPE_EXT[ct]; from = 'cdn';
            }
        } else {
            log('skip ' + sc + ': no image source');
            return nulls;
        }
        const imagePath = user + '/' + sc + '.' + ext;
        const imageUrl = publicUrl(POSTS_BUCKET, imagePath, dry);
        if (!imageUrl) { log('skip ' + sc + ': WEBSITE_SUPABASE_URL not set'); return nulls; }
        if (dry) {
            log('[' + (m === 'dev' ? 'DEV_MODE' : 'DRY RUN') + ', nothing uploaded] would upload ' + POSTS_BUCKET + '/' + imagePath + ' (' + from + ') -> ' + imageUrl);
            return { imageUrl, imagePath };
        }
        await putObject(POSTS_BUCKET, imagePath, buf, contentType);
        return { imageUrl, imagePath };
    } catch (err) {
        noteFail('post image ' + shortcode, err);
        return nulls;
    }
}

async function uploadAvatar(club, io) {
    try {
        const user = normUser(club && typeof club === 'object' ? club.username : club);
        if (!user || !SAFE_USER.test(user)) { log('skip avatar: bad club'); return null; }
        const m = mode('uploadAvatar');
        if (m === 'disabled' || m === 'not_configured') { log('skip avatar ' + user + ': website sync ' + m); return null; }
        if (m === 'live' && checkHost('upload ' + AVATARS_BUCKET + '/' + user)) return null;
        const I = Object.assign({}, defaultIo, io || {});
        const buf = await I.readLocal(path.join(DP_DIR, user + '.jpg'));
        if (!buf || !buf.length) { log('skip avatar ' + user + ': no local dp'); return null; }
        if (buf.length > MAX_BYTES) { log('skip avatar ' + user + ': dp too large'); return null; }
        const objPath = user + '.jpg';
        const dry = m === 'dev' || m === 'dry';
        const url = publicUrl(AVATARS_BUCKET, objPath, dry);
        if (!url) { log('skip avatar ' + user + ': WEBSITE_SUPABASE_URL not set'); return null; }
        if (dry) {
            log('[' + (m === 'dev' ? 'DEV_MODE' : 'DRY RUN') + ', nothing uploaded] would upload ' + AVATARS_BUCKET + '/' + objPath + ' -> ' + url);
            return url;
        }
        await putObject(AVATARS_BUCKET, objPath, buf, 'image/jpeg');
        return url;
    } catch (err) {
        noteFail('avatar ' + club, err);
        return null;
    }
}

module.exports = {
    uploadPostImage, uploadAvatar, publicUrl, defaultIo, checkHost, targetHost,
    POSTS_BUCKET, AVATARS_BUCKET, MAX_BYTES, THUMB_DIR
};
