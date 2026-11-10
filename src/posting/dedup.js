// src/posting/dedup.js
// Dedup key computation and fuzzy match detection.
//
// All functions here are pure — no cache, no discord, no bot instance.
// Callers that DO have a bot (bot.js methods, /pending, autopost) can pass
// items straight in; unit tests can construct minimal fake items.
//
// Two independent signals:
//
//   Exact key   — normalizedTitle|canonicalDate. Deterministic, cheap.
//                 Catches the same item scraped twice (identical title +
//                 identical date).
//
//   Fuzzy match — Levenshtein similarity >= FUZZY_TITLE_SIMILARITY_THRESHOLD
//                 (or SCHOLARSHIP_FUZZY_TITLE_SIMILARITY_THRESHOLD for
//                 scholarships) within the same canonical date. Catches
//                 minor wording drift between sources on the same event.
//
// Fuzzy is a SECONDARY signal only — never used standalone. The caller
// (dedup-decision logic in the scrape pipeline) decides whether a fuzzy
// match means "definitely duplicate" (same source — skip) or "possible
// duplicate" (cross-source — flag for human review, don't auto-merge).

const crypto = require('crypto');
const { getCanonicalDateForDedup } = require('../core/dateUtils');
const { normalizeEventName, titleSimilarity, shortHash } = require('../core/normalize');
const {
    FUZZY_TITLE_SIMILARITY_THRESHOLD,
    SCHOLARSHIP_FUZZY_TITLE_SIMILARITY_THRESHOLD
} = require('../config/constants');

// Fallback component for date-less items. Deliberately NOT a bare "null"
// — that would collapse every date-less item onto the same key and merge
// unrelated events. Prefer registrationUrl (stable, uniquely identifies the
// source page); otherwise hash the source + first 200 chars of description.
function getDedupFallbackComponent(event) {
    const url = (event.registrationUrl || event.url || '').trim();
    if (url) return `url:${url.toLowerCase()}`;
    const desc = (event.description || '').trim().slice(0, 200).toLowerCase();
    const source = (event.source || '').toLowerCase();
    const hash = shortHash(`${source}|${desc}`, 12);
    return `hash:${hash}`;
}

// Deterministic dedup key for an item.
//
//   With a parseable date:      normalizedTitle|yyyy-LL-dd
//   Without (or unparseable):   normalizedTitle|nodate:<url-or-hash>
//
// Lowercased so the key is case-insensitive end-to-end.
function getEventDedupKey(event) {
    const normalizedTitle = normalizeEventName(event.title || '');
    const canonicalDate = getCanonicalDateForDedup(event);
    if (canonicalDate) return `${normalizedTitle}|${canonicalDate}`.toLowerCase();
    const fallback = getDedupFallbackComponent(event);
    return `${normalizedTitle}|nodate:${fallback}`.toLowerCase();
}

// Is this item a fuzzy duplicate of anything in the pool?
//
// Two things gate whether the fuzzy scan runs at all:
//   - the item must have a canonical date (no reliable anchor otherwise)
//   - the item must have a non-empty normalized title
//
// Within the scan, candidates are skipped when:
//   - they ARE the same object (defensive — pool might include the item)
//   - their canonical date differs (fuzzy is only meaningful within-date)
//   - their normalized title exactly matches (that's the exact-key case,
//     not a fuzzy one)
//
// Threshold: stricter for scholarships (SCHOLARSHIP_FUZZY_TITLE_SIMILARITY_THRESHOLD)
// because scholarship titles share a lot of cross-source boilerplate.
//
// Returns { candidate, similarity } on match, null otherwise.
function findFuzzyDuplicateMatch(event, candidatePool) {
    if (!event || !Array.isArray(candidatePool)) return null;

    const canonicalDate = getCanonicalDateForDedup(event);
    if (!canonicalDate) return null;
    const normalizedTitle = normalizeEventName(event.title || '');
    if (!normalizedTitle) return null;

    const threshold = event.itemType === 'scholarship'
        ? SCHOLARSHIP_FUZZY_TITLE_SIMILARITY_THRESHOLD
        : FUZZY_TITLE_SIMILARITY_THRESHOLD;

    for (const candidate of candidatePool) {
        if (!candidate || candidate === event) continue;
        const candidateDate = getCanonicalDateForDedup(candidate);
        if (candidateDate !== canonicalDate) continue;
        const candidateTitle = normalizeEventName(candidate.title || '');
        if (!candidateTitle || candidateTitle === normalizedTitle) continue;
        const similarity = titleSimilarity(normalizedTitle, candidateTitle);
        if (similarity >= threshold) return { candidate, similarity };
    }
    return null;
}

// Keep the first occurrence of each dedup key, drop later duplicates.
// Preserves original array order. Used by /pending and by the scrape
// pipeline before items go to review.
function deduplicateEventsByKey(events) {
    const seen = new Set();
    const unique = [];
    for (const ev of events) {
        const key = getEventDedupKey(ev);
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(ev);
        }
    }
    return unique;
}

module.exports = {
    getDedupFallbackComponent,
    getEventDedupKey,
    findFuzzyDuplicateMatch,
    deduplicateEventsByKey
};
