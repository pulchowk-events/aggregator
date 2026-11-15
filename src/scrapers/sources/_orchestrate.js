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
const { setSelectorContext } = require('../selectors');
const { withRetry } = require('../retry');
const { trimDescriptionToLastSentence, stripHtml } = require('../text');
const { sanitizeScrapedEvent, sanitizeImageUrl } = require('../sanitize');
const { deriveImageForUrl, derivePlaceholderForSource } = require('../ogImage');
const { isNepalRelevant } = require('../../core/geo');
const { applyItemFilters } = require('../itemFilter');

async function runSource(name, type, { withPage, progress }) {
    const { extractor, isStub } = loadExtractor(type, name);

    if (isStub) {
        console.warn(`⚠️ [${name}] extractor not implemented (only .example.js present) — see src/scrapers/extractors/README.md`);
        return { items: [], meta: { extractorMissing: true } };
    }

    // Set selector context for warning dedup + elapsed prefix. Cleared
    // per runSource so each source's warnings use its own timer.
    setSelectorContext(name);

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
            if (item.description) item.description = stripHtml(item.description);
            if (item.description) item.description = trimDescriptionToLastSentence(item.description, 1500);
            if (item.image) item.image = sanitizeImageUrl(item.image);
            sanitizeScrapedEvent(item, { source: name });
            // Provenance: 'source' means the extractor found a real per-item
            // image on the page (company logo, hero image, etc.). Set only
            // after sanitize so a rejected URL doesn't leave a false tag.
            if (item.image) item.imageSource = 'source';
        } catch (e) {
            console.warn(`⚠️ [${name}] sanitize failed on "${item.title || '?'}": ${e.message}`);
        }
        return item;
    }).filter(Boolean);

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
    // Nepal relevance filter (jobs only). Drops foreign items before
    // enrichment so we don't fetch og:image for posts that will never
    // be queued. Base-4 sources short-circuit inside geo.js (Nepal-only
    // by construction). Empty/unknown locations pass through with a
    // locationReview tag so /pending shows a review badge.
    if (type === 'jobs') {
        const before = items.length;
        items = items.filter((item) => {
            try {
                const v = isNepalRelevant(item, name);
                if (!v.keep) return false;
                if (v.review) item.locationReview = v.review;
                return true;
            } catch (e) {
                // Fail open -- unknown geo errors keep the item for review
                item.locationReview = 'geo-error';
                return true;
            }
        });
        const dropped = before - items.length;
        if (dropped > 0) {
            meta.locationDropped = dropped;
            console.log(`   [${name}] dropped ${dropped} non-Nepal job item(s)`);
        }
    }

    // Universal content-hygiene filter (all item types). Base-4 sources
    // short-circuit inside itemFilter -- their extractors produce clean
    // output and any change to already-posted items is regression risk.
    // Rules in src/config/item-filter-rules.json. Actions:
    //   drop             -> item = null (never reaches /pending)
    //   clear_field      -> field = null (item kept)
    //   strip_from_field -> exact bytes removed (item kept)
    //   split_field      -> paragraph breaks inserted (content preserved)
    //   fix_field        -> regex replace (title/description cleanup)
    //   flag_for_review  -> reviewFlags[] tagged (shown in /pending)
    if (items.length > 0) {
        let filterDropped = 0;
        items = items.filter((item) => {
            try {
                const res = applyItemFilters(item, type);
                if (res.item === null) {
                    filterDropped++;
                    return false;
                }
                item = res.item;
                return true;
            } catch (e) {
                console.warn(`\u26a0\ufe0f [${name}] itemFilter error on "${item.title || '?'}": ${e.message}`);
                return true;  // fail open
            }
        });
        if (filterDropped > 0) {
            meta.descriptionDropped = (meta.descriptionDropped || 0) + filterDropped;
            console.log(`   [${name}] dropped ${filterDropped} no-role item(s)`);
        }
    }

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
                    let imageSource = 'site';
                    // Fallback: placeholder PNG committed to assets/placeholders/
                    // (served as a GitHub raw URL so Discord can fetch it).
                    // One image per source (not per hostname) -- that's
                    // correct because the fallback is company-branded,
                    // not site-structure-derived.
                    if (!img) { img = derivePlaceholderForSource(name); imageSource = 'placeholder'; }
                    if (!img) return;
                    for (const it of group) {
                        it.companyLogoUrl = img;
                        it.image = img;
                        it.imageSource = imageSource;
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
