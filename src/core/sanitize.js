// src/core/sanitize.js
// Field-level cleanup for scraped events/jobs/scholarships.
//
// What this does, and why:
//   Some source sites reuse the same CSS classes for "date badge" and
//   "category/tag chip" — so a selector meant for one ends up grabbing
//   the other (see: "Time: 🎵Music" in a real post). Rather than let that
//   garbage through, we CLEAR the offending field (callers already treat
//   those fields as optional) and record what was dropped as a
//   dataQualityWarning so it surfaces for a human in /pending instead of
//   silently posting wrong info.
//
// Two entry points:
//   sanitizeEventFields(item)     — called from bot/pipeline; mutates + returns
//   sanitizeScrapedEvent(item)    — narrower subset for scraper output, kept
//                                   distinct so scraper-side warnings never
//                                   pretend to know bot-side state
//
// The audit log is fired on every call, matching the original bot's
// behaviour — full before/after state for every field the pass touched.

const { auditLog } = require('./auditLogger');
const { cleanScholarshipDeadlineText } = require('./deadlineText');
const { parseEventDate } = require('./dateUtils');
const {
    looksLikeCategoryLabel,
    looksLikeMisplacedNonCategoryValue,
    isValidImageUrl,
    isValidRegistrationUrl
} = require('./normalize');

// Warnings are collected rather than thrown so a single bad field never
// aborts the whole item. The return contract is: always return `item`,
// always add any warnings to `item.dataQualityWarnings` (deduped), always
// audit the pass.
function sanitizeEventFields(event) {
    if (!event) return event;
    const warnings = [];

    // ---------- Date ----------
    // If the date field looks like a category label, clear it (it's not a
    // date). But if the date field is merely UNPARSEABLE (not a category
    // label), we do NOT clear it — the raw text is still worth showing a
    // human in /pending, it just can't be trusted for date math.
    if (event.date && looksLikeCategoryLabel(event.date)) {
        if (!event.rawSuspectDate) event.rawSuspectDate = event.date;
        warnings.push(`Date field looked like a category label, not a date: "${event.date}" — cleared.`);
        event.date = null;
    }
    // Note: this does NOT clear event.date, unlike the category-label case
    // above — the raw text is still worth showing a human in /pending, it
    // just can't be trusted for date math. Routes through dataQualityWarnings
    // instead of a second gate.
    if (event.date && !parseEventDate(event)) {
        if (!event.rawSuspectDate) event.rawSuspectDate = event.date;
        warnings.push(`Date field could not be parsed into a usable date: "${event.date}" — flagged for manual review, not cleared.`);
    }

    // ---------- Scholarship deadline text ----------
    // Only when the deadline is confirmed parsed (status === 'parsed') —
    // 'rolling' / 'unknown' / 'estimated-year-only' have their own
    // display logic that lives in the scholarship normalizer.
    if (event.itemType === 'scholarship' && event.deadlineStatus === 'parsed') {
        const source = event.deadlineRaw || event.deadlineDisplay;
        const cleaned = cleanScholarshipDeadlineText(source);
        if (cleaned && cleaned !== event.deadlineDisplay) {
            if (!event.rawSuspectDeadlineDisplay) event.rawSuspectDeadlineDisplay = event.deadlineDisplay;
            event.deadlineDisplay = cleaned;
            warnings.push(`Deadline text was messy/unparsed boilerplate — cleaned to: "${cleaned}"`);
        }
    }

    // ---------- Price ----------
    // 'Free' and 'TBD' are the two legit non-numeric prices; anything else
    // that "looks like a category label" is a mislabel and becomes 'TBD'.
    if (event.price && event.price !== 'Free' && event.price !== 'TBD' && looksLikeCategoryLabel(event.price)) {
        if (!event.rawSuspectPrice) event.rawSuspectPrice = event.price;
        warnings.push(`Price field looked like a category label, not a price: "${event.price}" — cleared.`);
        event.price = 'TBD';
    }

    // ---------- Location / Time / Organizer ----------
    // Same pattern: any of these that has been mislabelled as a category
    // chip gets cleared, because category chips never belong in those
    // slots and clearing is safer than leaving a wrong value.
    if (event.location && looksLikeCategoryLabel(event.location)) {
        if (!event.rawSuspectLocation) event.rawSuspectLocation = event.location;
        warnings.push(`Location field looked like a category label, not a location: "${event.location}" — cleared.`);
        event.location = null;
    }
    if (event.time && looksLikeCategoryLabel(event.time)) {
        if (!event.rawSuspectTime) event.rawSuspectTime = event.time;
        warnings.push(`Time field looked like a category label, not a time: "${event.time}" — cleared.`);
        event.time = null;
    }
    if (event.organizer && looksLikeCategoryLabel(event.organizer)) {
        if (!event.rawSuspectOrganizer) event.rawSuspectOrganizer = event.organizer;
        warnings.push(`Organizer field looked like a category label, not an organizer name: "${event.organizer}" — cleared.`);
        event.organizer = null;
    }

    // ---------- Category ----------
    // A category field containing a date, price, or URL means the scraper's
    // selector hit the wrong element. Clear it so downstream category
    // classification falls back to keyword detection.
    if (event.category && looksLikeMisplacedNonCategoryValue(event.category)) {
        if (!event.rawSuspectCategory) event.rawSuspectCategory = event.category;
        warnings.push(`Category field looked like a date/price/URL, not a category: "${event.category}" — cleared.`);
        event.category = null;
    }

    // ---------- URLs ----------
    // Non-http(s) or unparseable URL means a JS-injection placeholder, a
    // data URI, or a scraper-target mistake. Clear so downstream never
    // crashes trying to fetch it.
    if (event.image && !isValidImageUrl(event.image)) {
        if (!event.rawSuspectImage) event.rawSuspectImage = event.image;
        warnings.push('Image field was not a usable image URL (placeholder or data URI) — cleared.');
        event.image = null;
    }
    if (event.registrationUrl && !isValidRegistrationUrl(event.registrationUrl)) {
        if (!event.rawSuspectRegistrationUrl) event.rawSuspectRegistrationUrl = event.registrationUrl;
        warnings.push(`Registration URL was not a well-formed http(s) URL: "${event.registrationUrl}" — cleared.`);
        event.registrationUrl = null;
    }
    if (event.url && !isValidRegistrationUrl(event.url)) {
        if (!event.rawSuspectUrl) event.rawSuspectUrl = event.url;
        warnings.push(`Event URL was not a well-formed http(s) URL: "${event.url}" — cleared.`);
        event.url = null;
    }

    // ---------- Merge + dedupe warnings ----------
    // This function re-runs every time an item is rendered / customized /
    // re-scraped, so identical warnings would pile up across re-runs.
    // A Set collapses exact-duplicate strings while still allowing
    // genuinely distinct warnings to coexist.
    if (warnings.length > 0) {
        const merged = (event.dataQualityWarnings || []).concat(warnings);
        event.dataQualityWarnings = Array.from(new Set(merged));
    }

    // ---------- Audit ----------
    auditLog(
        'sanitize_event_fields',
        warnings.length > 0
            ? `sanitizeEventFields() found ${warnings.length} warning(s) for "${event.title || 'untitled'}"`
            : `sanitizeEventFields() found nothing to clear for "${event.title || 'untitled'}"`,
        {
            id: event.id || null,
            title: event.title || null,
            source: event.source || null,
            warningsFound: warnings.length > 0,
            warnings,
            rawSuspectDate: event.rawSuspectDate || null,
            rawSuspectPrice: event.rawSuspectPrice || null,
            rawSuspectLocation: event.rawSuspectLocation || null,
            rawSuspectImage: event.rawSuspectImage || null,
            rawSuspectTime: event.rawSuspectTime || null,
            rawSuspectOrganizer: event.rawSuspectOrganizer || null,
            rawSuspectCategory: event.rawSuspectCategory || null,
            event
        }
    );

    return event;
}

module.exports = { sanitizeEventFields };
