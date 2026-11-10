// src/posting/category.js
// Category classification.
//
// Three-tier decision, in this order (first hit wins):
//
//   1. itemType fast-path — jobs always route to 'jobs', scholarships to
//      'scholarships'. No keyword scan happens for these; the type is
//      authoritative.
//
//   2. Fast-path tag / category exact match — if the item has an explicit
//      tag or category field that names a category, that's the intent, no
//      guessing needed. Set is small and explicit.
//
//   3. Keyword-dictionary fallback — scan title + description + category
//      + joined tags against CATEGORY_KEYWORDS. First matching category
//      in declaration order wins (order is stable so identical inputs
//      always resolve the same way).
//
// If nothing hits, 'miscellaneous' is the answer — never null.
//
// Every decision is logged with the path that produced it, so a "why did
// this land in miscellaneous?" question is always answerable from the
// audit log.

const { auditLog } = require('../core/auditLogger');
const { textContainsKeyword } = require('../core/normalize');
const { CATEGORY_KEYWORDS } = require('../config/constants');

// Fast-path exact-match tags per category. Deliberately narrow — anything
// not listed here falls through to the keyword dictionary. Order matters
// only insofar as a title with BOTH "sports" tag and "music" category hit
// resolves to whichever comes first in the list below.
const FAST_PATH_CHECKS = [
    { key: 'sports',   tags: ['sports'],                        catSubstr: 'sport' },
    { key: 'software', tags: ['software', 'tech'],              catSubstr: 'software' },
    { key: 'hardware', tags: ['hardware'],                      catSubstr: 'hardware' },
    { key: 'gaming',   tags: ['gaming'],                        catSubstr: 'gaming' },
    { key: 'music',    tags: ['music'],                         catSubstr: 'music' },
    { key: 'business', tags: ['business', 'startup'],           catSubstr: 'business' }
];

function determineCategory(event) {
    if (!event) return 'miscellaneous';

    // 1. Type fast-path.
    if (event.itemType === 'job') return 'jobs';
    if (event.itemType === 'scholarship') return 'scholarships';

    const tags = Array.isArray(event.tags) ? event.tags.map((t) => String(t).toLowerCase()) : [];
    const cat = String(event.category || '').toLowerCase();

    const baseLogData = {
        eventId: event.id || null,
        title: event.title || null,
        source: event.source || null,
        tags,
        category: cat
    };

    // 2. Fast-path exact tag / category match.
    for (const check of FAST_PATH_CHECKS) {
        const tagHit = check.tags.some((t) => tags.includes(t));
        const catHit = cat.includes(check.catSubstr);
        if (tagHit || catHit) {
            auditLog('determine_category',
                `"${event.title}" -> ${check.key} via fast-path exact tag/category match`,
                { ...baseLogData, resolvedCategory: check.key, path: 'fast_path_exact_match', via: tagHit ? 'tag' : 'category' });
            return check.key;
        }
    }

    // 3. Keyword-dictionary fallback.
    const haystack = [event.title, event.description, cat, tags.join(' ')]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    const allMatches = [];
    for (const [categoryKey, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
        const matched = keywords.filter((kw) => textContainsKeyword(haystack, kw));
        if (matched.length > 0) allMatches.push({ categoryKey, matchedKeywords: matched });
    }

    if (allMatches.length > 0) {
        const winner = allMatches[0].categoryKey;   // declaration order is priority
        auditLog(
            'determine_category',
            allMatches.length > 1
                ? `"${event.title}" -> ${winner} via keyword fallback (${allMatches.length} categories matched, ${winner} won by priority)`
                : `"${event.title}" -> ${winner} via keyword fallback`,
            { ...baseLogData, resolvedCategory: winner, path: 'keyword_dictionary_fallback', allMatchedCategories: allMatches }
        );
        return winner;
    }

    // 4. Nothing hit — miscellaneous.
    auditLog('determine_category',
        `"${event.title}" -> miscellaneous (fell through, no fast-path or keyword match)`,
        { ...baseLogData, resolvedCategory: 'miscellaneous', path: 'fell_through_to_miscellaneous' });
    return 'miscellaneous';
}

module.exports = { determineCategory };
