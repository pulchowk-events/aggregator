// src/scrapers/sanitize.js
// Scraper-side field sanitization.
//
// Distinct from core/sanitize.js: that one runs in the bot pipeline and can
// see post-scrape state (dataQualityWarnings, deadlineStatus, etc.). THIS
// one runs inside a source plugin, on the freshly-scraped object, before
// it's returned to the registry.
//
// Why both exist: a source plugin can only fix what it just produced. It
// can't check "does this event have a valid image" because that depends on
// how the item got shaped downstream. It CAN check "did my date-selector
// hit a category chip by mistake" — which is exactly what this does.
//
// Also: image URL sanitization happens here (turning data URIs / placeholder
// patterns into null) so no source ever returns an item with a fake image
// URL that bot.js's sanitizeEventFields would then have to clean up.
//
// Both this and core/sanitize.js share the validators in core/normalize.js
// so we never diverge on what "a category chip" or "a valid URL" means.

const { auditLog } = require('../core/auditLogger');
const { looksLikeCategoryLabel, looksLikeMisplacedNonCategoryValue, isValidImageUrl } = require('../core/normalize');

// Detect a "category chip" value in a field that should hold a date/time/
// price/organizer — the emoji + no-digits pattern. This is a local copy
// with its own signature (kept here rather than imported) because source
// plugins need a stable name to call without pulling in core/sanitize.js's
// field-guessing machinery.
function looksLikeCategoryChip(value) {
    if (!value || typeof value !== 'string') return false;
    const v = value.trim();
    if (!v) return false;
    const startsWithEmoji = /^[\u{1F000}-\u{1FFFF}\u{2190}-\u{2BFF}\u{2600}-\u{27BF}]/u.test(v);
    return startsWithEmoji && !/\d/.test(v);
}

// Sanitize an image URL that a scraper just pulled out of the DOM. Returns
// null for data URIs, placeholders, and anything non-http. This is the
// source-side enforcement of "no fake images reach cache.json" — the bot
// re-checks with isValidImageUrl but that's a second line of defense.
function sanitizeImageUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!(trimmed.startsWith('http://') || trimmed.startsWith('https://'))) return null;
    if (/\b(blank|placeholder|spacer|pixel|1x1)\b/i.test(trimmed)) return null;
    return trimmed;
}

// Clean a single scraped event-like object.
// Mutates `event` and returns it. Warnings collected under
// `event.dataQualityWarnings` (deduped).
function sanitizeScrapedEvent(event, { source = null } = {}) {
    if (!event) return event;
    const warnings = [];

    if (event.date && looksLikeCategoryChip(event.date)) {
        warnings.push(`Date field looked like a category/tag, not a date: "${event.date}" — cleared.`);
        event.rawSuspectDate = event.date;
        event.date = null;
    }

    if (event.price && event.price !== 'Free' && looksLikeCategoryChip(event.price)) {
        warnings.push(`Price field looked like a category/tag, not a price: "${event.price}" — cleared.`);
        event.rawSuspectPrice = event.price;
        event.price = 'TBD';
    }

    if (event.time && looksLikeCategoryChip(event.time)) {
        warnings.push(`Time field looked like a category/tag, not a time: "${event.time}" — cleared.`);
        event.rawSuspectTime = event.time;
        event.time = null;
    }

    if (event.organizer && looksLikeCategoryChip(event.organizer)) {
        warnings.push(`Organizer field looked like a category/tag, not an organizer name: "${event.organizer}" — cleared.`);
        event.rawSuspectOrganizer = event.organizer;
        event.organizer = null;
    }

    if (event.category && looksLikeMisplacedNonCategoryValue(event.category)) {
        warnings.push(`Category field looked like a date/price/URL, not a category: "${event.category}" — cleared.`);
        event.rawSuspectCategory = event.category;
        event.category = null;
    }

    // Image: turn invalid → null unconditionally. We don't warn here
    // because "no image" isn't a data-quality issue — it's a gate that
    // the bot handles (hasValidImage).
    if (event.image) {
        const cleaned = sanitizeImageUrl(event.image);
        if (!cleaned && event.image !== null) {
            event.rawSuspectImage = event.image;
        }
        event.image = cleaned;
    }

    if (warnings.length > 0) {
        const merged = (event.dataQualityWarnings || []).concat(warnings);
        event.dataQualityWarnings = Array.from(new Set(merged));
    }

    auditLog(
        'sanitize_scraped_event',
        warnings.length > 0
            ? `sanitizeScrapedEvent() found ${warnings.length} warning(s) for "${event.title || 'untitled'}"`
            : `sanitizeScrapedEvent() found nothing to clear for "${event.title || 'untitled'}"`,
        {
            id: event.id || null,
            title: event.title || null,
            source: source || event.source || null,
            warningsFound: warnings.length > 0,
            warnings,
            rawSuspectDate: event.rawSuspectDate || null,
            rawSuspectPrice: event.rawSuspectPrice || null,
            rawSuspectTime: event.rawSuspectTime || null,
            rawSuspectOrganizer: event.rawSuspectOrganizer || null,
            rawSuspectCategory: event.rawSuspectCategory || null,
            rawSuspectImage: event.rawSuspectImage || null,
            event
        }
    );

    return event;
}

module.exports = {
    sanitizeScrapedEvent,
    sanitizeImageUrl,
    looksLikeCategoryChip
};
