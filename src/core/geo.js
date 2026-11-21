// src/core/geo.js
// Nepal-relevance filter. Pure functions, no bot state, no I/O beyond
// reading the committed gazetteer at require time.
//
// Policy (product decision, 2026-11-15):
//   - Nepal locations            -> keep
//   - India locations            -> drop (policy change 2026-11-21; was keep)
//   - Remote                     -> keep (regardless of company origin)
//   - Foreign (non-India)        -> drop
//   - Empty / ambiguous / unknown ->
//       * if source is nepal_based -> keep as nepal (no review)
//       * else                      -> keep + flag for /pending review
//
// Base-4 sources (sathijob, kumarijob, merojob, internsathi) always pass
// without classification -- they are Nepal-only by construction and would
// break if a Devanagari string or neighborhood-only name slipped through
// the classifier.
//
// Adding a new location: add to nepal_patterns (regex), india_patterns
// (regex), known_nepali_neighborhoods (substring), or misspelling_variants
// (substring) in src/config/nepal-gazetteer.json. No code change needed.

const rules = require('../config/nepal-gazetteer.json').rules;

const BASE_4 = new Set(['sathijob', 'kumarijob', 'merojob', 'internsathi']);
const NEPAL_BASED = new Set(rules.nepal_based_sources || []);

function compileRegex(pattern) {
    if (typeof pattern !== 'string' || !pattern) return null;
    let p = pattern.trim();
    // Strip (?i) inline flag -- JS RegExp does not support it; use 'i' flag instead.
    if (p.startsWith('(?i)')) p = p.slice(4);
    try { return new RegExp(p, 'i'); } catch (e) { return null; }
}

const nepalRes = rules.nepal_patterns.map(compileRegex).filter(Boolean);
const indiaRes = (rules.india_patterns || []).map(compileRegex).filter(Boolean);
const foreignHints = (rules.foreign_country_hints || []).map(s => s.toLowerCase());
const remotePats = (rules.remote_patterns || []).map(s => s.toLowerCase());
const neighborhoods = (rules.known_nepali_neighborhoods || []).map(s => s.toLowerCase());
const misspellings = Object.keys(rules.misspelling_variants || {}).map(s => s.toLowerCase());

// ---- Reject list (policy change 2026-11-21) ---------------------------------
// India and other foreign markets are dropped. Nepal patterns are still checked
// first in classifyLocation, so a multi-location string naming a Nepali place
// passes. The list runs before the remote rule, so "Remote, India" and
// "Remote (US only)" drop while plain "Remote" still passes.
const REJECT_TERMS = [
    'india', 'bangalore', 'bengaluru', 'new delhi', 'delhi', 'mumbai', 'hyderabad',
    'pune', 'chennai', 'kolkata', 'ahmedabad', 'jaipur', 'noida', 'gurgaon', 'gurugram',
    'tamil nadu', 'karnataka', 'maharashtra', 'telangana',
    'united states', 'united kingdom', 'canada', 'australia'
];
const REJECT_TERMS_RE = new RegExp(
    '\\b(?:' + REJECT_TERMS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i');
// Case-sensitive on purpose: "US"/"UK" as words, never "us" in prose.
const REJECT_CODES_RE = /(?:^|[^A-Za-z])(US|USA|UK|U\.S\.A?\.?|U\.K\.?)(?![A-Za-z])/;
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
    'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI',
    'SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];
// ", NJ" / ", NJ 08540" at the end of the string, case-sensitive.
const US_STATE_RE = new RegExp(',\\s*(?:' + US_STATES.join('|') + ')\\b\\s*(?:\\d{5}(?:-\\d{4})?)?\\s*$');

function matchRejectList(s) {
    let m = s.match(REJECT_TERMS_RE);
    if (m) return m[0].toLowerCase();
    m = s.match(REJECT_CODES_RE);
    if (m) return m[1];
    if (US_STATE_RE.test(s)) return 'us-state';
    return null;
}

/**
 * Classify a single location string.
 * @param {string|null|undefined} loc
 * @returns {{ class: 'nepal'|'india'|'remote'|'foreign'|'empty'|'unknown', matchedBy: string }}
 */
function classifyLocation(loc) {
    if (loc == null) return { class: 'empty', matchedBy: 'null' };
    const s = String(loc).trim();
    if (!s) return { class: 'empty', matchedBy: 'blank' };

    // Nepal patterns first -- highest priority.
    for (const re of nepalRes) if (re.test(s)) return { class: 'nepal', matchedBy: 'nepal_re' };

    // Explicit reject list: after Nepal (a Nepal signal wins), before India/remote.
    const rejected = matchRejectList(s);
    if (rejected) return { class: 'foreign', matchedBy: 'reject:' + rejected };

    // India patterns from the gazetteer (also dropped, see isNepalRelevant).
    for (const re of indiaRes) if (re.test(s)) return { class: 'india', matchedBy: 'india_re' };

    const lower = s.toLowerCase();

    // Remote (user policy: keep, regardless of company origin).
    for (const p of remotePats) if (lower.includes(p)) return { class: 'remote', matchedBy: 'remote:' + p };

    // Foreign hints. Ordered before neighborhood/misspelling fallbacks so
    // "Nepal, Texas" (US city) drops as foreign, not kept as nepal.
    for (const h of foreignHints) if (lower.includes(h)) return { class: 'foreign', matchedBy: 'hint:' + h };

    // Neighborhood fallback (no country hint, but well-known Kathmandu valley area).
    for (const n of neighborhoods) if (lower.includes(n)) return { class: 'nepal', matchedBy: 'neighborhood:' + n };

    // Misspelling fallback (all known misspellings map to Nepali places).
    for (const m of misspellings) if (lower.includes(m)) return { class: 'nepal', matchedBy: 'misspelling:' + m };

    return { class: 'unknown', matchedBy: 'no_match' };
}

/**
 * Decide whether an item should be kept.
 * Base-4 sources short-circuit and always pass (they are Nepal-only by
 * construction). Batch sources are classified by location.
 *
 * @param {{ location?: string|null }} item
 * @param {string} source
 * @returns {{ keep: boolean, reason: string, review?: string }}
 */
function isNepalRelevant(item, source) {
    if (BASE_4.has(source)) return { keep: true, reason: 'base-4' };

    const c = classifyLocation(item && item.location);

    // Short-circuit for nepal-based sources: an empty or unclassifiable
    // location from a nepal-based source is almost certainly a Nepal job
    // where the extractor could not find the location field. Pass it as
    // nepal, no review. Foreign locations on the same source still drop.
    if (NEPAL_BASED.has(source) && (c.class === 'empty' || c.class === 'unknown')) {
        return { keep: true, reason: 'nepal-source' };
    }

    switch (c.class) {
        case 'nepal':  return { keep: true, reason: 'nepal' };
        case 'india':  return { keep: false, reason: 'india' };
        case 'remote': return { keep: true, reason: 'remote' };
        case 'foreign': return { keep: false, reason: c.matchedBy };
        case 'empty':  return { keep: true, reason: 'empty', review: 'empty' };
        case 'unknown': return { keep: true, reason: 'unknown', review: 'unknown' };
        default:       return { keep: true, reason: 'unknown', review: 'unknown' };
    }
}

module.exports = {
    classifyLocation,
    isNepalRelevant,
    BASE_4,
    NEPAL_BASED,
    _rules: rules  // for tests / debug
};
