// src/scrapers/sources/_orchestrate.js
// Shared orchestration for every source plugin.
//
// Each source's `sources/<type>/<name>.js` file is a 5-line wrapper that
// calls runSource(). All cross-cutting concerns live here so a forker
// adding a new source writes ONLY the extractor + the 5-line wrapper.
//
// What the orchestrator owns:
//   - Extractor loading (real file first, .example.js stub fallback)
//   - Browser lifecycle via withPage / retry via withRetry
//   - Common sanitization pass (description trim, image URL validate,
//     field sanitize) applied to every item — matches what each of the
//     original scrapers did inline, but now in one place
//   - The { items, meta } result contract consumed by scrapeAll later
//
// What the extractor owns:
//   - All DOM/page.evaluate work for one source
//   - Per-source `preprocessItem` (NepVents uses this to strip its wall
//     of boilerplate text before common trim runs)
//
// The extractor is expected to update `meta` while running:
//   meta.pagesVisited, meta.listingHits, meta.detailPagesVisited,
//   meta.detailParseFailures, meta.looksBlocked
// These feed classifyOutcome() in diagnostics.js for the "0 items — why?"
// signal.

const { loadExtractor } = require('../extractors');
const { withRetry } = require('../retry');
const { trimDescriptionToLastSentence } = require('../text');
const { sanitizeScrapedEvent, sanitizeImageUrl } = require('../sanitize');

async function runSource(name, type, { withPage, progress }) {
    const { extractor, isStub } = loadExtractor(type, name);

    if (isStub) {
        console.warn(`⚠️ [${name}] extractor not implemented (only .example.js present) — see src/scrapers/extractors/README.md`);
        return { items: [], meta: { extractorMissing: true } };
    }

    const startedAt = Date.now();
    const meta = {
        pagesVisited: 0,
        listingHits: 0,
        detailPagesVisited: 0,
        detailParseFailures: 0,
        looksBlocked: false,
        durationMs: 0
    };

    let items = [];
    try {
        // Browserless extractors (ATS API calls) don't retry. ATS APIs
        // return 429/503 when rate-limited; a 3-attempt retry at 15s
        // AbortSignal each plus backoff = 51s wasted. One attempt, fail
        // fast. The AbortSignal inside each ATS template already bounds
        // the single attempt at 15s.
        const result = extractor.browserless
            ? await extractor.extract(null, { progress, meta })
            : await withRetry(
                () => withPage((page) => extractor.extract(page, { progress, meta })),
                { label: `${name} scrape` }
              );
        if (result && Array.isArray(result.items)) {
            items = result.items;
            if (result.meta) Object.assign(meta, result.meta);
        }
    } catch (error) {
        if (error.message && error.message.includes('403')) {
            meta.looksBlocked = true;
            console.warn(`⚠️ [${name}] returned 403 — treating as blocked.`);
        } else {
            console.error(`❌ [${name}] scrape failed:`, error);
        }
    }

    // Common sanitization pass — identical across every source so drift in
    // one field can't be silently acceptable in one source and not another.
    items = items.map((item) => {
        try {
            if (extractor.preprocessItem) item = extractor.preprocessItem(item);
            if (item.description) item.description = trimDescriptionToLastSentence(item.description, 1500);
            if (item.image) item.image = sanitizeImageUrl(item.image);
            sanitizeScrapedEvent(item, { source: name });
        } catch (e) {
            console.warn(`⚠️ [${name}] sanitize failed on "${item.title || '?'}": ${e.message}`);
        }
        return item;
    });

    meta.durationMs = Date.now() - startedAt;
    console.log(`✅ [${name}] Scraped ${items.length} items (listingHits=${meta.listingHits}, detailFailures=${meta.detailParseFailures}, duration=${Math.round(meta.durationMs / 1000)}s)`);
    return { items, meta };
}

module.exports = { runSource };
