'use strict';
// Network + browser io: post images, profile name/DP, cookies. Holds nameCache/dpFailAt state.
const fs = require('fs');
const path = require('path');
const { ROOT, DP_DIR, COOKIE_FILE } = require('./socialPaths');
const { normUser, clubsStore } = require('./socialClubs');
const { isHttp } = require('./socialFormat');
const DP_TTL_MS = 7 * 24 * 3600 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ network + browser io
const decodeAmp = (u) => String(u).replace(/&amp;/g, '&');

async function httpGet(url) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const type = res.headers.get('content-type') || '';
    if (!/^image\//i.test(type)) throw new Error('not an image (' + type + ')');
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 8 * 1024 * 1024) throw new Error('bad image size ' + buf.length);
    return buf;
}

async function applyCookies(page) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')); } catch (e) { throw new Error('saved cookies unreadable (run /insta-login)'); }
    const list = (Array.isArray(raw) ? raw : (raw.cookies || [])).filter((c) => c && c.name && c.value != null);
    const cookies = list.map((c) => {
        const o = { name: c.name, value: String(c.value), domain: c.domain || '.instagram.com', path: c.path || '/' };
        if (c.httpOnly != null) o.httpOnly = !!c.httpOnly;
        if (c.secure != null) o.secure = !!c.secure;
        const exp = Number(c.expires || c.expirationDate);
        if (Number.isFinite(exp) && exp > 0) o.expires = exp;
        return o;
    });
    if (!cookies.length) throw new Error('no saved cookies (run /insta-login)');
    if (typeof page.setCookie === 'function') { await page.setCookie(...cookies); return; }
    if (typeof page.context === 'function') { await page.context().addCookies(cookies); return; }
    throw new Error('page exposes neither setCookie nor context().addCookies');
}

// Open `url` in the shared browser with saved cookies, run fn in the page.
async function browserEval(url, fn, arg) {
    const { withPage } = require('../scrapers/browser');
    let out;
    await withPage(async (page) => {
        await applyCookies(page);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        if (/\/accounts\/login|\/challenge/.test(page.url())) throw new Error('redirected to login (run /insta-login)');
        try { await page.waitForSelector('meta[property="og:image"], header img', { timeout: 8000 }); } catch (e) { /* read what is there */ }
        await sleep(800);
        out = await page.evaluate(fn, arg);
    });
    return out;
}

function pageProbe(handle) {
    const meta = (p) => { const m = document.querySelector('meta[property="' + p + '"]'); return m ? m.content : null; };
    const img = document.querySelector('header img[alt*="profile picture" i]') || document.querySelector('img[alt*="profile picture" i]');
    const h1 = document.querySelector('header h1');
    let headerName = null;
    for (const sp of document.querySelectorAll('header span')) {
        const t = (sp.textContent || '').trim();
        if (t.length < 2 || t.length > 60 || t.toLowerCase() === handle || /followers?|following|posts?\b|^\d/i.test(t)) continue;
        headerName = t; break;
    }
    return { ogTitle: meta('og:title'), docTitle: document.title || null, ogImage: meta('og:image'), avatarSrc: img ? img.src : null, h1: h1 ? (h1.textContent || '').trim() : null, headerName };
}

// "Name (@handle) \u2022 Instagram photos and videos" -> "Name"
function parseDisplayName(info, handle) {
    if (!info) return null;
    const h = normUser(handle);
    const cands = [];
    for (const t of [info.ogTitle, info.docTitle]) {
        const m = String(t || '').match(/^(.*?)\s*\(@[^)]+\)/);
        if (m) cands.push(m[1]);
    }
    cands.push(info.h1, info.headerName);
    for (const c of cands) {
        const n = String(c || '').replace(/\s+/g, ' ').trim();
        if (n.length >= 2 && n.toLowerCase() !== h && n.toLowerCase() !== '@' + h) return n.slice(0, 100);
    }
    return null;
}

const nameCache = new Map();
const dpFailAt = new Map();

const defaultIo = {
    readLocal: async (p) => { try { return fs.readFileSync(path.resolve(ROOT, p)); } catch (e) { return null; } },
    download: (url) => httpGet(url),
    fetchHtml: (url) => require('./socialEnrich').fetchHtmlSafe(url),
    fetchImage: (url) => require('./socialEnrich').fetchImageSafe(url),
    async ogImage(pageUrl) {
        const info = await browserEval(pageUrl, pageProbe, '');
        if (!info || !info.ogImage) throw new Error('no og:image on post page');
        return httpGet(decodeAmp(info.ogImage));
    },
    getName: (u) => nameCache.get(u) || null,
    async refreshProfile(username) {
        const errors = [];
        let dp = null; let displayName = null; let info = null;
        try { info = await browserEval('https://www.instagram.com/' + username + '/', pageProbe, username); }
        catch (e) { errors.push('profile page: ' + e.message); }
        if (info) {
            displayName = parseDisplayName(info, username);
            if (!displayName) errors.push('name: not found on profile page');
            const src = info.avatarSrc || info.ogImage;
            if (!src) errors.push('dp: no profile-picture <img> or og:image on profile page');
            else {
                try {
                    dp = await httpGet(decodeAmp(src));
                    fs.mkdirSync(DP_DIR, { recursive: true });
                    fs.writeFileSync(path.join(DP_DIR, username + '.jpg'), dp);
                } catch (e) { errors.push('dp download: ' + e.message); }
            }
        }
        if (displayName) {
            nameCache.set(username, displayName);
            try { clubsStore.update(username, { displayName }); } catch (e) { errors.push('store: ' + e.message); }
        }
        if (errors.length) console.warn(`[social-post] refresh ${username}: ${errors.join(' | ')}`);
        return { dp, displayName, errors };
    },
    async getDp(username) {
        const file = path.join(DP_DIR, username + '.jpg');
        let cached = null; let fresh = false;
        try { const st = fs.statSync(file); cached = fs.readFileSync(file); fresh = Date.now() - st.mtimeMs < DP_TTL_MS; } catch (e) { /* none yet */ }
        if (cached && fresh) return cached;
        if (Date.now() - (dpFailAt.get(username) || 0) < 10 * 60 * 1000) return cached;
        const r = await defaultIo.refreshProfile(username);
        if (!r.dp) dpFailAt.set(username, Date.now());
        return r.dp || cached;
    }
};

// Image fallback order: local file -> download thumbnailUrl -> browser og:image of the post page.
async function resolveImage(item, io = defaultIo) {
    const failed = [];
    if (item.localThumbPath) {
        try { const b = await io.readLocal(item.localThumbPath); if (b && b.length) return { buf: b, step: 'local', failed }; failed.push('local: file missing'); }
        catch (e) { failed.push('local: ' + e.message); }
    }
    const turl = item.thumbnailUrl || item.thumb || item.thumbnail;
    if (isHttp(turl)) {
        try { return { buf: await io.download(turl), step: 'download', failed }; }
        catch (e) { failed.push('download: ' + e.message); }
    }
    const purl = item.url || item.link;
    if (isHttp(purl)) {
        try { return { buf: await io.ogImage(purl), step: 'og', failed }; }
        catch (e) { failed.push('og:image: ' + e.message); }
    }
    return { buf: null, step: null, failed };
}

module.exports = { defaultIo, resolveImage, parseDisplayName, sleep };
