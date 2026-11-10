// src/scrapers/page.js
// Page setup shared by every scraper plugin.
//
// Two things live here:
//   1. setupStealthPage(page) — the exact stealth config the original
//      fetcher.js/jobFetcher.js/scholarshipScraper.js applied (identical
//      across all three, so there's no reason to keep three copies).
//   2. window.__resolveImageSrc — injected into every page. Scrapers call
//      it from page.evaluate() to resolve the REAL image URL of an <img>,
//      transparently handling lazy-loading (which parks a tiny base64
//      placeholder in `src` and stashes the real URL in data-src /
//      data-original / data-lazy-src / srcset until the image scrolls
//      into view), relative URLs, and known placeholder patterns.
//
// The stealth config is JS-executed before page load (evaluateOnNewDocument)
// so it wins the race against any bot-detection check the site runs during
// initial parse.

// Small delay helper — matches the original file's shape so scraper code
// reads identically. Not a shared util because delays inside page lifecycles
// are essentially always "wait for the network/browser to settle" — putting
// them here keeps the intent visible at the call site.
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setupStealthPage(page) {
    await page.setViewport({ width: 1366, height: 768 });

    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36'
    );

    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'https://www.google.com/',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
    });

    await page.evaluateOnNewDocument(() => {
        // --- Navigator fingerprint ---
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', {
            get: () => [
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
            ]
        });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        window.chrome = { runtime: {} };

        // --- WebGL vendor spoof (some bot detectors check this) ---
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
            if (type === 'webgl' || type === 'webgl2') {
                const context = originalGetContext.call(this, type, ...args);
                if (context) {
                    const originalGetParameter = context.getParameter;
                    context.getParameter = function (parameter) {
                        if (parameter === 37445) return 'Intel Inc.';
                        if (parameter === 37446) return 'Intel Iris OpenGL Engine';
                        return originalGetParameter.call(this, parameter);
                    };
                }
                return context;
            }
            return originalGetContext.call(this, type, ...args);
        };

        // --- Notification permission shim ---
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
            parameters.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery(parameters)
        );

        // --- __resolveImageSrc: lazy-load-aware image URL resolution ---
        //
        // Lazy-loading libraries (lazysizes, react-lazyload, native
        // loading="lazy" polyfills, etc.) park a tiny placeholder — often
        // a base64 data: URI 1x1 gif — in `src` and stash the actual photo
        // URL in data-src/data-original/data-lazy-src/srcset until the image
        // scrolls into view. Reading `.src` directly grabs that placeholder
        // instead of the real photo whenever the image never got scrolled
        // into view during the scrape.
        //
        // Order of precedence:
        //   1. Real lazy-load attrs (data-src, data-original, data-lazy-src,
        //      data-srcset's largest entry) — those carry the true URL.
        //   2. Browser's resolved currentSrc, then `src` attribute, then
        //      srcset's largest entry.
        //   3. Give up (return null).
        //
        // Relative URLs are resolved against page origin. data: URIs are
        // always rejected — they're never the real photo.
        window.__resolveImageSrc = function (imgEl) {
            if (!imgEl) return null;

            const isPlaceholder = (url) => {
                if (!url) return true;
                if (url.startsWith('data:')) return true;
                if (/\b(blank|placeholder|spacer|1x1|pixel)\b/i.test(url)) return true;
                return false;
            };

            // KataJaam-style sites ship normal srcset (no lazy-loading) —
            // pick the LARGEST entry, not the first (smallest), so we get
            // the high-res photo.
            const largestUrlFromSrcset = (srcset) => {
                if (!srcset) return null;
                const entries = srcset.split(',').map((s) => s.trim()).filter(Boolean);
                let best = null;
                let bestWidth = -1;
                for (const entry of entries) {
                    const parts = entry.split(/\s+/);
                    const url = parts[0];
                    const width = parseInt((parts[1] || '').replace(/[^\d]/g, ''), 10) || 0;
                    if (url && width >= bestWidth) {
                        best = url;
                        bestWidth = width;
                    }
                }
                return best;
            };

            const resolve = (url) => {
                if (!url) return null;
                return url.startsWith('/') ? new URL(url, window.location.origin).href : url;
            };

            const lazyCandidates = [
                imgEl.getAttribute('data-src'),
                imgEl.getAttribute('data-original'),
                imgEl.getAttribute('data-lazy-src'),
                largestUrlFromSrcset(imgEl.getAttribute('data-srcset'))
            ];
            for (const candidate of lazyCandidates) {
                if (candidate && !isPlaceholder(candidate)) return resolve(candidate);
            }

            const directCandidates = [
                imgEl.currentSrc,
                imgEl.src,
                largestUrlFromSrcset(imgEl.getAttribute('srcset'))
            ];
            for (const candidate of directCandidates) {
                if (candidate && !isPlaceholder(candidate)) return resolve(candidate);
            }

            return null;
        };
    });

    // Settle: matches the original per-page delay so first navigations
    // don't race cookie banners / consent dialogs / early redirects.
    await delay(2000 + Math.random() * 3000);
}

module.exports = { setupStealthPage, delay };
