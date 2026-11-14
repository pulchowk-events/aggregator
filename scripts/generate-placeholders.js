#!/usr/bin/env node
// scripts/generate-placeholders.js
// Generate 1024×1024 placeholder PNGs for every scraper source. Used as
// the last-resort image fallback when a site has neither <meta og:image>
// nor a favicon.
//
// Visual: black background, white company name centered (both axes),
// "PULCHOWK EVENTS" brand mark at the bottom. Font size scales inversely
// with name length so short names stay readable and long names fit.
//
// Idempotent: skips PNGs that already exist. --force regenerates all.
// --only <name1,name2> regenerates specific ones.
//
// Output: data/placeholder-images/<source-name>.png
//
// Served at http://localhost:${WEB_PORT}/placeholders/<name>.png by the
// Express server (src/web/server.js). post.js downloads via axios and
// uploads as a Discord attachment -- localhost works because bot fetches
// its own Express instance.
//
// Run: node scripts/generate-placeholders.js
//      node scripts/generate-placeholders.js --force
//      node scripts/generate-placeholders.js --only devfinity,tech101

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'data', 'placeholder-images');
const TYPES = ['jobs', 'events', 'scholarships'];

function parseArgs(argv) {
    const args = { force: false, only: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--force') args.force = true;
        else if (a === '--only' && argv[i + 1]) args.only = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    }
    return args;
}

// Humanize a source name for display: 'margintopsolutions' -> 'Margintopsolutions'.
// First letter uppercase, remaining characters as-is. Hyphens become spaces.
function displayName(name) {
    const cleaned = String(name).replace(/-/g, ' ').trim();
    if (!cleaned) return name;
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Font size starting point. Measurement in the browser is the ground
// truth (see autoFit script), so this just needs to be in the ballpark:
// big enough that short names look substantial, small enough that long
// names only need to shrink one step. Factor 0.72 approximates Inter
// Bold's average character width.
function fontSizeFor(name) {
    const len = displayName(name).length;
    const raw = 864 / Math.max(1, len * 0.72);
    return Math.min(140, Math.max(28, Math.round(raw)));
}

function htmlTemplate(sourceName) {
    const display = displayName(sourceName);
    const fontSize = fontSizeFor(sourceName);
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; width: 1024px; height: 1024px; overflow: hidden; background: #000; }
  body { display: flex; align-items: center; justify-content: center; font-family: Inter, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #fff; }
  .name-wrap { max-width: 864px; text-align: center; overflow: hidden; }
  .name { font-size: ${fontSize}px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; white-space: nowrap; display: inline-block; }
  .brand { position: absolute; bottom: 56px; left: 0; right: 0; text-align: center; font-size: 18px; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; color: rgba(255,255,255,0.45); }
</style></head><body>
  <div class="name-wrap"><span class="name" id="nm">${display}</span></div>
  <div class="brand">Pulchowk Events</div>
</body></html>`;
}

function listSources() {
    const out = [];
    for (const t of TYPES) {
        const dir = path.join(REPO, 'src', 'scrapers', 'sources', t);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.js') && !f.endsWith('.batchbak')) {
                out.push({ name: f.slice(0, -3), type: t });
            }
        }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function run() {
    const opts = parseArgs(process.argv.slice(2));
    fs.mkdirSync(OUT_DIR, { recursive: true });

    let sources = listSources();
    if (opts.only) sources = sources.filter(s => opts.only.includes(s.name));
    if (sources.length === 0) {
        console.log('no sources to generate');
        return;
    }

    console.log(`placeholder generation: ${sources.length} source(s)`);
    console.log(`output dir: ${OUT_DIR}`);
    console.log('');

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    let generated = 0;
    let skipped = 0;
    for (const s of sources) {
        const outPath = path.join(OUT_DIR, `${s.name}.png`);
        if (fs.existsSync(outPath) && !opts.force) {
            skipped++;
            continue;
        }
        try {
            const page = await browser.newPage();
            await page.setViewport({ width: 1024, height: 1024, deviceScaleFactor: 1 });
            await page.setContent(htmlTemplate(s.name), { waitUntil: 'domcontentloaded' });
            // Auto-fit: shrink font until text fits inside 864px. This is
            // the ground truth -- the fontSizeFor() starting point may be
            // slightly off depending on character width variance, and we
            // never want a long name to wrap or clip.
            await page.evaluate(() => {
                const el = document.getElementById('nm');
                if (!el) return;
                const MAX_W = 864;
                let size = parseFloat(getComputedStyle(el).fontSize);
                while (el.getBoundingClientRect().width > MAX_W && size > 20) {
                    size -= 2;
                    el.style.fontSize = size + 'px';
                }
            });
            await page.screenshot({ path: outPath, type: 'png' });
            await page.close();
            const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
            console.log(`  ${s.name.padEnd(24)} ${s.type.padEnd(12)} ${kb} KB`);
            generated++;
        } catch (e) {
            console.log(`  ${s.name.padEnd(24)} FAILED: ${e.message}`);
        }
    }
    await browser.close();
    console.log('');
    console.log(`generated: ${generated}, skipped: ${skipped}, total on disk: ${fs.readdirSync(OUT_DIR).length}`);
}

run().catch((e) => { console.error(e); process.exit(1); });
