#!/usr/bin/env node
// scripts/insta-login.js
// Manual Instagram login -> saves session cookies for the "social" source type.
//
//   node scripts/insta-login.js              login if no cookie file, else verify
//   node scripts/insta-login.js --relogin    force a fresh login
//   node scripts/insta-login.js --verify     verify saved cookies only
//   node scripts/insta-login.js --headless   verify without a visible window (login is always headed)
//   node scripts/insta-login.js --timeout N  login wait in seconds (default 300)
//
// Exit codes: 0 ok | 1 verify/other failure | 2 login timeout | 3 browser closed
//             4 challenge detected | 64 bad arguments
// data/instagram/cookies.json is a live session credential: gitignored, never commit it.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer');

const COOKIE_DIR = path.join(__dirname, '..', 'data', 'instagram');
const COOKIE_FILE = path.join(COOKIE_DIR, 'cookies.json');
const REL_FILE = 'data/instagram/cookies.json';
const LOGIN_URL = 'https://www.instagram.com/accounts/login/';
const HOME_URL = 'https://www.instagram.com/';
const KEEP = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'];
const BAD_PATH = /\/(challenge|checkpoint|suspended)/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[insta-login] ${m}`);

class Fail extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

function parseArgs(argv) {
    const a = { relogin: false, verify: false, headless: false, timeout: 300 };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === '--relogin') a.relogin = true;
        else if (v === '--verify') a.verify = true;
        else if (v === '--headless') a.headless = true;
        else if (v === '--timeout') a.timeout = Number(argv[++i]);
        else if (v.startsWith('--timeout=')) a.timeout = Number(v.slice(10));
        else throw new Fail(64, `unknown argument: ${v}`);
    }
    if (!Number.isFinite(a.timeout) || a.timeout <= 0) throw new Fail(64, '--timeout needs a positive number of seconds');
    if (a.relogin && a.verify) throw new Fail(64, '--relogin and --verify cannot be combined');
    return a;
}

function launchOptions(headless, userDataDir) {
    const args = ['--window-size=1280,900', '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'];
    if (process.platform === 'linux') args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
    const opts = {
        headless,
        userDataDir, // fresh temp profile: never collides with the bot's puppeteer_data/ lock
        args,
        ignoreDefaultArgs: ['--enable-automation'],
        defaultViewport: headless ? { width: 1280, height: 900 } : null
    };
    if (process.env.PUPPETEER_EXECUTABLE_PATH) opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    return opts;
}

const isIg = (c) => /(^|\.)instagram\.com$/.test(String(c.domain).replace(/^\./, ''));
const hasSession = (cs) => cs.some((c) => c.name === 'sessionid' && c.value && isIg(c));

// puppeteer <24: page.cookies() / page.setCookie(); >=24 moves these to the browser object.
async function readCookies(browser, page) {
    const all = typeof browser.cookies === 'function' ? await browser.cookies() : await page.cookies(HOME_URL);
    return all.filter(isIg);
}
async function writeCookies(browser, page, cookies) {
    if (typeof browser.setCookie === 'function') await browser.setCookie(...cookies);
    else await page.setCookie(...cookies);
}

function saveCookies(cookies) {
    const slim = cookies.map((c) => Object.fromEntries(KEEP.filter((k) => c[k] !== undefined).map((k) => [k, c[k]])));
    fs.mkdirSync(COOKIE_DIR, { recursive: true });
    const tmp = `${COOKIE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), cookies: slim }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, COOKIE_FILE);
    try { fs.chmodSync(COOKIE_FILE, 0o600); } catch (e) { /* not supported on Windows */ }
    return slim.length;
}

function loadSaved() {
    let data;
    try { data = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')); }
    catch (e) { throw new Fail(1, `cannot read ${REL_FILE} (${e.code || e.message}). Run without flags to log in.`); }
    if (!data || !Array.isArray(data.cookies)) throw new Fail(1, `${REL_FILE} is malformed. Run with --relogin.`);
    const now = Date.now() / 1000;
    const live = data.cookies.filter((c) => !(c.expires > 0 && c.expires < now));
    if (!hasSession(live)) throw new Fail(1, 'saved sessionid is missing or expired. Run with --relogin.');
    // expires -1 means session cookie: omit it so setCookie treats it as one
    return live.map((c) => { const o = { ...c }; if (!(o.expires > 0)) delete o.expires; return o; });
}

async function waitForLogin(browser, page, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const connected = () => (typeof browser.connected === 'boolean' ? browser.connected : browser.isConnected());
    let lastUrl = LOGIN_URL;
    let warned = false;
    while (Date.now() < deadline) {
        if (!connected() || page.isClosed()) throw new Fail(3, `window closed before login completed (last URL: ${lastUrl})`);
        try {
            lastUrl = page.url();
            if (BAD_PATH.test(lastUrl) && !warned) { log('challenge / verification page detected - complete it in the window'); warned = true; }
            if (hasSession(await readCookies(browser, page))) return;
        } catch (e) { /* page mid-navigation or closing; next loop re-checks */ }
        await sleep(1000);
    }
    throw new Fail(2, `timed out after ${timeoutMs / 1000}s waiting for login (last URL: ${lastUrl}). Re-run with --relogin (optionally --timeout 600).`);
}

async function doLogin(browser, page, timeoutSec) {
    log('navigating to login');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    log(`waiting for you to log in (timeout ${timeoutSec}s)`);
    await waitForLogin(browser, page, timeoutSec * 1000);
    log('logged in detected (sessionid present)');
    log('settling');
    await sleep(4000); // let csrftoken / ds_user_id / rur finish setting
    const cookies = await readCookies(browser, page);
    log(`saving ${cookies.length} cookies to ${REL_FILE}`);
    saveCookies(cookies);
}

async function doVerify(browser, page) {
    const cookies = loadSaved();
    log(`loaded ${cookies.length} saved cookies`);
    await writeCookies(browser, page, cookies);
    log('navigating to instagram.com (verify)');
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Wait for any decisive signal so the absence check below doesn't run on a half-rendered SPA.
    const settled = await page.waitForFunction(
        () => /\/(accounts\/login|challenge|checkpoint|suspended)/.test(location.pathname)
            || !!document.querySelector('input[name="username"]')
            || !!document.querySelector('a[href="/direct/inbox/"]'),
        { timeout: 15000 }
    ).then(() => true, () => false);
    const url = page.url();
    if (BAD_PATH.test(url)) throw new Fail(4, `challenge / verification page: ${url}. Run --relogin, solve it in the window, then --verify again.`);
    const loginForm = /\/accounts\/login/.test(url) || !!(await page.$('input[name="username"]'));
    if (loginForm) throw new Fail(1, 'session not valid (login form shown). Run with --relogin.');
    if (!hasSession(await readCookies(browser, page))) throw new Fail(1, 'sessionid cookie did not survive navigation. Run with --relogin.');
    const inbox = !!(await page.$('a[href="/direct/inbox/"]'));
    if (!settled) log('warning: page did not settle within 15s; passed on the no-login-form + sessionid check only');
    log(`logged-in state confirmed at ${url} (inbox link ${inbox ? 'present' : 'not seen'})`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const mode = args.verify ? 'verify' : (args.relogin || !fs.existsSync(COOKIE_FILE)) ? 'login' : 'verify';
    const headless = mode === 'verify' && args.headless;
    if (mode === 'login' && args.headless) log('--headless ignored: login needs a visible window');
    log(`mode: ${mode}${headless ? ' (headless)' : ''}`);

    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'insta-login-'));
    let browser;
    process.on('SIGINT', async () => {
        try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
        process.exit(130);
    });
    try {
        try { browser = await puppeteer.launch(launchOptions(headless, profileDir)); }
        catch (e) { throw new Fail(1, `could not launch browser: ${e.message}. Headed mode on WSL needs WSLg or an X server; set PUPPETEER_EXECUTABLE_PATH to use another Chrome.`); }
        log(`browser launched (${await browser.version()}, platform ${process.platform})`);
        const page = (await browser.pages())[0] || (await browser.newPage());
        if (headless) {
            // Default headless UA says "HeadlessChrome", which Instagram may treat as a bot.
            await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
        }
        if (mode === 'login') await doLogin(browser, page, args.timeout);
        else await doVerify(browser, page);
        log('done, closing browser');
    } finally {
        try { if (browser) await browser.close(); } catch (e) { /* already closed */ }
        try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
}

main().then(() => process.exit(0)).catch((e) => {
    const code = e instanceof Fail ? e.code : 1;
    console.error(`[insta-login] ERROR (exit ${code}): ${e.message}`);
    process.exit(code);
});
