// src/scrapers/scholarships.js
// Pure helpers shared by every scholarship-source extractor.
//
// buildScholarship() is the canonical assembly function — every
// scholarship extractor's job is to scrape fields and hand them to it.
// Centralizing here means a new source needs zero knowledge of the
// deadline-state machine or the dataQualityWarnings format.

const { DateTime } = require('luxon');
const { auditLog } = require('../core/auditLogger');
const { TARGET_TIMEZONE } = require('../config/constants');
const { sanitizeImageUrl, looksLikeCategoryChip } = require('./sanitize');
const { trimDescriptionToLastSentence, cleanDescriptionText } = require('./text');

// Wording that means "this scholarship doesn't have a hard deadline"
// rather than "we failed to find one". Treated completely differently
// from a missing/unparseable deadline: rolling scholarships never expire
// by date.
const ROLLING_DEADLINE_KEYWORDS = /\b(rolling|ongoing|open until filled|no deadline|always open|continuous(?:ly)? open|year[- ]round)\b/i;

// Sources whose title/description years are NOT a reliable stand-in for an
// application deadline — Erasmus Mundus is the case: its title/description
// years describe the funded CONSORTIUM PROJECT's duration (e.g. "2020 to
// 2026"), not when a student's application closes. Add future sources
// here if they have the same "years present but not deadline-related" issue.
const SOURCES_WITHOUT_DEADLINE_FALLBACK = new Set(['erasmusmundus']);

// Cutoff for Erasmus Mundus's client-side year pre-filter. See
// looksOutdatedByYear() below.
const ERASMUS_MUNDUS_MIN_YEAR = 2026;

// Deadline state machine. Resolves to one of four explicit statuses:
//   'parsed'               — real day+month(+year) found. Trustworthy.
//   'estimated-year-only'  — only a bare year found. Treated as Dec 31 of
//                            that year as a SOFT cutoff. Deliberately NOT
//                            flagged — displayed as "For Year: YYYY".
//   'rolling'              — wording implies no hard deadline. Never
//                            expires by date.
//   'unknown'              — nothing usable. NOT an error. Nothing shown,
//                            nothing blocked — scholarship is postable.
//
// Returns { deadlineParsed: 'yyyy-LL-dd' | null, deadlineStatus, warning }.
function parseScholarshipDeadline(rawText) {
    const text = (rawText || '').trim();
    if (!text) return { deadlineParsed: null, deadlineStatus: 'unknown', warning: null };

    if (ROLLING_DEADLINE_KEYWORDS.test(text)) {
        return { deadlineParsed: null, deadlineStatus: 'rolling', warning: null };
    }

    const nowNpt = DateTime.now().setZone(TARGET_TIMEZONE);

    const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
        const dt = DateTime.fromObject(
            { year: +isoMatch[1], month: +isoMatch[2], day: +isoMatch[3] },
            { zone: TARGET_TIMEZONE }
        );
        if (dt.isValid) return { deadlineParsed: dt.toFormat('yyyy-LL-dd'), deadlineStatus: 'parsed', warning: null };
    }

    const longForm =
        text.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/) ||
        text.match(/(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/);
    if (longForm) {
        const isMonthFirst = isNaN(parseInt(longForm[1], 10));
        const monthStr = isMonthFirst ? longForm[1] : longForm[2];
        const dayStr = isMonthFirst ? longForm[2] : longForm[1];
        const dt = DateTime.fromFormat(`${monthStr} ${dayStr} ${longForm[3]}`, 'MMMM d yyyy', { zone: TARGET_TIMEZONE });
        if (dt.isValid) return { deadlineParsed: dt.toFormat('yyyy-LL-dd'), deadlineStatus: 'parsed', warning: null };
    }

    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const shortMatch = text.match(/\b(\d{1,2})\s+(\w{3})\b(?:\D*(\d{4}))?/);
    if (shortMatch) {
        const day = parseInt(shortMatch[1], 10);
        const monthIndex = monthNames.indexOf(shortMatch[2].toLowerCase());
        if (monthIndex !== -1) {
            const year = shortMatch[3] ? parseInt(shortMatch[3], 10) : nowNpt.year;
            let dt = DateTime.fromObject({ year, month: monthIndex + 1, day }, { zone: TARGET_TIMEZONE });
            if (!shortMatch[3] && dt.isValid && (nowNpt.toMillis() - dt.toMillis()) > 60 * 24 * 60 * 60 * 1000) {
                dt = DateTime.fromObject({ year: year + 1, month: monthIndex + 1, day }, { zone: TARGET_TIMEZONE });
            }
            if (dt.isValid) return { deadlineParsed: dt.toFormat('yyyy-LL-dd'), deadlineStatus: 'parsed', warning: null };
        }
    }

    const yearMatch = text.match(/\b(20\d{2})\b/);
    if (yearMatch) {
        const year = parseInt(yearMatch[1], 10);
        const dt = DateTime.fromObject({ year, month: 12, day: 31 }, { zone: TARGET_TIMEZONE });
        if (dt.isValid) {
            return { deadlineParsed: dt.toFormat('yyyy-LL-dd'), deadlineStatus: 'estimated-year-only', warning: null };
        }
    }

    return { deadlineParsed: null, deadlineStatus: 'unknown', warning: null };
}

// Canonical scholarship assembly. Every extractor hands its scraped
// fields to this — the deadline fallback (title/description year scan for
// sources that allow it), category-chip cleanup, and the audit entry all
// happen here.
function buildScholarship({ id, title, description, provider, deadlineRaw, fundingType, fundingAmount, degreeLevel, fieldOfStudy, image, tags, source, url }) {
    const warnings = [];
    let { deadlineParsed, deadlineStatus, warning: deadlineWarning } = parseScholarshipDeadline(deadlineRaw);

    if (deadlineStatus === 'unknown' && !SOURCES_WITHOUT_DEADLINE_FALLBACK.has(source)) {
        for (const fallbackText of [title, description]) {
            if (!fallbackText) continue;
            const fb = parseScholarshipDeadline(fallbackText);
            if (fb.deadlineStatus !== 'unknown') {
                deadlineParsed = fb.deadlineParsed;
                deadlineStatus = fb.deadlineStatus;
                deadlineWarning = fb.warning;
                break;
            }
        }
    }

    if (deadlineWarning) warnings.push(deadlineWarning);

    let cleanProvider = provider || null;
    if (cleanProvider && looksLikeCategoryChip(cleanProvider)) {
        warnings.push(`Provider field looked like a tag/chip, not a name: "${cleanProvider}" — cleared.`);
        cleanProvider = null;
    }

    let cleanFundingType = fundingType || null;
    if (cleanFundingType && looksLikeCategoryChip(cleanFundingType)) {
        warnings.push(`Funding field looked like a tag/chip, not funding info: "${cleanFundingType}" — cleared.`);
        cleanFundingType = null;
    }

    if (!title || !title.trim()) {
        warnings.push('No title was found on the scraped page — flagged for manual review.');
    }

    const scholarship = {
        id: id || `scholarship-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        title: title || 'Untitled Scholarship',
        description: trimDescriptionToLastSentence(description, 1500),
        provider: cleanProvider,
        deadlineRaw: deadlineRaw || null,
        deadlineParsed,
        deadlineStatus,
        fundingType: cleanFundingType,
        fundingAmount: fundingAmount || null,
        degreeLevel: degreeLevel || null,
        fieldOfStudy: fieldOfStudy || null,
        image: sanitizeImageUrl(image),
        tags: Array.isArray(tags) ? tags : [],
        source: source || 'unknown',
        url,
        registrationUrl: url,
        dataQualityWarnings: warnings.length > 0 ? warnings : undefined
    };

    auditLog(
        'sanitize_scholarship',
        warnings.length > 0
            ? `buildScholarship() found ${warnings.length} warning(s) for "${scholarship.title}"`
            : `buildScholarship() found nothing to flag for "${scholarship.title}"`,
        { id: scholarship.id, title: scholarship.title, source: scholarship.source, deadlineStatus, warnings, scholarship }
    );

    return scholarship;
}

// Appends "Relevant link provided by the organization: <url>" while
// GUARANTEEING the combined string still fits 1500-char cap. The link's
// length is reserved FIRST and the description trimmed to whatever's
// left — trimDescriptionToLastSentence only shortens from the end, so
// appending after trimming would silently chop the link off.
function appendMoreInfoLink(description, url, maxLength = 1500) {
    const clean = cleanDescriptionText(description) || '';
    if (!url) return clean;
    const suffix = `\n\nRelevant link provided by the organization: ${url}`;
    const available = Math.max(0, maxLength - suffix.length);
    const trimmed = trimDescriptionToLastSentence(clean, available);
    return `${trimmed}${suffix}`;
}

// Erasmus Mundus year pre-filter. The site's own "Year of project
// selection" facet doesn't reach current cohorts, so this is a client-side
// guard. A card whose title/description mentions only years BEFORE
// ERASMUS_MUNDUS_MIN_YEAR is almost certainly a closed cohort — skip the
// detail-page visit entirely. A card with no year at all, or with at least
// one year >= cutoff, still gets visited.
function looksOutdatedByYear(text, minYear = ERASMUS_MUNDUS_MIN_YEAR) {
    if (!text) return false;
    const years = (text.match(/\b20\d{2}\b/g) || []).map((y) => parseInt(y, 10));
    if (years.length === 0) return false;
    return years.every((y) => y < minYear);
}

module.exports = {
    ROLLING_DEADLINE_KEYWORDS,
    SOURCES_WITHOUT_DEADLINE_FALLBACK,
    ERASMUS_MUNDUS_MIN_YEAR,
    parseScholarshipDeadline,
    buildScholarship,
    appendMoreInfoLink,
    looksOutdatedByYear
};
