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
    isValidRegistrationUrl,
    applyMailtoFallback,
    stripLogoSuffix
} = require('./normalize');

// Warnings are collected rather than thrown so a single bad field never
// aborts the whole item. The return contract is: always return `item`,
// always add any warnings to `item.dataQualityWarnings` (deduped), always
// audit the pass.
// Jobs with rolling/open-ended dates are legitimate, not a data-quality problem.
function isOpenEndedJobDate(event) {
    return !!event && event.itemType === 'job' &&
        /^\s*(open\s+until\s+filled|until\s+filled|rolling|ongoing|always\s+open|open[\s-]?ended|asap|immediate(ly)?)\s*\.?\s*$/i.test(String(event.date || ''));
}

// ---------------------------------------------------------------------------
// Session 2: concatenated-text cleanup + description quality
// ---------------------------------------------------------------------------

// Scrapers sometimes glue card metadata onto the previous word:
// "SeniorVacancy: 1View Details". Only these explicit patterns are touched. A blanket
// lower-to-upper split would corrupt JavaScript, OpenAI, LangChain, LlamaIndex, iOS,
// DevOps and eSewa.
const GLUED_LABEL_RE = /([a-z0-9])(Vacanc(?:y|ies)|Openings?|Location|Salary|Experience|Deadline|Posted|Apply By|Job Type|Employment Type)(\s*:)/g;
const CTA_PHRASES = 'View Details?|Apply Now|Apply Here|Read More|Learn More|Know More|See Details|View Job|View More';
const GLUED_CTA_RE = new RegExp('([a-z0-9.,;:!?)])(' + CTA_PHRASES + ')\\b', 'g');
const TRAILING_CTA_RE = new RegExp('\\s*(?:' + CTA_PHRASES + ')\\s*$');

// opts.collapseSpaces   : NBSP -> space, runs of spaces/tabs -> one space, trim (short fields)
// opts.stripTrailingCta : drop a trailing "View Details" / "Apply Now" etc. (titles)
// Idempotent; returns the input unchanged when no pattern matches.
function cleanupConcatenatedText(value, opts) {
    if (typeof value !== 'string' || !value) return value;
    const o = opts || {};
    let t = value.replace(GLUED_LABEL_RE, '$1 $2$3');
    t = t.replace(GLUED_CTA_RE, '$1 $2');
    if (o.collapseSpaces) t = t.replace(/\u00A0/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    if (o.stripTrailingCta) {
        for (;;) {
            const next = t.replace(TRAILING_CTA_RE, '');
            if (next === t) break;
            t = next.trim();
        }
        if (!t) return value;
    }
    return t;
}

// Description quality: 0-100, higher is better. Below DESC_QUALITY_MIN the description is
// treated as scraped footer/nav text and nullified (no data-quality warning: formatting.js
// skips an empty description, so an otherwise good job is not blocked).
// Long, prose-like text is always kept, even if a footer is attached to it.
const DESC_QUALITY_MIN = 50;
const FOOTER_STRONG_RES = [
    /\u00A9/,
    /\bcopyright\b/i,
    /\ball rights reserved\b/i,
    /\bprivacy policy\b/i,
    /\bterms (?:of (?:service|use)|(?:&|and) conditions)\b/i,
    /\bcookies? policy\b/i,
    /\bfollow us\b/i,
    /\bsubscribe (?:to )?(?:our )?newsletter\b/i,
    /\bstart your project\b/i,
    /\brequest a (?:quote|demo)\b/i
];
const NAV_LINE_WORDS = new Set([
    'home', 'about', 'about us', 'services', 'our services', 'contact', 'contact us', 'careers',
    'career', 'blog', 'portfolio', 'case studies', 'products', 'solutions', 'pricing', 'faq',
    'login', 'log in', 'sign in', 'sign up', 'sitemap', 'privacy policy', 'terms'
]);
const PHONE_LINE_RE = /^(?:(?:tel|phone|call|mobile|mob|fax|contact)[^\w+(]*)?[+(]?\d[\d\s().\-]{6,}$/i;
const EMAIL_LINE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function calculateDescriptionQuality(text) {
    if (typeof text !== 'string') return { score: 0, reasons: ['not_a_string'] };
    const norm = text.replace(/\r\n?/g, '\n').trim();
    if (!norm) return { score: 0, reasons: ['empty'] };

    const lines = norm.split('\n').map((l) => l.trim()).filter(Boolean);
    const lineChars = lines.reduce((n, l) => n + l.length, 0);
    const longChars = lines.reduce((n, l) => n + (l.length >= 60 ? l.length : 0), 0);
    const sentences = (norm.match(/[.!?](?:\s|$)/g) || []).length;

    // Long-description guard: never nullify long prose.
    if (norm.length >= 500 && (longChars / lineChars >= 0.5 || sentences >= 4)) {
        return { score: 100, reasons: ['long_prose'] };
    }

    let penalty = 0;
    const reasons = [];

    if (lines.length >= 3) {
        const shortCount = lines.filter((l) => l.length < 30).length;
        const ratio = shortCount / lines.length;
        if (ratio > 0.5) {
            penalty += Math.round((ratio - 0.5) * 2 * 30);
            reasons.push('short_lines:' + shortCount + '/' + lines.length);
        }
    }

    let strong = 0;
    for (const re of FOOTER_STRONG_RES) if (re.test(norm)) strong++;
    if (strong > 0) {
        penalty += Math.min(60, strong * 30);
        reasons.push('footer_keywords:' + strong);
    }

    let nav = 0;
    let contact = 0;
    for (const l of lines) {
        const key = l.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
        if (NAV_LINE_WORDS.has(key)) nav++;
        if (PHONE_LINE_RE.test(l) || EMAIL_LINE_RE.test(l)) contact++;
    }
    if (nav > 0) { penalty += Math.min(30, nav * 10); reasons.push('nav_lines:' + nav); }
    if (contact > 0) { penalty += Math.min(30, contact * 15); reasons.push('contact_lines:' + contact); }

    if (lines.length >= 2 && norm.length < 200 && sentences === 0) {
        penalty += 10;
        reasons.push('no_sentences');
    }

    return { score: Math.max(0, 100 - penalty), reasons };
}

function sanitizeEventFields(event) {
    if (!event) return event;
    const warnings = [];

    // ---------- Company / organizer logo-alt suffix ----------
    // DQ-3: "eSewa - Logo" comes from an <img alt>. Strip it here too, so items that never
    // passed the scraper-side sanitizer (or were stored earlier) are cleaned on every pass.
    if (typeof event.company === 'string') {
        const c = stripLogoSuffix(event.company);
        if (c !== event.company) event.company = c;
    }
    if (typeof event.organizer === 'string') {
        const o = stripLogoSuffix(event.organizer);
        if (o !== event.organizer) event.organizer = o;
    }

    // ---------- Concatenated text (Session 2) ----------
    // "SeniorVacancy: 1View Details" -> "Senior Vacancy: 1". Explicit patterns only; silent
    // like the logo-suffix strip. Title edits keep the original in rawSuspectTitle.
    let descriptionQuality = null;
    if (typeof event.title === 'string') {
        const t = cleanupConcatenatedText(event.title, { stripTrailingCta: true });
        if (t !== event.title) {
            if (!event.rawSuspectTitle) event.rawSuspectTitle = event.title;
            event.title = t;
        }
    }
    for (const f of ['company', 'organizer', 'location']) {
        if (typeof event[f] === 'string') {
            const c = cleanupConcatenatedText(event[f], { collapseSpaces: true });
            if (c !== event[f]) event[f] = c;
        }
    }
    if (typeof event.description === 'string') {
        const d = cleanupConcatenatedText(event.description, {});
        if (d !== event.description) event.description = d;
    }

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
        if (!isOpenEndedJobDate(event)) warnings.push(`Date field could not be parsed into a usable date: "${event.date}" — flagged for manual review, not cleared.`);
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

    // ---------- Description quality (Session 2) ----------
    // Footer/nav text scraped as a description is nullified WITHOUT a data-quality warning
    // (an empty description never blocks a post). Manual items are never scored, so Customize
    // and the dashboard cannot have a human-written description wiped.
    if (event.source !== 'manual' && typeof event.description === 'string' && event.description.trim()) {
        const q = calculateDescriptionQuality(event.description);
        if (q.score < DESC_QUALITY_MIN) {
            if (!event.rawSuspectDescription) event.rawSuspectDescription = event.description;
            descriptionQuality = { score: q.score, reasons: q.reasons, cleared: true };
            event.description = null;
        }
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
    // DQ-2: mailto: apply links fall back to the source page and keep the address in applyEmail
    // (no warning). Runs before the generic check below; other non-http schemes still clear+warn.
    applyMailtoFallback(event);
    // Unwrap login-redirect wrappers (kumarijob /jobseeker?next=<real url>). The original is kept in
    // rawDedupUrl so the dedup key keeps seeing what it saw before (see posting/dedup.js).
    {
        const { unwrapRedirectUrl } = require('./normalize');
        const dedupOriginal = event.registrationUrl || event.url || null;
        let unwrapped = false;
        for (const field of ['registrationUrl', 'url']) {
            const next = unwrapRedirectUrl(event[field]);
            if (typeof next === 'string' && next !== event[field]) { event[field] = next; unwrapped = true; }
        }
        if (unwrapped && !event.rawDedupUrl && dedupOriginal) event.rawDedupUrl = dedupOriginal;
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
            rawSuspectDescription: event.rawSuspectDescription || null,
            descriptionQuality,
            event
        }
    );

    return event;
}

module.exports = { sanitizeEventFields, calculateDescriptionQuality, cleanupConcatenatedText, DESC_QUALITY_MIN };
