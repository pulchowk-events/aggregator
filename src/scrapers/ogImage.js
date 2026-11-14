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

const REPO = path.resolve(__dirname, '..', '..');
const CACHE_PATH = path.join(REPO, 'data', 'og-image-cache.json');
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 6 * 60 * 60 * 1000;  // retry a broken site in 6h
const FETCH_TIMEOUT_MS = 8000;

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
        const og = matchMeta(html, 'og:image')
            || matchMeta(html, 'og:image:url')
            || matchMeta(html, 'twitter:image')
            || matchMeta(html, 'twitter:image:src');
        const favicon = matchFavicon(html, res.url || url);
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
    const existing = c[host];

    // Successful cache hit within TTL: return immediately.
    if (existing && existing.ok && (now - (existing.fetchedAt || 0)) < TTL_MS) {
        return existing.og || existing.favicon || null;
    }
    // Recent failure: don't hammer, return current cached value (null).
    if (existing && !existing.ok && (now - (existing.fetchedAt || 0)) < FAILURE_TTL_MS) {
        return existing.og || existing.favicon || null;
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
    const e = c[host];
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
    const pngPath = path.join(REPO, 'data', 'placeholder-images', `${sourceName}.png`);
    if (!fs.existsSync(pngPath)) return null;
    // Port from the config layer (not process.env directly). env.js runs
    // dotenv at require time and applies the WEB_PORT env var with a
    // documented 3001 fallback. Reading via env guarantees this matches
    // whatever server.js binds to, regardless of require order.
    const port = env.WEB_PORT;
    return `http://127.0.0.1:${port}/placeholders/${sourceName}.png`;
}

module.exports = { deriveImageForUrl, derivePlaceholderForSource, getCachedImage, CACHE_PATH };
