#!/usr/bin/env node
// scripts/verify-source.js
// Run ONE scraper source in isolation. No bot, no Discord, no cron.
// Useful for verifying a fix before committing, and for testing sources
// that need platform-specific config (e.g. a Windows browser profile).
//
// Usage:
//   node scripts/verify-source.js <source-name>
//   node scripts/verify-source.js scholarshipsads
//   node scripts/verify-source.js katajaam
//
// Runs the extractor directly (bypassing the orchestrator's diagnostics
// wrapper), prints the result shape, and reports the item count + a sample.

const path = require('path');

const sourceName = process.argv[2];
if (!sourceName) {
    console.error('Usage: node scripts/verify-source.js <source-name>');
    console.error('Example: node scripts/verify-source.js scholarshipsads');
    process.exit(1);
}

const REPO = path.resolve(__dirname, '..');
const { withPage, closeBrowser } = require(path.join(REPO, 'src', 'scrapers', 'browser'));
const { ScrapeProgressTracker } = require(path.join(REPO, 'src', 'scrapers', 'progress'));
const { loadExtractor } = require(path.join(REPO, 'src', 'scrapers', 'extractors'));
const { classifyOutcome } = require(path.join(REPO, 'src', 'scrapers', 'diagnostics'));

// Find the source's type by scanning all type dirs
const fs = require('fs');
const TYPES = ['events', 'jobs', 'scholarships'];
let sourceType = null;
for (const t of TYPES) {
    const dir = path.join(REPO, 'src', 'scrapers', 'sources', t);
    if (fs.existsSync(path.join(dir, `${sourceName}.js`))) { sourceType = t; break; }
}
if (!sourceType) {
    console.error(`No source wrapper found for "${sourceName}" in sources/{events,jobs,scholarships}/`);
    process.exit(1);
}

(async () => {
    console.log(`▶ Verifying source: ${sourceName} (type: ${sourceType})`);
    console.log(`  node: ${process.version}, platform: ${process.platform}`);
    console.log('');

    const { extractor, isStub } = loadExtractor(sourceType, sourceName);
    if (isStub) {
        console.error('❌ Only .example.js stub present — no real extractor installed.');
        process.exit(1);
    }

    const progress = new ScrapeProgressTracker();
    progress.start([sourceName]);
    const meta = {
        pagesVisited: 0, listingHits: 0, detailPagesVisited: 0,
        detailParseFailures: 0, looksBlocked: false
    };

    const t0 = Date.now();
    try {
        const result = await withPage((page) => extractor.extract(page, { progress, meta }));
        const durationMs = Date.now() - t0;
        const verdict = classifyOutcome(result);

        console.log('');
        console.log('=== result ===');
        console.log('items:',        result.items.length);
        console.log('verdict:',      verdict.status);
        console.log('listingHits:',  meta.listingHits);
        console.log('detailPages:',  meta.detailPagesVisited);
        console.log('parseFailures:', meta.detailParseFailures);
        console.log('looksBlocked:', meta.looksBlocked);
        console.log('duration:',     Math.round(durationMs / 1000) + 's');

        if (result.items.length > 0) {
            console.log('');
            console.log('--- first 3 items ---');
            for (let i = 0; i < Math.min(3, result.items.length); i++) {
                const it = result.items[i];
                console.log(`[${i}] ${it.title}`);
                console.log('    date:',  it.date || 'null');
                console.log('    item:',  it.itemType || 'event');
                console.log('    image:', it.image ? 'present' : 'null');
                console.log('    warnings:', (it.dataQualityWarnings || []).length);
            }
        }

        if (verdict.status === 'blocked') {
            console.log('');
            console.log('⚠️  BLOCKED — the site is serving a captcha / Cloudflare challenge.');
            console.log('    If you are on Windows and BROWSER_EXECUTABLE_PATH +');
            console.log('    BROWSER_USER_DATA_DIR point at a Brave/Chrome profile with');
            console.log('    a warm session for this site, close that browser first, then');
            console.log('    re-run this script.');
        }
    } catch (error) {
        console.error('❌ FAILED:', error.message);
        if (error.stack) console.error(error.stack);
        process.exit(1);
    } finally {
        await closeBrowser();
    }
})();
