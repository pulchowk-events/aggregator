'use strict';
// src/scrapers/extractors/social/instagram.js
// S2: pure extraction of new posts/reels from a list of public club profiles.
// No LLM, no classification, no posting. Caption is captured verbatim.
//
// Contract (same as every extractor): { extract(page, { progress, meta }), preprocessItem }.
// extract() never throws on expected failures (dead session, challenge, layout
// change); it sets meta flags and returns, so runSource's withRetry does not
// hammer Instagram with retries.
//
// Data plan (from the S2 fixtures):
//   - Profile page embedded JSON carries NO post data. The grid DOM is the source:
//     one page.content() per profile, parsed by parseTilesFromHtml().
//   - Reel tiles: img[alt] IS the full caption (9/9 observed) -> no detail visit.
//   - Photo tiles: img[alt] is auto text ("Photo by X on <date>...") -> caption
//     needs a detail visit (capped per profile), via insta-detail-parse.
//   - Time: decoded from the shortcode (ms precision), not from the DOM order.
//   - Cold start: first run per profile seeds seen-store and returns nothing.
//
// Config (env, all optional): IG_MIN_INTERVAL_HOURS=24 IG_MAX_PROFILES_PER_RUN=5
//   IG_SINCE_HOURS=72 IG_MAX_DETAIL_PER_PROFILE=3 IG_JITTER_MIN_MS=30000
//   IG_JITTER_MAX_MS=90000 IG_CHALLENGE_COOLDOWN_HOURS=12 IG_DOWNLOAD_THUMBS=1
//   IG_FORCE_RESEED=1 (one-shot: bypass interval, mark everything seen, return nothing)

const fs = require('fs');
const path = require('path');
const { decodeShortcodeTimestamp } = require('../../lib/insta-shortcode');
const { createSeenStore, addSeen, USERNAME_RE } = require('../../lib/insta-seen-store');
const { parseAttrs, decodeHtmlEntities, toIsoDate, TAG_ATTRS, parseDetailHtml } = require('../../lib/insta-detail-parse');

const SRC_DIR = path.resolve(__dirname, '..', '..', '..');
const ROOT_DIR = path.resolve(SRC_DIR, '..');
const CLUBS_FILE = require('path').resolve(__dirname, '..', '..', '..', '..', 'data', 'instagram', 'clubs.json');
const COOKIE_FILE = path.join(ROOT_DIR, 'data', 'instagram', 'cookies.json');
const THUMB_DIR = path.join(ROOT_DIR, 'data', 'instagram', 'thumbs');
const IG_ORIGIN = 'https://www.instagram.com';
const HOUR_MS = 3600000;

// ---------------------------------------------------------------- small helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randBetween = (lo, hi) => (hi <= lo ? lo : lo + Math.floor(Math.random() * (hi - lo + 1)));

function audit(message, data, level) {
    try {
        require('../../../core/auditLogger').auditLog('instagram_scrape', message, data || {}, level || 'info');
    } catch (e) { /* best effort */ }
}

function envNum(env, name, def, min) {
    const raw = env[name];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? n : def;
}

function readConfig(env = process.env) {
    return {
        minIntervalMs: envNum(env, 'IG_MIN_INTERVAL_HOURS', 24, 0) * HOUR_MS,
        maxProfiles: Math.floor(envNum(env, 'IG_MAX_PROFILES_PER_RUN', 5, 1)),
        sinceHours: envNum(env, 'IG_SINCE_HOURS', 72, 1),
        maxDetail: Math.floor(envNum(env, 'IG_MAX_DETAIL_PER_PROFILE', 3, 0)),
        jitterMinMs: envNum(env, 'IG_JITTER_MIN_MS', 30000, 0),
        jitterMaxMs: envNum(env, 'IG_JITTER_MAX_MS', 90000, 0),
        cooldownMs: envNum(env, 'IG_CHALLENGE_COOLDOWN_HOURS', 12, 0) * HOUR_MS,
        forceReseed: /^(1|true|yes|on)$/i.test(String(env.IG_FORCE_RESEED || '')),
        downloadThumbs: !/^(0|false|no|off)$/i.test(String(env.IG_DOWNLOAD_THUMBS || ''))
    };
}

// ---------------------------------------------------------------- clubs file

// Accepts ["user", {"username":"user","label":"X","enabled":false}, ...]
function loadClubs(file) {
    const out = { clubs: [], invalid: [] };
    let list;
    try {
        list = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        out.error = e.code === 'ENOENT' ? 'clubs file missing' : ('clubs file unreadable: ' + e.message);
        return out;
    }
    if (!Array.isArray(list)) { out.error = 'clubs file is not an array'; return out; }
    const have = new Set();
    for (const entry of list) {
        const obj = typeof entry === 'string' ? { username: entry } : entry;
        if (!obj || typeof obj.username !== 'string') { out.invalid.push(String(entry)); continue; }
        if (obj.enabled === false) continue;
        const username = obj.username.trim().replace(/^@/, '').toLowerCase();
        if (!USERNAME_RE.test(username)) { out.invalid.push(obj.username); continue; }
        if (have.has(username)) continue;
        have.add(username);
        out.clubs.push({ username, label: typeof obj.label === 'string' ? obj.label : username });
    }
    return out;
}

// ---------------------------------------------------------------- cookies / session

function normalizeCookie(c) {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') return null;
    const out = { name: c.name, value: c.value, path: c.path || '/' };
    if (c.domain) out.domain = c.domain; else out.url = IG_ORIGIN;
    if (typeof c.expires === 'number' && c.expires > 0) out.expires = c.expires;
    else if (typeof c.expirationDate === 'number' && c.expirationDate > 0) out.expires = c.expirationDate;
    if (typeof c.httpOnly === 'boolean') out.httpOnly = c.httpOnly;
    if (typeof c.secure === 'boolean') out.secure = c.secure;
    const ss = String(c.sameSite || '').toLowerCase();
    if (ss === 'strict') out.sameSite = 'Strict';
    else if (ss === 'lax') out.sameSite = 'Lax';
    else if (ss === 'none' || ss === 'no_restriction') { out.sameSite = 'None'; if (out.secure === undefined) out.secure = true; }
    return out;
}

function hasSessionCookies(cookies, nowMs = Date.now()) {
    const ok = (name) => (cookies || []).some((c) =>
        c.name === name && c.value && !(typeof c.expires === 'number' && c.expires > 0 && c.expires * 1000 < nowMs));
    return ok('sessionid') && ok('ds_user_id');
}

function readCookieFile(file) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, reason: 'no_cookie_file' }; }
    let j;
    try { j = JSON.parse(raw); } catch (e) { return { ok: false, reason: 'cookie_file_unparseable' }; }
    const list = Array.isArray(j) ? j : (j && Array.isArray(j.cookies) ? j.cookies : null);
    if (!list) return { ok: false, reason: 'cookie_file_bad_shape' };
    const cookies = list.map(normalizeCookie).filter(Boolean);
    let stampMs = Date.parse(j && j.savedAt);
    if (Number.isNaN(stampMs)) { try { stampMs = fs.statSync(file).mtimeMs; } catch (e) { stampMs = 0; } }
    if (!hasSessionCookies(cookies)) return { ok: false, reason: 'cookies_missing_or_expired', stampMs };
    return { ok: true, cookies, stampMs };
}

async function injectCookies(page, cookies) {
    if (typeof page.setCookie === 'function') { await page.setCookie(...cookies); return; }
    const ctx = typeof page.context === 'function' ? page.context() : null;
    if (ctx && typeof ctx.addCookies === 'function') { await ctx.addCookies(cookies); return; }
    throw new Error('page exposes neither setCookie nor context().addCookies');
}

async function readCookieNames(page) {
    try {
        let list;
        if (typeof page.cookies === 'function') list = await page.cookies(IG_ORIGIN);
        else if (typeof page.context === 'function') list = await page.context().cookies(IG_ORIGIN);
        else return null;
        return new Set((list || []).filter((c) => c.value).map((c) => c.name));
    } catch (e) {
        return null;
    }
}

// ---------------------------------------------------------------- page state

// Runs inside the browser; must not close over anything.
function probeProfileInPage(username) {
    var lower = String(username).toLowerCase();
    var nodes = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    var anchors = 0;
    for (var i = 0; i < nodes.length; i++) {
        var h = String(nodes[i].getAttribute('href') || '').toLowerCase();
        if (h.indexOf('/' + lower + '/p/') === 0 || h.indexOf('/' + lower + '/reel/') === 0) anchors++;
    }
    var text = (document.body && document.body.innerText) ? document.body.innerText : '';
    return {
        url: location.href,
        title: document.title || '',
        anchors: anchors,
        hasHeader: !!document.querySelector('header'),
        hasLoginForm: !!document.querySelector('input[name="password"]'),
        bodyText: text.slice(0, 800)
    };
}

// Pure. States: loading | ok | empty | login | challenge | not_found | private | layout_changed
function classifyProfileState(probe, { timedOut = false } = {}) {
    if (!probe) return timedOut ? 'layout_changed' : 'loading';
    const url = String(probe.url || '').toLowerCase();
    const text = String(probe.bodyText || '');
    if (/\/accounts\/login|\/accounts\/emailsignup/.test(url)) return 'login';
    if (/\/challenge\/|\/suspended\/|\/checkpoint\/|\/accounts\/suspended/.test(url)) return 'challenge';
    // A logged-out profile still shows tiles plus a login dialog, so the form check comes first.
    if (probe.hasLoginForm) return 'login';
    if (probe.anchors >= 1) return 'ok';
    if (/(sorry, )?this page isn['\u2019]?t available|the link you followed may be broken/i.test(text)) return 'not_found';
    if (/confirm (that )?it['\u2019]?s you|suspicious activity|automated behavio/i.test(text)) return 'challenge';
    if (/this account is private/i.test(text)) return 'private';
    if (probe.hasHeader && /\bno posts yet\b/i.test(text)) return 'empty';
    return timedOut ? 'layout_changed' : 'loading';
}

async function waitForProfile(page, username, { timeoutMs = 30000, pollMs = 700, sleep: sleepFn = sleep } = {}) {
    const started = Date.now();
    let prevAnchors = -1;
    let lastProbe = null;
    for (;;) {
        let probe = null;
        try { probe = await page.evaluate(probeProfileInPage, username); } catch (e) { probe = null; }
        lastProbe = probe;
        const elapsed = Date.now() - started;
        const timedOut = elapsed >= timeoutMs;
        const state = classifyProfileState(probe, { timedOut });
        if (state === 'ok') {
            if (probe.anchors === prevAnchors || timedOut) return { state, probe };
            prevAnchors = probe.anchors;
        } else if (state !== 'loading') {
            return { state, probe };
        }
        if (timedOut) return { state: 'layout_changed', probe: lastProbe };
        await sleepFn(pollMs);
    }
}

// ---------------------------------------------------------------- tiles (pure)

const AUTO_ALT_RE = /^(?:Photo|Video|Reel|Clip)s?(?: shared)? by\b[^\n]*? on ([A-Z][a-z]+) (\d{1,2}), (\d{4})/;
const TILE_HREF_RE = /^\/([A-Za-z0-9._]+)\/(p|reel)\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/;

// attributes are decoded once by parseAttrs; decode once more because the grid
// alt text was observed carrying a literal "&amp;" (double-encoded at the source).
function normalizeAlt(raw) {
    if (typeof raw !== 'string') return '';
    return decodeHtmlEntities(raw).replace(/\r\n?/g, '\n').trim();
}

function classifyAlt(rawAlt) {
    const alt = normalizeAlt(rawAlt);
    if (!alt) return { kind: 'none', text: null, altDate: null };
    const m = AUTO_ALT_RE.exec(alt);
    if (m) return { kind: 'auto', text: null, altDate: toIsoDate(m[1], m[2], m[3]) };
    return { kind: 'text', text: alt, altDate: null };
}

function iconKindFromLabels(labels) {
    if (labels.some((l) => /carousel|album/i.test(l))) return 'carousel';
    if (labels.some((l) => /clip|reel/i.test(l))) return 'clip';
    if (labels.some((l) => /video/i.test(l))) return 'video';
    return null;
}

function parseTilesFromHtml(html, username) {
    const tiles = [];
    if (typeof html !== 'string' || !username) return tiles;
    const lower = String(username).toLowerCase();
    const re = new RegExp('<a\\b' + TAG_ATTRS + '>([\\s\\S]*?)<\\/a>', 'gi');
    const have = new Set();
    let m;
    while ((m = re.exec(html)) !== null) {
        const href = parseAttrs(m[1]).href;
        if (!href) continue;
        const hm = TILE_HREF_RE.exec(href);
        if (!hm || hm[1].toLowerCase() !== lower) continue;
        const code = hm[3];
        if (have.has(code)) continue;
        have.add(code);
        const inner = m[2];
        const imgMatch = new RegExp('<img\\b' + TAG_ATTRS + '>', 'i').exec(inner);
        const img = imgMatch ? parseAttrs(imgMatch[1]) : {};
        const labels = [];
        const svgRe = new RegExp('<svg\\b' + TAG_ATTRS + '>', 'gi');
        let sm;
        while ((sm = svgRe.exec(inner)) !== null) {
            const label = parseAttrs(sm[1])['aria-label'];
            if (label) labels.push(label);
        }
        tiles.push({
            code,
            kind: hm[2] === 'reel' ? 'reel' : 'post',
            href,
            alt: typeof img.alt === 'string' ? img.alt : '',
            thumbnailUrl: img.src || null,
            labels,
            iconKind: iconKindFromLabels(labels),
            isPinned: labels.some((l) => /pinned/i.test(l)),
            domIndex: tiles.length
        });
    }
    return tiles;
}

function makeTitle(club, caption, kind) {
    const line = String(caption || '').split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
    const base = line ? (line.length > 100 ? line.slice(0, 97) + '...' : line) : ('Instagram ' + kind);
    return club + ': ' + base;
}

function tileTimeMs(tile, nowMs) {
    const ms = decodeShortcodeTimestamp(tile.code, { nowMs });
    if (ms) return ms;
    const alt = classifyAlt(tile.alt);
    return alt.altDate ? Date.parse(alt.altDate + 'T12:00:00Z') : null;
}

function buildItemFromTile(tile, { club, nowMs = Date.now() }) {
    const takenMs = decodeShortcodeTimestamp(tile.code, { nowMs });
    const alt = classifyAlt(tile.alt);
    const flags = [];
    let takenAt = null;
    let takenAtSource = null;
    if (takenMs) {
        takenAt = new Date(takenMs).toISOString();
        takenAtSource = 'shortcode';
        if (alt.altDate && Math.abs(takenMs - Date.parse(alt.altDate + 'T12:00:00Z')) > 2 * 24 * HOUR_MS) flags.push('takenAt_mismatch');
    } else if (alt.altDate) {
        takenAt = alt.altDate + 'T12:00:00.000Z';
        takenAtSource = 'alt-date';
        flags.push('takenAt_day_precision');
    }

    let mediaType;
    let mediaTypeSource = 'grid-icon';
    if (tile.iconKind === 'carousel') mediaType = 8;
    else if (tile.iconKind === 'clip' || tile.iconKind === 'video' || tile.kind === 'reel') mediaType = 2;
    else { mediaType = 1; mediaTypeSource = 'inferred'; }

    // Only reel alts are trusted as captions (9/9 observed). A /p/ alt that is not
    // the auto text could be custom accessibility text, so it is kept apart.
    let caption = null;
    let captionSource = null;
    let altText = null;
    if (alt.kind === 'text') {
        if (tile.kind === 'reel') { caption = alt.text; captionSource = 'tile-alt'; }
        else altText = alt.text;
    }

    const url = IG_ORIGIN + '/' + (tile.kind === 'reel' ? 'reel' : 'p') + '/' + tile.code + '/';
    return {
        platform: 'instagram',
        source: 'instagram',
        club,
        shortcode: tile.code,
        kind: tile.kind,
        url,
        href: tile.href,
        rawDedupUrl: url,
        title: makeTitle(club, caption, tile.kind),
        caption,
        captionSource,
        altText,
        takenAt,
        takenAtSource,
        mediaType,
        mediaTypeSource,
        productType: null,
        mediaUrl: null,
        thumbnailUrl: tile.thumbnailUrl || null,
        localThumbPath: null,
        placeholderUrl: null,
        children: [],
        isPinned: !!tile.isPinned,
        altDate: alt.altDate,
        flags,
        fetchedAt: new Date(nowMs).toISOString()
    };
}

// Pure. coldStart: seed everything, return nothing. Otherwise unseen tiles
// younger than sinceHours are candidates (newest first); older unseen ones are
// only marked seen (an old post that just got pinned must not read as new).
function selectNewTiles(tiles, { seenSet, nowMs, sinceHours, coldStart }) {
    const allCodes = tiles.map((t) => t.code);
    if (coldStart) return { candidates: [], markSeen: allCodes, stale: 0, seeded: allCodes.length };
    const cutoff = nowMs - sinceHours * HOUR_MS;
    const candidates = [];
    const markSeen = [];
    let stale = 0;
    for (const t of tiles) {
        if (seenSet.has(t.code)) continue;
        markSeen.push(t.code);
        const ms = tileTimeMs(t, nowMs);
        if (ms !== null && ms < cutoff) { stale++; continue; }
        candidates.push(Object.assign({}, t, { takenMs: ms }));
    }
    candidates.sort((a, b) => (b.takenMs || 0) - (a.takenMs || 0));
    return { candidates, markSeen, stale, seeded: 0 };
}

function applyDetail(item, parsed) {
    if (!parsed) return item;
    if (parsed.caption && !item.caption) {
        item.caption = parsed.caption;
        item.captionSource = parsed.captionSource;
        item.title = makeTitle(item.club, item.caption, item.kind);
        if (parsed.captionTruncated) item.flags.push('caption_truncated');
    }
    if (parsed.takenAt) {
        item.takenAt = parsed.takenAt;
        item.takenAtSource = 'detail-json';
        item.flags = item.flags.filter((f) => f !== 'takenAt_day_precision');
    } else if (parsed.takenDate && item.takenAt && Math.abs(Date.parse(item.takenAt) - Date.parse(parsed.takenDate + 'T12:00:00Z')) > 2 * 24 * HOUR_MS) {
        if (!item.flags.includes('takenAt_mismatch')) item.flags.push('takenAt_mismatch');
    }
    if (parsed.mediaType) { item.mediaType = parsed.mediaType; item.mediaTypeSource = 'detail'; }
    if (parsed.productType) item.productType = parsed.productType;
    if (parsed.thumbnailUrl && !item.thumbnailUrl) item.thumbnailUrl = parsed.thumbnailUrl;
    if (parsed.videoUrl) item.mediaUrl = parsed.videoUrl;
    else if (parsed.imageUrl) item.mediaUrl = parsed.imageUrl;
    if (parsed.children && parsed.children.length) item.children = parsed.children.slice(0, 10);
    return item;
}

// ---------------------------------------------------------------- network bits

async function downloadThumb(url, code, dir) {
    if (typeof fetch !== 'function') throw new Error('global fetch unavailable');
    const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'user-agent': 'Mozilla/5.0', accept: 'image/*' }
    });
    if (!res.ok) throw new Error('thumb http ' + res.status);
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('image/') !== 0) throw new Error('thumb not an image: ' + ct);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 5 * 1024 * 1024) throw new Error('thumb size ' + buf.length);
    const ext = ct.includes('webp') ? 'webp' : (ct.includes('png') ? 'png' : 'jpg');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, code + '.' + ext);   // code is [A-Za-z0-9_-] by TILE_HREF_RE
    fs.writeFileSync(file, buf);
    return file;
}

async function fetchDetail(page, item, loadPage) {
    await loadPage(page, item.url, { timeout: 45000 });
    await sleep(randBetween(1500, 3000));
    const finalUrl = String(page.url ? page.url() : '').toLowerCase();
    if (/\/accounts\/login/.test(finalUrl)) return { abort: 'login' };
    if (/\/challenge\/|\/suspended\/|\/checkpoint\//.test(finalUrl)) return { abort: 'challenge' };
    const html = await page.content();
    return { parsed: parseDetailHtml(html, { code: item.shortcode }) };
}

// ---------------------------------------------------------------- one profile

async function extractProfile(page, { club, rec, cfg, nowMs, loadPage, store, meta }) {
    const username = club.username;
    const coldStart = cfg.forceReseed || !rec.exists;
    const out = { state: 'ok', abort: null, items: [], stats: { tiles: 0, new: 0, stale: 0, seeded: 0, details: 0, detailFailures: 0 } };

    meta.pagesVisited++;
    await loadPage(page, IG_ORIGIN + '/' + username + '/', { timeout: 60000 });
    const waited = await waitForProfile(page, username);
    let state = waited.state;
    if (state === 'ok' || state === 'empty') {
        const names = await readCookieNames(page);
        if (names && !names.has('sessionid')) state = 'login';
    }
    out.state = state;
    const fetchedAt = new Date(nowMs).toISOString();

    if (state === 'empty') {
        store.save(username, { seen: rec.seen, lastFetchedAt: fetchedAt });
        return out;
    }
    if (state !== 'ok') return out;

    const tiles = parseTilesFromHtml(await page.content(), username);
    out.stats.tiles = tiles.length;
    meta.listingHits += tiles.length;
    if (tiles.length === 0) { out.state = 'layout_changed'; return out; }
    if (tiles.filter((t) => t.isPinned).length > 3 || tiles.some((t) => t.isPinned && t.domIndex > 5)) meta.pinSanityWarn = true;

    const sel = selectNewTiles(tiles, { seenSet: new Set(rec.seen), nowMs, sinceHours: cfg.sinceHours, coldStart });
    out.stats.seeded = sel.seeded;
    out.stats.stale = sel.stale;
    out.stats.new = sel.candidates.length;

    const items = sel.candidates.map((t) => buildItemFromTile(t, { club: username, nowMs }));

    let budget = cfg.maxDetail;
    for (const item of items) {
        if (item.caption) continue;
        if (out.abort) { item.flags.push('detail_aborted'); continue; }
        if (budget <= 0) { item.flags.push('detail_skipped_cap'); continue; }
        budget--;
        out.stats.details++;
        meta.detailPagesVisited++;
        let d;
        try {
            d = await fetchDetail(page, item, loadPage);
        } catch (e) {
            out.stats.detailFailures++;
            meta.detailParseFailures++;
            item.flags.push('detail_error');
            continue;
        }
        if (d.abort) { out.abort = d.abort; item.flags.push('detail_aborted'); continue; }
        if (!d.parsed.found.json && !d.parsed.found.og) {
            out.stats.detailFailures++;
            meta.detailParseFailures++;
            item.flags.push('detail_unparsed');
        }
        applyDetail(item, d.parsed);
    }

    for (const item of items) {
        if (cfg.downloadThumbs && item.thumbnailUrl) {
            try {
                const file = await downloadThumb(item.thumbnailUrl, item.shortcode, THUMB_DIR);
                item.localThumbPath = path.relative(ROOT_DIR, file).split(path.sep).join('/');
            } catch (e) {
                meta.thumbFailures = (meta.thumbFailures || 0) + 1;
                item.flags.push('thumb_download_failed');
            }
        }
        if (!item.thumbnailUrl && !item.localThumbPath) {
            try { item.placeholderUrl = require('../../ogImage').derivePlaceholderForSource('instagram') || null; } catch (e) { /* none */ }
        }
    }

    store.save(username, { seen: addSeen(rec.seen, sel.markSeen), lastFetchedAt: fetchedAt });
    out.items = items;
    return out;
}

// ---------------------------------------------------------------- entry point

async function extract(page, { progress, meta } = {}) {
    meta = meta || {};
    for (const k of ['pagesVisited', 'listingHits', 'detailPagesVisited', 'detailParseFailures']) meta[k] = meta[k] || 0;
    meta.profileErrors = [];
    const ig = meta.instagram = { clubs: 0, due: 0, fetched: 0, seeded: 0, returned: 0, throttled: 0, perClub: {} };
    const items = [];
    const cfg = readConfig();
    const store = createSeenStore();
    const nowMs = Date.now();

    const loaded = loadClubs(CLUBS_FILE);
    ig.clubs = loaded.clubs.length;
    if (loaded.invalid.length) ig.invalidClubs = loaded.invalid;
    if (loaded.clubs.length === 0) { meta.noClubs = true; if (loaded.error) ig.clubsError = loaded.error; return { items, meta }; }

    const state = store.readState();
    if (state.challengeCooldownUntil && Date.parse(state.challengeCooldownUntil) > nowMs) {
        meta.cooldownActive = true;
        meta.cooldownUntil = state.challengeCooldownUntil;
        return { items, meta };
    }

    const cookieInfo = readCookieFile(COOKIE_FILE);
    const markDead = (reason, persist) => {
        meta.sessionDead = true;
        meta.sessionDeadReason = reason;
        if (persist) { try { store.patchState({ sessionDeadAt: new Date().toISOString() }); } catch (e) { /* ignore */ } }
        audit('Instagram session unusable: ' + reason, { reason }, 'error');
    };
    if (!cookieInfo.ok) { markDead(cookieInfo.reason, cookieInfo.reason === 'cookies_missing_or_expired'); return { items, meta }; }
    if (state.sessionDeadAt && !(cookieInfo.stampMs > Date.parse(state.sessionDeadAt))) {
        meta.sessionDead = true;
        meta.sessionDeadReason = 'previously_dead_no_newer_cookies';
        return { items, meta };
    }

    const only = String(process.env.IG_ONLY_CLUB || '');
    const due = [];
    for (const club of loaded.clubs) {
        if (only && club.username !== only) continue;
        const rec = store.load(club.username);
        if (only || cfg.forceReseed || store.isDue(rec, nowMs, cfg.minIntervalMs)) due.push({ club, rec });
        else { ig.throttled++; ig.perClub[club.username] = { skipped: 'not_due' }; }
    }
    due.sort((a, b) => (Date.parse(a.rec.lastFetchedAt) || 0) - (Date.parse(b.rec.lastFetchedAt) || 0));
    const batch = due.slice(0, only ? due.length : cfg.maxProfiles);
    ig.due = batch.length;
    if (batch.length === 0) return { items, meta };

    try {
        await injectCookies(page, cookieInfo.cookies);
        if (typeof page.setExtraHTTPHeaders === 'function') await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    } catch (e) {
        meta.profileErrors.push({ club: '*', error: 'cookie/header setup failed: ' + e.message });
        return { items, meta };
    }

    const { loadPage } = require('../../page');
    for (let i = 0; i < batch.length; i++) {
        if (i > 0) await sleep(randBetween(cfg.jitterMinMs, Math.max(cfg.jitterMinMs, cfg.jitterMaxMs)));
        const { club, rec } = batch[i];
        let r;
        try {
            r = await extractProfile(page, { club, rec, cfg, nowMs, loadPage, store, meta });
        } catch (e) {
            ig.perClub[club.username] = { error: e.message };
            meta.profileErrors.push({ club: club.username, error: e.message });
            continue;
        }
        ig.perClub[club.username] = Object.assign({ state: r.state }, r.stats);
        if (r.state === 'ok' || r.state === 'empty') {
            ig.fetched++;
            ig.seeded += r.stats.seeded;
            if (state.sessionDeadAt) { try { store.patchState({ sessionDeadAt: null }); } catch (e) { /* ignore */ } }
        }
        items.push(...r.items);

        if (r.state === 'login' || r.abort === 'login') { markDead('login_redirect_or_sessionid_cleared', true); break; }
        if (r.state === 'challenge' || r.abort === 'challenge') {
            meta.challenge = true;
            meta.looksBlocked = true;
            try { store.patchState({ challengeCooldownUntil: new Date(Date.now() + cfg.cooldownMs).toISOString() }); } catch (e) { /* ignore */ }
            audit('Instagram challenge hit on @' + club.username + ' - run aborted, cooldown set', { club: club.username }, 'error');
            break;
        }
        if (r.state === 'layout_changed') {
            meta.layoutChanged = true;
            audit('Instagram profile layout not recognised for @' + club.username, { club: club.username }, 'error');
        }
    }

    if (ig.fetched > 0 && meta.detailPagesVisited > 0 && meta.detailParseFailures * 2 > meta.detailPagesVisited) {
        meta.detailLayoutChanged = true;
        audit('Instagram detail pages: more than half failed to parse', { visited: meta.detailPagesVisited, failed: meta.detailParseFailures }, 'warn');
    }
    ig.returned = items.length;
    return { items, meta };
}

function preprocessItem(item) {
    return item;
}

module.exports = {
    extract,
    preprocessItem,
    _internal: {
        readConfig, loadClubs, normalizeCookie, hasSessionCookies, classifyProfileState, waitForProfile,
        parseTilesFromHtml, classifyAlt, buildItemFromTile, selectNewTiles, applyDetail, makeTitle,
        probeProfileInPage
    }
};
