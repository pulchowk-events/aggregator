// scripts/wizard/detect.js
// Site-type classification from dump output. Pure function — takes what
// dump.js produced, returns a structured verdict the prompt generator
// turns into natural language.
//
// Site types:
//   'jsonld-first'       — detail pages have well-formed JSON-LD (Event or
//                          EducationEvent). Fastest, most reliable path.
//   'listing-to-detail'  — listing yields distinct detail links, detail
//                          pages have no usable JSON-LD. HTML extraction.
//   'single-page-cards'  — all data lives on listing cards, no detail
//                          navigation needed (Khalti pattern).
//   'unknown'            — nothing clearly points one way or another.
//
// Additional signals (booleans, attached to the verdict):
//   isPaginated      — Next link / ?page=N / Load more
//   isVirtualized    — Load more present (scroll loop likely needed)
//   hasCategories    — chip-like anchors or elements
//   hasJsonLd        — any @type in listing JSON-LD
//   hasDetailJsonLd  — any @type in detail JSON-LD
//   hasCardWrapper   — a strong card-group fingerprint

function detectSiteType(listing, detail = null) {
    const signals = {
        isPaginated: Boolean(listing.pagination && (listing.pagination.hasNextRel || listing.pagination.pageParamCount > 0)),
        isVirtualized: Boolean(listing.pagination && listing.pagination.hasLoadMore),
        hasCategories: listing.categoryChips && listing.categoryChips.length > 0,
        hasJsonLd: listing.jsonLdTypes && listing.jsonLdTypes.length > 0,
        hasDetailJsonLd: detail && detail.jsonLdSamples && detail.jsonLdSamples.length > 0,
        hasCardWrapper: listing.cardGroups && listing.cardGroups.length > 0
    };

    // Detail JSON-LD wins — if we already have structured data, use it.
    if (signals.hasDetailJsonLd) {
        const eventJsonLd = detail.jsonLdSamples.find(s => /Event|EducationEvent/.test(s.type));
        if (eventJsonLd) {
            return { type: 'jsonld-first', signals, evidence: { eventJsonLdType: eventJsonLd.type, eventJsonLdKeys: eventJsonLd.keys } };
        }
        // JSON-LD present but not Event type — probably site-wide boilerplate
    }

    // Distinct detail-link patterns → listing-to-detail.
    const detailLikePattern = (listing.anchorGroups || [])
        .filter(g => g.count >= 3)
        .filter(g => !/^\/(category|tag|search|filter|about|contact)/i.test(g.pattern))
        .sort((a, b) => b.count - a.count)[0];
    if (detailLikePattern) {
        return {
            type: 'listing-to-detail',
            signals,
            evidence: {
                detailLinkPattern: detailLikePattern.pattern,
                detailLinkCount: detailLikePattern.count,
                sampleHrefs: detailLikePattern.samples.map(s => s.href)
            }
        };
    }

    // No distinct detail links but a strong card wrapper → single-page-cards.
    if (signals.hasCardWrapper) {
        return {
            type: 'single-page-cards',
            signals,
            evidence: { cardSelector: listing.cardGroups[0].selector, cardCount: listing.cardGroups[0].count }
        };
    }

    // Nothing to go on.
    return { type: 'unknown', signals, evidence: {} };
}

module.exports = { detectSiteType };
