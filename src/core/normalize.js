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
    sanitizeTagsForDisplay,
    hardTruncateDescription,
    shortHash
};
