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
const { deriveImageForUrl, derivePlaceholderForSource } = require('../ogImage');

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

    // Enrichment: for job items that carry no image after extraction,
    // derive a per-site image from <meta og:image> or the site favicon.
    // Runs only when runSource was called for `type === 'jobs'` -- for
    // events and scholarships this is a no-op. Groups by hostname so we
    // trigger one fetch per unique domain (ogImage.js additionally
    // deduplicates in-flight requests, so 68 items from one host still
    // cause exactly one HTTP fetch).
    //
    // Failures here never break extraction: a null image stays null, and
    // the live-post hasValidImage gate will reject it (same as before).
    // Cost: ~1s latency for the first scrape per domain; cache hit after
    // that. data/og-image-cache.json TTL is 30 days.
    if (type === 'jobs') {
        const itemsNeedingImage = items.filter((it) => it && !it.image);
        if (itemsNeedingImage.length > 0) {
            const byHost = new Map();
            for (const it of itemsNeedingImage) {
                const ref = it.url || it.registrationUrl;
                if (!ref) continue;
                let host;
                try { host = new URL(ref).hostname.toLowerCase(); } catch (e) { continue; }
                if (!byHost.has(host)) byHost.set(host, []);
                byHost.get(host).push(it);
            }
            let enriched = 0;
            await Promise.all([...byHost.entries()].map(async ([host, group]) => {
                try {
                    const sample = group[0];
                    // Try og:image / favicon first.
                    let img = await deriveImageForUrl(sample.url || sample.registrationUrl);
                    // Fallback: placeholder PNG generated for this source.
                    // One image per source (not per hostname) -- that's
                    // correct because the fallback is company-branded,
                    // not site-structure-derived.
                    if (!img) img = derivePlaceholderForSource(name);
                    if (!img) return;
                    for (const it of group) {
                        it.companyLogoUrl = img;
                        it.image = img;
                        enriched++;
                    }
                } catch (e) {
                    // best-effort; enrichment failure leaves items as they were
                }
            }));
            meta.imagesEnriched = enriched;
            if (enriched > 0) {
                console.log(`   [${name}] derived site image for ${enriched}/${itemsNeedingImage.length} job item(s) from og:image/favicon`);
            }
        }
    }

    meta.durationMs = Date.now() - startedAt;
    console.log(`✅ [${name}] Scraped ${items.length} items (listingHits=${meta.listingHits}, detailFailures=${meta.detailParseFailures}, duration=${Math.round(meta.durationMs / 1000)}s)`);
    return { items, meta };
}

module.exports = { runSource };
