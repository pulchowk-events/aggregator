// src/scrapers/descriptionNormalize.js
//
// Shared description-normalize layer. Runs inside _orchestrate.js after
// stripHtml, before trimDescriptionToLastSentence. Rules-driven.
//
// Operations (in order):
//   1. no-role markers     -> return null (item dropped)
//   2. boilerplate strip   -> remove known verbatim paragraphs from ANY
//                             position (prefix, suffix, middle). If the
//                             strip leaves <20 chars, empty the
//                             description (boilerplate WAS the whole
//                             content -- item survives with title +
//                             structured fields, no site-wide blurb
//                             reaching Discord).
//   3. boilerplate prefix + newline -> fallback for partial prefixes
//                             that aren't full-paragraph matches.
//   4. pipe-dump           -> split on "|" + rejoin when structural
//                             labels present.
//
// Base-4 sources (sathijob, kumarijob, merojob, internsathi) skip ALL
// transformation. No-role drop still runs on base-4.

const rules = require('../config/description-filters.json');
const { BASE_4 } = require('../core/geo');

function matchesNoRole(text) {
    if (!text) return false;
    const lower = String(text).toLowerCase();
    return (rules.no_role_markers || []).some(m => lower.includes(m.toLowerCase()));
}

// Normalize unicode punctuation for MATCHING only. Curly apostrophes
// (U+2019) in source text vs straight quotes (') in rule text are the
// same character but fail indexOf() without this. Every replacement is
// 1-char-to-1-char in UTF-16 code units, so slice() by original index
// works after normalizing.
function normalizeForMatch(s) {
    return String(s).toLowerCase()
        .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
        .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
        .replace(/[\u2013\u2014]/g, '-');
}

/**
 * Remove known verbatim boilerplate paragraphs from anywhere in `desc`.
 * @returns {{ stripped: string, matched: boolean }}
 */
function stripBoilerplateAnywhere(desc) {
    let out = desc;
    let matched = false;
    for (const full of (rules.boilerplate_full_paragraphs || [])) {
        const fullN = normalizeForMatch(full);
        // Re-normalize on every iteration because out changed.
        const idxN = normalizeForMatch(out).indexOf(fullN);
        if (idxN < 0) continue;
        // Slice by idxN + full.length -- safe because normalizeForMatch is 1:1.
        out = (out.slice(0, idxN) + out.slice(idxN + full.length))
            .replace(/\s+/g, ' ').trim();
        matched = true;
    }
    return { stripped: out, matched };
}

/**
 * Prefix + newline fallback for partial prefixes that didn't match a
 * full paragraph. Only used when stripBoilerplateAnywhere missed.
 */
function stripPartialPrefix(desc) {
    const descN = normalizeForMatch(desc);
    for (const bp of (rules.boilerplate_prefixes || [])) {
        const bpN = normalizeForMatch(bp);
        if (!descN.startsWith(bpN)) continue;
        const idx = desc.indexOf('\n');
        if (idx < 0) return { stripped: desc, matched: false };
        return { stripped: desc.slice(idx).trim(), matched: true };
    }
    return { stripped: desc, matched: false };
}

function splitPipeDump(desc) {
    if (!desc.includes('|')) return desc;
    const parts = desc.split('|').map(p => p.trim()).filter(Boolean);
    if (parts.length < 3) return desc;
    const hasStructural = parts.some(p =>
        (rules.structural_keywords || []).some(k => p.includes(k))
    );
    if (!hasStructural) return desc;
    const cleaned = parts.filter(p => {
        const lp = p.toLowerCase();
        return !(rules.nav_labels || []).some(n => {
            const ln = n.toLowerCase();
            return lp === ln || lp.startsWith(ln + ' ') || lp.startsWith(ln + '-');
        });
    });
    if (cleaned.length < 2) return desc;
    return cleaned.join('\n\n');
}

/**
 * Normalize a job item's description.
 * @param {Object} item
 * @param {string} source
 * @returns {Object|null} the item (mutated) or null if it should be dropped
 */
function normalizeDescription(item, source) {
    if (!item || typeof item.description !== 'string' || !item.description) return item;

    if (matchesNoRole(item.description) || matchesNoRole(item.title)) return null;

    if (BASE_4.has(source)) return item;

    let desc = item.description;

    let { stripped, matched } = stripBoilerplateAnywhere(desc);
    if (!matched) {
        ({ stripped, matched } = stripPartialPrefix(desc));
    }

    if (matched && stripped.length < 20) {
        // Boilerplate WAS the entire description. Clear rather than
        // repeat site-wide blurb as role content.
        desc = '';
    } else {
        desc = stripped;
    }

    desc = splitPipeDump(desc);
    desc = desc.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    item.description = desc;
    return item;
}

module.exports = { normalizeDescription };
