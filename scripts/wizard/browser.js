// scripts/wizard/browser.js
// The wizard's own Puppeteer browser. Deliberately separate from
// src/scrapers/browser.js: the bot is often running when the wizard is
// invoked, and sharing a browser instance would either contend for the
// same page pool or lock-fail if the bot is holding a warm profile.
//
// Default: bundled Chromium. Fast to launch, works for 9/10 sites.
//
// If a URL requires the warm profile (Cloudflare, logged-in pages):
//   1. STOP the bot (kill node)
//   2. run: node scripts/wizard/index.js --profile
//   3. START the bot again
//
// The wizard does NOT expose a "share the bot's browser" mode — that
// path leads to non-reproducible bugs.

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const REPO = path.resolve(__dirname, '..', '..');
const env = require(path.join(REPO, 'src', 'config', 'env'));

let browser = null;

async function getBrowser({ useProfile = false } = {}) {
    if (browser) return browser;

    const opts = {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled'
        ]
    };

    if (useProfile) {
        const exe = env.BROWSER_EXECUTABLE_PATH;
        const dir = env.BROWSER_USER_DATA_DIR;
        if (!exe || !dir) {
            throw new Error('--profile requested but BROWSER_EXECUTABLE_PATH / BROWSER_USER_DATA_DIR are not set in .env');
        }
        if (!fs.existsSync(exe)) {
            throw new Error(`--profile requested but ${exe} does not exist on this host. (Windows-only feature — WSL/Linux cannot resolve Windows paths.)`);
        }
        opts.executablePath = exe;
        opts.userDataDir = dir;
        console.log(`ℹ️  Using warm profile: ${exe}`);
        console.log(`ℹ️  User data dir: ${dir}`);
        console.log(`⚠️  Make sure the bot and any Brave window are closed before running.`);
    }

    browser = await puppeteer.launch(opts);
    return browser;
}

async function withPage(fn, { useProfile = false } = {}) {
    const b = await getBrowser({ useProfile });
    const page = await b.newPage();
    try {
        await page.setViewport({ width: 1366, height: 900 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': 'https://www.google.com/'
        });
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        return await fn(page);
    } finally {
        try { await page.close(); } catch (e) { /* ignore */ }
    }
}

async function closeBrowser() {
    if (browser) {
        try { await browser.close(); } catch (e) { /* ignore */ }
        browser = null;
    }
}

module.exports = { withPage, closeBrowser };
