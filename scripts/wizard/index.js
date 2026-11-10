#!/usr/bin/env node
// scripts/wizard/index.js
// Wizard entry point. Usage:
//
//   node scripts/wizard/index.js <url> <name> <type> [--profile] [--notes "custom hints"]
//
// Example:
//   node scripts/wizard/index.js https://example.com/events mynewsite events
//   node scripts/wizard/index.js https://example.com/events mynewsite events --notes "needs scroll to load all cards"
//   node scripts/wizard/index.js https://example.com/events mynewsite events --profile  (Windows only, bot stopped)
//
// What it does, in order:
//   1. Loads the entry URL through Puppeteer.
//   2. Dumps the listing DOM structure (dump.js).
//   3. Auto-picks a sample detail link (if one exists) and dumps that too.
//   4. Classifies the site type (detect.js).
//   5. Writes:
//        src/scrapers/sources/<type>/<name>.js        (committed wrapper)
//        src/scrapers/extractors/<type>/<name>.js     (stub — you fill in)
//        src/scrapers/extractors/<type>/<name>.md     (LLM prompt — paste this)
//   6. Prints next steps.
//
// Custom notes (--notes "...") are prepended to the LLM prompt so the
// user can hint at non-obvious structure ("scroll to load", "click Show
// More", "apply button opens LinkedIn").

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

// ---- Arg parsing (manual, no dependency) ----
const args = process.argv.slice(2);
const useProfile = args.includes('--profile');
const noInteractive = args.includes('--no-interactive');
const notesIdx = args.indexOf('--notes');
const customNotes = notesIdx !== -1 ? args[notesIdx + 1] : null;
const positional = args.filter((a, i) => !a.startsWith('--') && (notesIdx === -1 || i !== notesIdx + 1));

const [url, name, type] = positional;

if (!url || !name || !type) {
    console.error('');
    console.error('Usage: node scripts/wizard/index.js <url> <name> <type> [--profile] [--notes "..."]');
    console.error('');
    console.error('  <url>   — a page that shows the items (listing or category)');
    console.error('  <name>  — lowercase slug, matches filename (e.g. "mynewsite")');
    console.error('  <type>  — events | jobs | scholarships');
    console.error('');
    console.error('Options:');
    console.error('  --profile      — use the warm browser profile from .env (Windows only, bot must be stopped)');
    console.error('  --notes "..."  — custom hints to include in the LLM prompt');
    console.error('');
    process.exit(1);
}

if (!['events', 'jobs', 'scholarships'].includes(type)) {
    console.error(`❌ Unknown type "${type}" — must be events, jobs, or scholarships`);
    process.exit(1);
}
if (!/^[a-z0-9_-]+$/.test(name)) {
    console.error(`❌ Invalid name "${name}" — use lowercase letters, numbers, dashes, underscores only`);
    process.exit(1);
}

// Warn if wrapper already exists (don't overwrite silently)
const wrapperPath = path.join(REPO, 'src', 'scrapers', 'sources', type, `${name}.js`);
const extractorPath = path.join(REPO, 'src', 'scrapers', 'extractors', type, `${name}.js`);
const promptPath = path.join(REPO, 'src', 'scrapers', 'extractors', type, `${name}.md`);
if (fs.existsSync(wrapperPath) || fs.existsSync(extractorPath)) {
    console.error(`❌ Source already exists: ${path.relative(REPO, fs.existsSync(wrapperPath) ? wrapperPath : extractorPath)}`);
    console.error('   Delete the existing files first if you want to regenerate.');
    process.exit(1);
}

const { withPage, closeBrowser } = require('./browser');
const { dumpListingPage, dumpDetailPage } = require('./dump');
const { detectSiteType } = require('./detect');
const { buildPrompt } = require('./prompt');
const { sourceWrapper, extractorStub } = require('./templates');

(async () => {
    try {
        console.log(`▶ Wizard: ${name} (${type})`);
        console.log(`  URL: ${url}`);
        console.log(`  Profile mode: ${useProfile ? 'ON (Windows only)' : 'off (bundled Chromium)'}`);
        if (customNotes) console.log(`  Custom notes: "${customNotes}"`);
        console.log('');

        // ---- 1. Listing dump ----
        console.log('[1/4] Loading listing page...');
        const listing = await withPage(async (page) => {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
            await new Promise(r => setTimeout(r, 2500));
            return dumpListingPage(page);
        }, { useProfile });
        console.log(`      jsonLdTypes: ${listing.jsonLdTypes.join(', ') || '(none)'}`);
        console.log(`      anchorGroups: ${listing.anchorGroups.length}`);
        console.log(`      cardGroups: ${listing.cardGroups.length}`);
        console.log(`      categoryChips: ${listing.categoryChips.length}`);

        // ---- 2. Detail dump (auto-pick first candidate) ----
        let detail = null;
        const detailPattern = (listing.anchorGroups || [])
            .filter(g => g.count >= 3)
            .filter(g => !/^\/(category|tag|search|filter|about|contact)/i.test(g.pattern))
            .sort((a, b) => b.count - a.count)[0];

        if (detailPattern) {
            console.log(`\n[2/4] Loading sample detail page: ${detailPattern.samples[0].href}`);
            try {
                detail = await withPage(async (page) => {
                    await page.goto(detailPattern.samples[0].href, { waitUntil: 'networkidle2', timeout: 60000 });
                    await new Promise(r => setTimeout(r, 2000));
                    return dumpDetailPage(page);
                }, { useProfile });
                console.log(`      headings: ${detail.headings.length}, jsonLdSamples: ${detail.jsonLdSamples.length}`);
            } catch (e) {
                console.warn(`      ⚠️  Detail dump failed: ${e.message} — proceeding with listing dump only.`);
            }
        } else {
            console.log('\n[2/4] No detail-link candidates found — treating as single-page source.');
        }

        // ---- 3. Classify ----
        console.log('\n[3/4] Detecting site type...');
        const detected = detectSiteType(listing, detail);
        console.log(`      type: ${detected.type}`);
        console.log(`      signals: ${JSON.stringify(detected.signals)}`);

        // ---- 4. Write files ----
        console.log('\n[4/4] Writing files...');

        const promptBody = (customNotes ? `> **Custom notes (author-provided, take precedence over detection):** ${customNotes}\n\n` : '')
            + buildPrompt({ name, type, url, listing, detail, detected });

        fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
        fs.mkdirSync(path.dirname(extractorPath), { recursive: true });

        fs.writeFileSync(wrapperPath, sourceWrapper(name, type));
        fs.writeFileSync(extractorPath, extractorStub(name, type, detected));
        fs.writeFileSync(promptPath, promptBody);

        console.log(`      ✓ ${path.relative(REPO, wrapperPath)}`);
        console.log(`      ✓ ${path.relative(REPO, extractorPath)}  (stub — you fill this in)`);
        console.log(`      ✓ ${path.relative(REPO, promptPath)}  (paste to LLM)`);

        // Hand off to the interactive flow (or the non-TTY recipe fallback).
        const { runOrFallback } = require('./interactive');
        await runOrFallback({ name, type, url, wrapperPath, extractorPath, promptPath });
    } catch (error) {
        console.error('❌ Wizard failed:', error.message);
        if (error.stack) console.error(error.stack);
        process.exit(1);
    } finally {
        await closeBrowser();
    }
})();
