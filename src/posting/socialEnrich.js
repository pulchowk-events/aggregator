'use strict';
// Link enrichment for club posts: og:image / og:title of the first external link in a caption.
// Never blocks a post: every failure or timeout falls through to the Instagram thumbnail.
// IG_ENRICH=0 disables. Cache: data/instagram/enrich-cache.json (override: IG_ENRICH_CACHE).
// SSRF guard: http/https only, ports 80/443, no credentials, every hop's DNS answers must be public,
// manual redirects (max 3), size and time caps. Known gap: we resolve DNS ourselves and fetch resolves
// again (small DNS-rebinding window); closing it needs a pinned-IP dispatcher, not worth a dependency here.
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const net = require('net');
const { writeJsonAtomic } = require('../core/jsonStore');
const { ROOT } = require('./socialPaths');
const { clip } = require('./socialFormat');

let sanitizeImageUrl = null;
try {
    const s = require('../scrapers/sanitize');
    if (s && typeof s.sanitizeImageUrl === 'function') sanitizeImageUrl = s.sanitizeImageUrl;
} catch (e) { /* optional: no sanitizer available */ }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HTML_MAX = 512 * 1024;
const IMG_MAX = 8 * 1024 * 1024;
const HOP_TIMEOUT_MS = 5000;
const OVERALL_TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 3;
const TTL_OK_MS = 7 * 24 * 3600 * 1000;
const TTL_FAIL_MS = 6 * 3600 * 1000;
const CACHE_MAX = 500;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const IG_HOSTS = ['instagram.com', 'cdninstagram.com', 'ig.me', 'instagr.am'];
// Pages whose og:image is a generic icon, not the real poster: never fetched.
const HARD_DENY = ['forms.gle', 'docs.google.com', 'linktr.ee'];
// Shorteners are followed, but a shortener that is still the FINAL host is denied.
const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'is.gd', 'goo.gl', 'ow.ly', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'rb.gy', 'lnkd.in'];

const hostMatches = (host, list) => list.some((d) => host === d || host.endsWith('.' + d));
function hostOf(href) { try { return new URL(href).hostname.toLowerCase().replace(/\.$/, ''); } catch (e) { return ''; } }

// ------------------------------------------------------------ ip + url guard
function v4Public(ip) {
    const p = String(ip).split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const a = p[0], b = p[1], c = p[2];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a >= 224) return false;
    return true;
}
function expandV6(ip) {
    let s = String(ip).toLowerCase().split('%')[0];
    if (s.indexOf('.') >= 0) {
        const i = s.lastIndexOf(':');
        const q = s.slice(i + 1).split('.').map(Number);
        if (q.length !== 4 || q.some((n) => !(n >= 0 && n <= 255))) return null;
        s = s.slice(0, i + 1) + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16);
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    let groups;
    if (halves.length === 2) {
        const fill = 8 - head.length - tail.length;
        if (fill < 0) return null;
        groups = head.concat(new Array(fill).fill('0'), tail);
    } else groups = head;
    if (groups.length !== 8) return null;
    const nums = groups.map((g) => parseInt(g || '0', 16));
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
    return nums;
}
function v6Public(ip) {
    const g = expandV6(ip);
    if (!g) return false;
    if (g.every((x) => x === 0)) return false;
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false;
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
        return v4Public([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.'));
    }
    const f = g[0];
    if ((f & 0xfe00) === 0xfc00) return false;
    if ((f & 0xffc0) === 0xfe80) return false;
    if ((f & 0xffc0) === 0xfec0) return false;
    if ((f & 0xff00) === 0xff00) return false;
    if (f === 0x64 && g[1] === 0xff9b) return false;
    if (f === 0x2001 && g[1] === 0x0db8) return false;
    if (f === 0x2002) return v4Public([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255].join('.'));
    return true;
}
function isPublicIp(ip) {
    const s = String(ip || '').replace(/^\[|\]$/g, '');
    if (net.isIPv4(s)) return v4Public(s);
    if (net.isIPv6(s.split('%')[0])) return v6Public(s);
    return false;
}

function checkUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { throw new Error('bad url'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme not allowed: ' + u.protocol);
    if (u.username || u.password) throw new Error('credentials in url');
    if (u.port && u.port !== '80' && u.port !== '443') throw new Error('port not allowed: ' + u.port);
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host) throw new Error('empty host');
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) throw new Error('local host name');
    if (net.isIP(host) && !isPublicIp(host)) throw new Error('non-public address');
    return u;
}

async function assertPublicHost(u, lookup) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) return;
    let addrs;
    try { addrs = await lookup(host, { all: true }); } catch (e) { throw new Error('dns failed: ' + ((e && e.message) || e)); }
    const list = Array.isArray(addrs) ? addrs : [addrs];
    if (!list.length) throw new Error('dns: no addresses');
    for (const a of list) {
        const ip = typeof a === 'string' ? a : a && a.address;
        if (!isPublicIp(ip)) throw new Error('host resolves to non-public address');
    }
}

// ------------------------------------------------------------ guarded fetch
async function readBody(res, maxBytes, truncate) {
    const len = Number(res.headers && res.headers.get ? res.headers.get('content-length') : NaN);
    if (!truncate && Number.isFinite(len) && len > maxBytes) throw new Error('response too large');
    if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const chunks = [];
        let n = 0;
        for (;;) {
            const r = await reader.read();
            if (r.done) break;
            chunks.push(Buffer.from(r.value));
            n += r.value.length;
            if (n > maxBytes) {
                try { await reader.cancel(); } catch (e) { /* ignore */ }
                if (!truncate) throw new Error('response too large');
                break;
            }
        }
        const all = Buffer.concat(chunks);
        return all.length > maxBytes ? all.subarray(0, maxBytes) : all;
    }
    const b = Buffer.from(await res.arrayBuffer());
    if (b.length > maxBytes) {
        if (!truncate) throw new Error('response too large');
        return b.subarray(0, maxBytes);
    }
    return b;
}

async function safeFetch(startUrl, o = {}) {
    const fetchImpl = o.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
    const lookup = o.lookup || ((h, opt) => dns.promises.lookup(h, opt));
    const timeoutMs = o.timeoutMs || HOP_TIMEOUT_MS;
    let cur = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const u = checkUrl(cur);
        await assertPublicHost(u, lookup);
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
            const res = await fetchImpl(u.href, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': UA, 'Accept': o.accept || '*/*', 'Accept-Language': 'en-US,en;q=0.9' } });
            if (REDIRECTS.has(res.status)) {
                const loc = res.headers && res.headers.get ? res.headers.get('location') : null;
                try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch (e) { /* ignore */ }
                if (!loc) throw new Error('redirect without location');
                cur = new URL(loc, u).href;
                continue;
            }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
            if (o.typeRe && !o.typeRe.test(type)) throw new Error('unexpected content-type: ' + (type || 'none'));
            const buf = await readBody(res, o.maxBytes || HTML_MAX, !!o.truncate);
            return { buf, type, finalUrl: u.href };
        } catch (e) {
            if (e && e.name === 'AbortError') throw new Error('timeout');
            throw e;
        } finally { clearTimeout(timer); }
    }
    throw new Error('too many redirects');
}

async function fetchHtmlSafe(url, o = {}) {
    const r = await safeFetch(url, Object.assign({}, o, { accept: 'text/html,application/xhtml+xml', typeRe: /^(text\/html|application\/xhtml\+xml)/i, maxBytes: HTML_MAX, truncate: true }));
    return { html: r.buf.toString('utf8'), finalUrl: r.finalUrl };
}
async function fetchImageSafe(url, o = {}) {
    const r = await safeFetch(url, Object.assign({}, o, { accept: 'image/*', typeRe: /^image\//i, maxBytes: o.maxBytes || IMG_MAX, truncate: false }));
    if (!r.buf.length) throw new Error('empty image');
    return r.buf;
}

// ------------------------------------------------------------ og parsing
function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
        const k = e.toLowerCase();
        if (k === 'amp') return '&';
        if (k === 'lt') return '<';
        if (k === 'gt') return '>';
        if (k === 'quot') return '"';
        if (k === 'apos') return "'";
        if (k === 'nbsp') return ' ';
        const cp = k.indexOf('#x') === 0 ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        try { return String.fromCodePoint(cp); } catch (e2) { return m; }
    });
}
function parseOg(html, baseUrl) {
    const metas = {};
    for (const m of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
        const attrs = {};
        for (const a of m[0].matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
            attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : a[4]);
        }
        const key = String(attrs.property || attrs.name || '').toLowerCase();
        if (key && attrs.content != null && metas[key] === undefined) metas[key] = decodeEntities(attrs.content).trim();
    }
    const pick = (...ks) => { for (const k of ks) if (metas[k]) return metas[k]; return null; };
    let title = pick('og:title', 'twitter:title');
    if (!title) {
        const t = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        if (t) title = decodeEntities(t[1]);
    }
    title = title ? clip(title.replace(/\s+/g, ' ').trim(), 200) : null;
    let image = pick('og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src');
    if (image) { try { image = new URL(image, baseUrl).href; } catch (e) { image = null; } }
    return { title: title || null, image: image || null };
}

// ------------------------------------------------------------ link picking
const URLISH = /https?:\/\/[^\s<>"'\])]+|www\.[^\s<>"'\])]+|(?<![@\w.-])[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/[^\s<>"'\])]*/gi;

function normalizeUrl(raw) {
    let s = String(raw || '').trim().replace(/^<|>$/g, '');
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
}
// hints.link first, then URLs in the caption; first non-Instagram, non-denied one wins.
function pickLink(item) {
    if (!item) return null;
    const cands = [];
    const h = item.hints && item.hints.link;
    if (typeof h === 'string' && h.trim()) cands.push(h);
    const text = [item.caption, item.description, item.text].filter((x) => typeof x === 'string').join('\n');
    for (const m of text.matchAll(URLISH)) cands.push(m[0].replace(/[.,;:!?)\]]+$/, ''));
    for (const c of cands) {
        const n = normalizeUrl(c);
        if (!n) continue;
        const host = hostOf(n);
        if (!host || hostMatches(host, IG_HOSTS) || hostMatches(host, HARD_DENY)) continue;
        return n;
    }
    return null;
}

// ------------------------------------------------------------ cache (writeJsonAtomic; corrupt file never overwritten)
function createCache(opts = {}) {
    const file = opts.file || process.env.IG_ENRICH_CACHE || path.join(ROOT, 'data', 'instagram', 'enrich-cache.json');
    const now = opts.now || Date.now;
    const ttlOk = opts.ttlOkMs || TTL_OK_MS;
    const ttlFail = opts.ttlFailMs || TTL_FAIL_MS;
    let warned = false;
    function read() {
        let raw;
        try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return (e && e.code === 'ENOENT') ? { data: {} } : { corrupt: true, data: {} }; }
        try {
            const d = JSON.parse(raw);
            if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('shape');
            return { data: d };
        } catch (e) { return { corrupt: true, data: {} }; }
    }
    const fresh = (rec, t) => !!rec && typeof rec.at === 'number' && (t - rec.at) < (rec.ok ? ttlOk : ttlFail);
    return {
        file,
        get(url) {
            const s = read();
            if (s.corrupt) return null;
            const rec = s.data[url];
            return fresh(rec, now()) ? rec : null;
        },
        set(url, rec) {
            const s = read();
            if (s.corrupt) {
                if (!warned) { warned = true; console.warn('[social-enrich] cache file unreadable, caching disabled (left untouched): ' + file); }
                return false;
            }
            const t = now();
            const d = s.data;
            d[url] = Object.assign({}, rec, { at: t });
            for (const k of Object.keys(d)) if (!fresh(d[k], t)) delete d[k];
            const keys = Object.keys(d);
            if (keys.length > CACHE_MAX) keys.sort((a, b) => d[a].at - d[b].at).slice(0, keys.length - CACHE_MAX).forEach((k) => { delete d[k]; });
            try { writeJsonAtomic(file, d, { newline: true }); return true; } catch (e) { console.warn('[social-enrich] cache write failed: ' + e.message); return false; }
        }
    };
}

// ------------------------------------------------------------ enrichment
const inflight = new Map();

// -> { title, image, bytes } (bytes may be null) or null. deps: { io, cache, sanitizeImage, log }
async function enrichLink(rawUrl, deps = {}) {
    const log = deps.log || ((m) => console.warn('[social-enrich] ' + m));
    const io = deps.io;
    if (!io || typeof io.fetchHtml !== 'function') return null;
    const norm = normalizeUrl(rawUrl);
    if (!norm) return null;
    const host = hostOf(norm);
    if (!host || hostMatches(host, IG_HOSTS) || hostMatches(host, HARD_DENY)) return null;
    const cache = deps.cache || createCache();

    let rec = cache.get(norm);
    if (rec && !rec.ok) return null;
    if (!rec) {
        let p = inflight.get(norm);
        if (!p) {
            p = (async () => {
                try {
                    const r = await io.fetchHtml(norm);
                    const finalUrl = (r && r.finalUrl) || norm;
                    const fh = hostOf(finalUrl);
                    if (!fh || hostMatches(fh, IG_HOSTS) || hostMatches(fh, HARD_DENY) || hostMatches(fh, SHORTENERS)) {
                        const x = { ok: false, err: 'denied_host:' + fh };
                        cache.set(norm, x);
                        return x;
                    }
                    const og = parseOg(r && r.html, finalUrl);
                    if (!og.title && !og.image) {
                        const x = { ok: false, err: 'no_og' };
                        cache.set(norm, x);
                        return x;
                    }
                    const x = { ok: true, title: og.title, imageUrl: og.image };
                    cache.set(norm, x);
                    return x;
                } catch (e) {
                    const x = { ok: false, err: String((e && e.message) || e).slice(0, 120) };
                    log('fetch failed for ' + norm + ': ' + x.err);
                    try { cache.set(norm, x); } catch (e2) { /* ignore */ }
                    return x;
                }
            })();
            inflight.set(norm, p);
            p.then(() => { inflight.delete(norm); }, () => { inflight.delete(norm); });
        }
        rec = await p;
        if (!rec.ok) return null;
    }

    let image = rec.imageUrl || null;
    let bytes = null;
    const san = deps.sanitizeImage || sanitizeImageUrl;
    if (image && san) {
        let r;
        try { r = san(image); } catch (e) { r = image; }
        if (typeof r === 'string') image = r || null;
        else if (!r) image = null;
    }
    if (image) {
        const dl = io.fetchImage || io.download;
        if (typeof dl === 'function') {
            try {
                const b = await dl(image);
                if (b && b.length) bytes = b;
            } catch (e) { log('image failed for ' + norm + ': ' + ((e && e.message) || e)); }
        }
    }
    if (!rec.title && !bytes) return null;
    return { title: rec.title || null, image: image || null, bytes };
}

// Hard overall timeout; never throws, resolves null on any failure.
function enrichSafe(url, deps, ms) {
    const limit = ms || OVERALL_TIMEOUT_MS;
    const log = (deps && deps.log) || ((m) => console.warn('[social-enrich] ' + m));
    return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; log('timed out after ' + limit + ' ms: ' + url); resolve(null); } }, limit);
        enrichLink(url, deps).then(
            (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } },
            (e) => { if (!done) { done = true; clearTimeout(timer); log('failed: ' + ((e && e.message) || e)); resolve(null); } }
        );
    });
}

const enabled = (env) => String((env || process.env).IG_ENRICH === undefined ? '1' : (env || process.env).IG_ENRICH) !== '0';

// postItems entry point: skipped when disabled, when io has no fetchHtml, or when the item has no usable link.
async function enrichForItem(item, io, opts = {}) {
    if (!enabled(opts.env) || opts.enrich === false) return null;
    if (!io || typeof io.fetchHtml !== 'function') return null;
    const link = pickLink(item);
    if (!link) return null;
    return enrichSafe(link, { io, cache: opts.enrichCache, sanitizeImage: opts.enrichSanitize, log: opts.enrichLog }, opts.enrichTimeoutMs);
}

module.exports = { enrichLink, enrichSafe, enrichForItem, pickLink, normalizeUrl, parseOg, createCache, fetchHtmlSafe, fetchImageSafe, checkUrl, isPublicIp, HARD_DENY, SHORTENERS };
