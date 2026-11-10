// src/scrapers/browser.js
// Shared puppeteer-extra + stealth browser lifecycle.
//
// One browser per process, opened lazily, closed by scrapeAll()'s finally
// block. All three original scrapers (fetcher.js, jobFetcher.js,
// scholarshipScraper.js) each launched their own Chromium — same args,
// same stealth plugins, same shutdown dance. Consolidating to one browser
// removes ~60 lines of duplication and eliminates three Chromium launches
// per "scrape all".
//
// Concurrency model: a plain ref-count of in-flight withPage() calls. The
// browser is launched on the first call, torn down when the last call
// finishes AND the caller explicitly asked for close (via closeBrowser).
// This is the safe middle ground: it never closes a browser out from under
// a running page, but also doesn't hold a browser open indefinitely between
// scrape runs (closeBrowser is called from scrapeAll's finally).

const fs = require('fs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const env = require('../config/env');
const { setupStealthPage } = require('./page');

// Optional custom executable / profile — off by default, only activates
// if BOTH the path is set AND the file exists on this machine. Same
// opt-in pattern as the original files.
const CUSTOM_EXECUTABLE = env.BROWSER_EXECUTABLE_PATH || env.JOB_BROWSER_EXECUTABLE_PATH || null;
const CUSTOM_USER_DATA_DIR = env.BROWSER_USER_DATA_DIR || env.JOB_BROWSER_USER_DATA_DIR || null;

let browser = null;
let launchPromise = null;
let inFlight = 0;

function buildLaunchOptions() {
    const opts = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--disable-blink-features=AutomationControlled'
        ]
    };

    if (CUSTOM_EXECUTABLE && CUSTOM_USER_DATA_DIR) {
        if (fs.existsSync(CUSTOM_EXECUTABLE)) {
            opts.executablePath = CUSTOM_EXECUTABLE;
            opts.userDataDir = CUSTOM_USER_DATA_DIR;
            console.log(`ℹ️ [browser] Using custom executable at ${CUSTOM_EXECUTABLE}`);
        } else {
            console.warn(`⚠️ [browser] BROWSER_EXECUTABLE_PATH is set to "${CUSTOM_EXECUTABLE}" but that file does not exist here — falling back to bundled Chromium.`);
        }
    }

    return opts;
}

// Lazily launch and cache the browser. Concurrent callers share the same
// launch promise so two sources can't race two Chromium launches.
async function getBrowser() {
    if (browser) return browser;
    if (launchPromise) return launchPromise;

    launchPromise = (async () => {
        const b = await puppeteer.launch(buildLaunchOptions());
        browser = b;
        return b;
    })();

    try {
        return await launchPromise;
    } finally {
        launchPromise = null;
    }
}

// Explicit close — call from scrapeAll()'s finally block. Safe to call
// even if no browser was opened. Waits for in-flight pages to finish by
// simply refusing to close while any are active — the caller (scrapeAll)
// is responsible for having awaited all source promises before calling.
async function closeBrowser() {
    if (inFlight > 0) {
        // A source still holds a page open. Leave the browser running; the
        // next scrape will reuse it. This is the fail-safe path — the only
        // way it fires is if scrapeAll's error handling got bypassed.
        console.warn(`⚠️ [browser] closeBrowser() called with ${inFlight} page(s) still open — skipping teardown.`);
        return;
    }
    if (!browser) return;
    try {
        await browser.close();
    } catch (error) {
        console.warn('⚠️ [browser] Error closing browser:', error.message);
    }
    browser = null;
}

// Wrap a page-scoped operation. Ensures:
//   - the shared browser is up,
//   - a new page is opened and stealth-configured before fn runs,
//   - the page is closed afterwards even if fn throws,
//   - the in-flight counter is decremented so closeBrowser's guard is
//     accurate.
//
// This is the ONLY entry point scrapers should use to touch a page.
async function withPage(fn) {
    const b = await getBrowser();
    inFlight++;
    const page = await b.newPage();
    try {
        await setupStealthPage(page);
        return await fn(page);
    } finally {
        try { await page.close(); } catch (e) { /* ignore */ }
        inFlight = Math.max(0, inFlight - 1);
    }
}

module.exports = {
    getBrowser,
    closeBrowser,
    withPage
};
