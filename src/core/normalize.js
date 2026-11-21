// src/core/normalize.js
// String normalization and small validators shared by dedup, category
// matching, sanitize, and message formatting.
//
// Rule: nothing here may read from cache, discord, or filesystem. Pure
// functions of their arguments only, so tests can pin behaviour without a
// full bot instance.

const { SUSPECT_CATEGORY_WORDS } = require('../config/constants');

// Lowercase, strip non-word characters, collapse whitespace. Used for
// postedEventNames, postedEventKeys, and any title-vs-title comparison.
function normalizeEventName(name) {
    if (!name) return '';
    return name.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Levenshtein distance — the classic O(n*m) DP, no shortcuts. Titles are
// short (<200 chars) so the memory hit is negligible.
function levenshteinDistance(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const temp = dp[j];
            dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
            prev = temp;
        }
    }
    return dp[n];
}

// 0..1 similarity, 1 = identical. Used as the FUZZY secondary signal only
// — never standalone (see findFuzzyDuplicateMatch in the bot).
function titleSimilarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1;
    return 1 - (levenshteinDistance(a, b) / maxLen);
}

// True if `haystack` contains `keyword` as a whole word (for single-word
// keywords) or as a substring (for multi-word keywords). The distinction
// matters: `\bai\b` prevents "email" from matching "ai", but "\bsafety
// research\b" wouldn't match the multi-word phrase at all, so it falls
// through to a plain substring search.
function textContainsKeyword(haystack, keyword) {
    if (keyword.includes(' ')) return haystack.includes(keyword);
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`, 'i');
    return re.test(haystack);
}

// Strip emoji + punctuation + lowercase. Used by looksLikeCategoryLabel to
// see past "🎵Music" -> "music".
function stripEmojiAndPunct(str) {
    return str
        .replace(/[\u{1F000}-\u{1FFFF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}]/gu, '')
        .replace(/[^\w\s]/g, '')
        .trim()
        .toLowerCase();
}

// A scraped field "looks like a category label" if it starts with an emoji
// and has no digits ("🎵Music"), OR it's a bare category word with no
// digits ("Music", "Sports"). Digits are the tell: a real date, price, or
// time always contains at least one digit; a tag doesn't.
function looksLikeCategoryLabel(value) {
    if (!value || typeof value !== 'string') return false;
    const v = value.trim();
    if (!v) return false;
    const hasDigit = /\d/.test(v);
    const startsWithEmoji = /^[\u{1F000}-\u{1FFFF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}]/u.test(v);
    if (startsWithEmoji && !hasDigit) return true;
    if (!hasDigit) {
        const stripped = stripEmojiAndPunct(v);
        if (stripped && SUSPECT_CATEGORY_WORDS.has(stripped)) return true;
    }
    return false;
}

// A value is "misplaced non-category" if it's a URL, a date, an ISO date,
// or a price — any of which could plausibly be scraped into the `category`
// slot by a bad selector.
function looksLikeMisplacedNonCategoryValue(value) {
    if (!value || typeof value !== 'string') return false;
    const v = value.trim();
    if (!v) return false;
    if (/^https?:\/\//i.test(v)) return true;
    if (/\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(v)) return true;
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return true;
    if (/(rs\.?\s?\d|npr\s?\d|\$\d|₹\d)/i.test(v)) return true;
    return false;
}

// Placeholder / data-URI images must be treated as "no image" — a data URI
// can't be fetched by the poster's axios pipeline, and placeholders are
// always the same 1x1 pixel that would look broken in a post.
function isValidImageUrl(value) {
    if (!value || typeof value !== 'string') return false;
    const v = value.trim();
    if (!v) return false;
    if (!(v.startsWith('http://') || v.startsWith('https://'))) return false;
    if (/\b(blank|placeholder|spacer|pixel|1x1)\b/i.test(v)) return false;
    return true;
}

// Registration / source URLs must be absolute http(s) and parseable.
function isValidRegistrationUrl(value) {
    if (!value || typeof value !== 'string') return false;
    const v = value.trim();
    if (!(v.startsWith('http://') || v.startsWith('https://'))) return false;
    try { new URL(v); return true; } catch (e) { return false; }
}

// DQ-2: a scraped "- Logo" / "| Image" / "- Icon" suffix comes from an <img alt>.
// Returns the name without it; never returns an empty string (falls back to the input).
const LOGO_SUFFIX_RE = new RegExp('\\s*[-' + String.fromCharCode(0x2013, 0x2014) + '|]\\s*(?:logo|image|icon)\\s*$', 'i');
function stripLogoSuffix(value) {
    if (typeof value !== 'string') return value;
    const stripped = value.replace(LOGO_SUFFIX_RE, '').trim();
    return stripped || value;
}

// DQ-2: pull the bare address out of a mailto: value. Drops the "?subject=..." query,
// decodes %xx escapes, and takes the first address of a comma-separated list.
// Returns null when the value is not a mailto: or holds no valid address. Pure.
function extractMailtoAddress(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    if (!/^mailto:/i.test(v)) return null;
    let addr = v.replace(/^mailto:/i, '').split('?')[0];
    try { addr = decodeURIComponent(addr); } catch (e) { /* keep raw */ }
    const email = addr.split(',')[0].trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

// DQ-2: apply-by-email fallback. A mailto: link is not a web URL, but it is a real way to
// apply. The address moves to item.applyEmail; url / registrationUrl are pointed at a real
// page (item.url, else item.registrationUrl, else item.companyUrl) when they are not already
// valid http(s). Scans every field a scraper or an earlier sanitize pass may have left the
// mailto in, including the rawSuspect* audit copies, so already-cleared items recover on
// re-runs. Also drops stale "...not a well-formed http(s) URL: "mailto:" warnings (both the
// Registration and the Event variants) so they stop tripping hasDataQualityWarnings.
// Mutates item. Returns true when it changed anything. Needs a valid page URL to fall back to.
const MAILTO_SOURCE_FIELDS = ['registrationUrl', 'url', 'applicationUrl', 'rawSuspectRegistrationUrl', 'rawSuspectUrl'];
const MAILTO_WARNING_RE = /^(?:Registration|Event) URL was not a well-formed http\(s\) URL: "mailto:/i;
function applyMailtoFallback(item) {
    if (!item) return false;
    let email = null;
    for (const f of MAILTO_SOURCE_FIELDS) {
        email = extractMailtoAddress(item[f]);
        if (email) break;
    }
    if (!email) return false;

    let pageUrl = null;
    for (const c of [item.url, item.registrationUrl, item.companyUrl]) {
        if (isValidRegistrationUrl(c)) { pageUrl = c.trim(); break; }
    }
    if (!pageUrl) return false;

    let changed = false;
    if (!item.applyEmail) { item.applyEmail = email; changed = true; }
    if (!isValidRegistrationUrl(item.registrationUrl)) { item.registrationUrl = pageUrl; changed = true; }
    if (!isValidRegistrationUrl(item.url)) { item.url = pageUrl; changed = true; }
    if (Array.isArray(item.dataQualityWarnings)) {
        const kept = item.dataQualityWarnings.filter((w) => !MAILTO_WARNING_RE.test(String(w)));
        if (kept.length !== item.dataQualityWarnings.length) { item.dataQualityWarnings = kept; changed = true; }
    }
    return changed;
}

// Final shape-check for tags rendered in a post body. Rejects anything
// that could break markdown, inject newlines, or blow past the length cap.
// Returns at most MAX_TAGS_RENDERED items.
function sanitizeTagsForDisplay(tags, maxTags, maxTagLength) {
    if (!Array.isArray(tags)) return [];
    const cleaned = [];
    for (const t of tags) {
        if (typeof t !== 'string') continue;
        const trimmed = t.trim();
        if (!trimmed || trimmed.length > maxTagLength) continue;
        if (/[\r\n]/.test(trimmed)) continue;
        if (!/^[\w\s\-#&.]+$/u.test(trimmed)) continue;
        cleaned.push(trimmed);
        if (cleaned.length >= maxTags) break;
    }
    return cleaned;
}

// Truncate `description` to fit under `maxLength`, preferring to end on a
// sentence boundary. If the first period is past 50% of the budget we use
// it, otherwise we hard-trim + ellipsis. Mirrors the original bot's
// behaviour so message rendering is byte-identical.
function hardTruncateDescription(description, maxLength) {
    if (!description || maxLength <= 0) return '';
    if (description.length <= maxLength) return description;
    let trimmed = description.substring(0, maxLength);
    const lastPeriod = trimmed.lastIndexOf('.');
    if (lastPeriod > maxLength * 0.5) {
        trimmed = trimmed.substring(0, lastPeriod + 1);
    } else {
        trimmed = trimmed.trim() + '…';
    }
    return trimmed;
}

// Bounded-length SHA-1 hex, used for dedup-fallback components. Not a
// security hash — just a stable short identifier.
const crypto = require('crypto');
function shortHash(input, length = 12) {
    return crypto.createHash('sha1').update(input).digest('hex').slice(0, length);
}

module.exports = {
    normalizeEventName,
    levenshteinDistance,
    titleSimilarity,
    textContainsKeyword,
    stripEmojiAndPunct,
    looksLikeCategoryLabel,
    looksLikeMisplacedNonCategoryValue,
    isValidImageUrl,
    isValidRegistrationUrl,
    applyMailtoFallback,
    extractMailtoAddress,
    stripLogoSuffix,
    sanitizeTagsForDisplay,
    hardTruncateDescription,
    shortHash
};
