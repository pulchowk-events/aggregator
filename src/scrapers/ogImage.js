// src/scrapers/ogImage.js
// Derive a per-site fallback image URL from <meta og:image> or <link icon>.
//
// Why this exists: jobs typically don't carry per-item images. Careers
// pages, however, publish a branded og:image meta tag designed for link
// sharing -- that's the right visual for a Discord embed. It's per-site
// (not per-item), but for job cards that's fine: "CloudFactory is hiring"
// with the CloudFactory banner reads better than "no image" or a broken
// gate.
//
// Cache: data/og-image-cache.json, keyed by hostname. TTL 30 days. First
// scrape after adding a new source does the fetch; every subsequent
// scrape hits cache. Network cost is negligible on a warm cache.
//
// Failure modes:
//   - Site has neither og:image nor favicon: returns null. Job fails
//     hasValidImage gate, human Customizes with a manual URL. Acceptable.
//   - Fetch fails (network, 5xx): caches a failure marker briefly (so
//     we don't hammer the same broken site every cycle) but returns null.
//   - URL unparseable: returns null immediately, no fetch.
//
// Never throws. All callers get null on any failure.

const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const { sniffImage } = require('./imageSniff');

const REPO = path.resolve(__dirname, '..', '..');
const CACHE_PATH = path.join(REPO, 'data', 'og-image-cache.json');
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 6 * 60 * 60 * 1000;  // retry a broken site in 6h
const FETCH_TIMEOUT_MS = 8000;
const IMAGE_PROBE_TIMEOUT_MS = 8000;

// IMG-2: cache schema version. Entries without a matching "v" are treated as
// missing and refetched, which drops entries cached before image validation
// existed (e.g. a .ico favicon stored as ok:true). Bump to invalidate again.
const CACHE_VERSION = 2;

// Content types that are never usable as a Discord embed/attachment image.
const REJECT_TYPES_RE = /text\/html|image\/x-icon|image\/vnd\.microsoft\.icon|image\/svg/i;

let cache = null;

// In-flight fetch dedup. When 68 items from the same domain request an
// image in parallel (CloudFactory case), without this each would fire
// its own HTTP fetch before the cache populates. With it, hostname H's
// first caller starts the fetch and puts the promise here; every other
// caller for H awaits the same promise. Result: 1 fetch per domain per
// scrape cycle, not 1 per item.
const pendingFetches = new Map();

function loadCache() {
    if (cache) return cache;
    try {
        cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } catch (e) {
        cache = {};
    }
    return cache;
}

function saveCache() {
    try {
        fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    } catch (e) {
        // Cache write failure is non-fatal -- next run just refetches.
    }
}

function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (e) { return null; }
}

// Resolve a possibly-relative image URL against the page URL, and upgrade
// http -> https unconditionally. Two reasons:
//   1. Discord's CDN serves embeds over https; a raw http URL in
//      embed.setImage() renders silently with no image in /pending.
//   2. Most career sites host the same og:image/favicon on both schemes,
//      so the upgrade almost never 404s. If it does, the embed just
//      drops the image -- no worse than today's silent http case.
// Absolute values already on https pass through unchanged.
function absolutize(candidate, baseUrl) {
    if (!candidate || typeof candidate !== 'string') return null;
    try {
        const abs = new URL(candidate, baseUrl || candidate).href;
        return abs.replace(/^http:/i, 'https:');
    } catch (e) {
        return null;
    }
}

// HEAD-check that an upgraded https URL actually resolves. Sites that serve
// og:image only over http would 404 after the scheme upgrade, silently
// breaking BOTH /pending (Discord CDN needs https) and the post path
// (axios.get needs a real resource). Returning null on 404 lets the caller
// fall through to the GitHub-raw placeholder, which always resolves.
// Cached alongside the og/favicon entry so this runs once per host/30 days.
async function probeHttps(url) {
    if (!url) return null;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        try {
            const res = await fetch(url, {
                method: 'HEAD',
                signal: ctrl.signal,
                redirect: 'follow',
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (res.ok) return url;
            // Some CDNs refuse HEAD; try a one-byte GET as fallback.
            const res2 = await fetch(url, {
                method: 'GET',
                signal: ctrl.signal,
                redirect: 'follow',
                headers: { 'User-Agent': 'Mozilla/5.0', 'Range': 'bytes=0-0' }
            });
            return res2.ok ? url : null;
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        return null;
    }
}

// Match a meta tag value by property or name, both attribute orders.
function matchMeta(html, key) {
    const patterns = [
        new RegExp(`<meta[^>]*property=["']${key}["'][^>]*content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*property=["']${key}["']`, 'i'),
        new RegExp(`<meta[^>]*name=["']${key}["'][^>]*content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*name=["']${key}["']`, 'i')
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m) return m[1];
    }
    return null;
}

function matchFavicon(html, baseUrl) {
    const m = html.match(/<link[^>]*rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/i);
    if (!m) return null;
    try { return new URL(m[1], baseUrl).href; } catch (e) { return null; }
}

// IMG-2: confirm a candidate URL is really a jpg/png/gif/webp. Rejects non-2xx,
// html/ico/svg content-types, and anything whose first bytes are not a known image
// signature (this also catches HTML soft 404s served with a 200). Reads only the
// first few bytes of the body. Returns the URL or null. Never throws.
async function validateImage(url) {
    if (!url) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IMAGE_PROBE_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method: 'GET',
            signal: ctrl.signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/jpeg,image/png,image/webp,image/gif,*/*;q=0.1' }
        });
        if (!res.ok) return null;
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (REJECT_TYPES_RE.test(ct)) return null;
        let head = Buffer.alloc(0);
        if (res.body && typeof res.body.getReader === 'function') {
            const reader = res.body.getReader();
            try {
                while (head.length < 16) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    head = Buffer.concat([head, Buffer.from(chunk.value)]);
                }
            } finally {
                try { await reader.cancel(); } catch (e) { /* ignore */ }
            }
        } else {
            head = Buffer.from(await res.arrayBuffer()).subarray(0, 16);
        }
        return sniffImage(head) ? url : null;
    } catch (e) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function fetchAndExtract(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/xhtml+xml' },
            redirect: 'follow',
            signal: ctrl.signal
        });
        if (!res.ok) return { og: null, favicon: null, status: res.status, error: `HTTP ${res.status}` };
        const html = await res.text();
        const ogRaw = matchMeta(html, 'og:image')
            || matchMeta(html, 'og:image:url')
            || matchMeta(html, 'twitter:image')
            || matchMeta(html, 'twitter:image:src');
        const baseUrl = res.url || url;
        const ogCandidate = absolutize(ogRaw, baseUrl);
        const favCandidate = absolutize(matchFavicon(html, baseUrl), baseUrl);
        // IMG-2: every candidate must really be a jpg/png/gif/webp (content-type
        // plus magic bytes), not just upgraded ones. HTML soft 404s, .ico and .svg
        // are discarded, so a bad favicon can no longer be cached as usable.
        // deriveImageForUrl still prefers og over favicon, now only when valid.
        const og = await validateImage(ogCandidate);
        const favicon = await validateImage(favCandidate);
        return { og, favicon, status: res.status };
    } catch (e) {
        return { og: null, favicon: null, status: null, error: e.message };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Given a URL (typically a job item's url field), derive a usable image
 * URL. Uses og:image from the site's homepage, falling back to favicon.
 * Cached per-hostname. Never throws.
 *
 * @param {string} url  Any URL on the target site
 * @returns {Promise<string|null>}  Absolute image URL, or null
 */
async function deriveImageForUrl(url) {
    const host = hostOf(url);
    if (!host) return null;
    const c = loadCache();
    const now = Date.now();
    const existing = c[host] && c[host].v === CACHE_VERSION ? c[host] : null;

    // Successful cache hit within TTL: return immediately.
    if (existing && existing.ok && (now - (existing.fetchedAt || 0)) < TTL_MS) {
        // Re-absolutize on read so cached http entries from before this
        // fix get upgraded without waiting for TTL expiry.
        return absolutize(existing.og, url) || absolutize(existing.favicon, url) || null;
    }
    // Recent failure: don't hammer, return current cached value (null).
    if (existing && !existing.ok && (now - (existing.fetchedAt || 0)) < FAILURE_TTL_MS) {
        return absolutize(existing.og, url) || absolutize(existing.favicon, url) || null;
    }

    // Choose fetch target. Prefer homepage -- deep pages often drop meta tags.
    let fetchUrl;
    try {
        const u = new URL(url);
        fetchUrl = `${u.protocol}//${u.hostname}/`;
    } catch (e) { fetchUrl = url; }

    // Deduplicate concurrent fetches for the same hostname.
    if (pendingFetches.has(host)) {
        return pendingFetches.get(host);
    }
    const fetchPromise = (async () => {
        try {
            const result = await fetchAndExtract(fetchUrl);
            const ok = Boolean(result.og || result.favicon);
            c[host] = {
                ok,
                og: result.og || null,
                favicon: result.favicon || null,
                v: CACHE_VERSION,
                fetchedAt: now,
                status: result.status || null,
                error: result.error || null
            };
            saveCache();
            return c[host].og || c[host].favicon || null;
        } finally {
            pendingFetches.delete(host);
        }
    })();
    pendingFetches.set(host, fetchPromise);
    return fetchPromise;
}

// For tests / diagnostics: read the cache without triggering a fetch.
function getCachedImage(url) {
    const host = hostOf(url);
    if (!host) return null;
    const c = loadCache();
    const e = c[host] && c[host].v === CACHE_VERSION ? c[host] : null;
    if (!e) return null;
    return e.og || e.favicon || null;
}

// Placeholder fallback. Returns a URL the bot can fetch from its own
// Express server when og:image and favicon derivation both returned null.
// The PNG itself is generated by scripts/generate-placeholders.js and
// served at /placeholders/<name>.png by src/web/server.js. Returns null
// when the PNG does not exist on disk (source not yet generated) -- the
// caller's image stays null in that case, same as before this feature.
function derivePlaceholderForSource(sourceName) {
    if (!sourceName || !/^[a-z0-9_-]+$/i.test(sourceName)) return null;
    // Placeholders live in assets/placeholders/ (committed to the repo, public).
    // Discord cannot fetch http://127.0.0.1 -- embeds with a localhost image URL
    // render silently with no image. Return the GitHub raw URL so Discord's CDN
    // can fetch it, same as it fetches any source image.
    //
    // Local existence check is deliberate: assets/placeholders/<name>.png is
    // committed by the operator when a new source is added. If the file isn't
    // present, return null and let the live-post hasValidImage gate reject it.
    const pngPath = path.join(REPO, 'assets', 'placeholders', `${sourceName}.png`);
    if (!fs.existsSync(pngPath)) return null;
    return `https://raw.githubusercontent.com/pulchowk-events/aggregator/main/assets/placeholders/${sourceName}.png`;
}

module.exports = { deriveImageForUrl, derivePlaceholderForSource, getCachedImage, CACHE_PATH };
