// src/scrapers/jobs.js
// Pure helpers shared by every job-source extractor.
//
// What lives here: parsers and classifiers that operate on already-
// extracted strings (dates, image URLs, badge text). These are universal
// across job sources — the same "August 31, 2026" is parsed the same way
// whether it came from SathiJob or InternSathi.
//
// What does NOT live here: DOM extraction. That's per-source and lives
// in the gitignored extractors/jobs/<name>.js.

const { auditLog } = require('../core/auditLogger');
const { isValidRegistrationUrl } = require('../core/normalize');
const { sanitizeImageUrl } = require('./sanitize');

// Known employment-type suffixes. Used to split SathiJob/InternSathi's
// concatenated "<location><employment type>" text (single <p> with an
// icon and no separator between the two pieces of text).
const EMPLOYMENT_TYPE_SUFFIXES = [
    'Full Time', 'Part Time', 'Internship',
    'Contract', 'Freelance', 'Temporary', 'Remote'
];

// KumariJob badge classification — the site's badges are free-text with no
// stable label ("Junior Level", "Full Time", "2 + years") in no guaranteed
// order, so we sort by content instead of position.
const KUMARIJOB_LEVEL_PATTERN = /\blevel\b/i;
const KUMARIJOB_EXPERIENCE_PATTERN = /year/i;
const KUMARIJOB_EMPLOYMENT_TYPE_WORDS = EMPLOYMENT_TYPE_SUFFIXES.slice();

// Best-effort "August 31, 2026" -> Date. Used by SathiJob and InternSathi
// (same assumption — deadline shown as absolute date). Returns null on
// unparseable input so callers can store null rather than a wrong date.
function parseApplicationEndDate(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = raw.trim();
    if (!cleaned) return null;
    const parsed = new Date(cleaned);
    return isNaN(parsed) ? null : parsed;
}

// "15 days from now" / "2 weeks and 1 day from now" -> absolute Date,
// anchored to `fromDate` (scrape time by default). Sums every
// "<n> <unit>" chunk it finds. Month/year approximated as 30/365 days —
// no MeroJob posting seen so far exceeds a 30-day window, so this hasn't
// mattered yet.
function parseRelativeToDate(text, fromDate = new Date()) {
    if (!text || typeof text !== 'string') return null;
    const lower = text.toLowerCase();
    if (/\btoday\b/.test(lower) && !/\d/.test(lower)) return new Date(fromDate.getTime());
    const unitMs = {
        year: 365 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        day: 24 * 60 * 60 * 1000,
        hour: 60 * 60 * 1000
    };
    let totalMs = 0;
    let found = false;
    const re = /(\d+)\s*(year|month|week|day|hour)s?/gi;
    let m;
    while ((m = re.exec(lower)) !== null) {
        found = true;
        totalMs += parseInt(m[1], 10) * (unitMs[m[2].toLowerCase()] || 0);
    }
    if (!found) return null;
    return new Date(fromDate.getTime() + totalMs);
}

// Decode the real image URL out of Next.js's /_next/image?url=... proxy.
// MeroJob serves listing card logos through it; the decoded URL (usually
// on api.merojob.com) is more stable to hotlink than merojob.com's own
// resizing proxy.
function extractRealImageUrl(rawSrc, baseUrl) {
    if (!rawSrc || typeof rawSrc !== 'string') return null;
    try {
        const isAbsolute = /^https?:\/\//i.test(rawSrc);
        const full = isAbsolute ? rawSrc : `${baseUrl}${rawSrc}`;
        const parsed = new URL(full);
        if (parsed.pathname === '/_next/image' && parsed.searchParams.has('url')) {
            return decodeURIComponent(parsed.searchParams.get('url'));
        }
        return full;
    } catch (e) {
        return null;
    }
}

// "Aug 09, 2026 (6 days left)" -> { cleaned: "Aug 09, 2026", date: Date }.
// Unlike MeroJob, KumariJob prints an absolute expiry date directly. The
// "(N days left)" is just a bonus cross-check, not the sole signal.
function parseKumariExpiryDate(raw) {
    if (!raw || typeof raw !== 'string') return { cleaned: null, date: null };
    const cleaned = raw.replace(/\(.*?\)/g, '').trim();
    if (!cleaned) return { cleaned: null, date: null };
    const parsed = new Date(cleaned);
    return { cleaned, date: isNaN(parsed) ? null : parsed };
}

// Sort a KumariJob job-card-time badge by content (not position).
// Returns { field, value } or null for unrecognized badges.
function classifyKumariJobBadge(text) {
    if (!text) return null;
    if (KUMARIJOB_LEVEL_PATTERN.test(text)) return { field: 'level', value: text };
    if (KUMARIJOB_EXPERIENCE_PATTERN.test(text)) return { field: 'experience', value: text };
    if (KUMARIJOB_EMPLOYMENT_TYPE_WORDS.some((w) => text.toLowerCase().includes(w.toLowerCase()))) {
        return { field: 'employmentType', value: text };
    }
    return null;
}

// Job-specific sanitize pass — matches the original jobFetcher.js
// sanitizeJob(). Catches fields the scraper mislabeled that the generic
// sanitizeScrapedEvent() does NOT catch:
//   - empty title (job-specific fallback: 'Untitled Job')
//   - non-http companyLogoUrl
//   - attendanceMode that looks like a place name (indicates the stats
//     grid label/value pairing broke on this listing)
//
// Mutates `job` and appends to job.dataQualityWarnings. Does NOT call
// auditLog itself — sanitizeScrapedEvent() will, once the orchestrator
// runs it.
function sanitizeJobFields(job) {
    if (!job) return job;
    const warnings = [];

    if (!job.title || !job.title.trim()) {
        warnings.push('Title was empty or missing.');
        job.title = job.title || 'Untitled Job';
    }

    if (job.registrationUrl && !isValidRegistrationUrl(job.registrationUrl)) {
        warnings.push(`Registration/apply URL was not a well-formed http(s) URL: "${job.registrationUrl}" — cleared.`);
        job.rawSuspectRegistrationUrl = job.registrationUrl;
        job.registrationUrl = null;
    }

    if (job.companyLogoUrl) {
        const cleanLogo = sanitizeImageUrl(job.companyLogoUrl);
        if (!cleanLogo) {
            warnings.push('Company logo URL was not a usable image URL (placeholder or data URI) — cleared.');
        }
        job.companyLogoUrl = cleanLogo;
    }

    if (job.attendanceMode && /nepal|kathmandu|lalitpur|bhaktapur|pokhara/i.test(job.attendanceMode)) {
        warnings.push(`attendanceMode ("${job.attendanceMode}") looks like a place name, not a work mode — the stats grid may have mismatched label/value pairs on this listing.`);
    }

    if (warnings.length > 0) {
        job.dataQualityWarnings = Array.from(new Set((job.dataQualityWarnings || []).concat(warnings)));
    }

    auditLog(
        'sanitize_job',
        warnings.length > 0
            ? `sanitizeJobFields() found ${warnings.length} warning(s) for "${job.title || 'untitled'}"`
            : `sanitizeJobFields() found nothing to flag for "${job.title || 'untitled'}"`,
        { title: job.title || null, source: job.source || null, warnings, job }
    );

    return job;
}

module.exports = {
    EMPLOYMENT_TYPE_SUFFIXES,
    KUMARIJOB_LEVEL_PATTERN,
    KUMARIJOB_EXPERIENCE_PATTERN,
    KUMARIJOB_EMPLOYMENT_TYPE_WORDS,
    parseApplicationEndDate,
    parseRelativeToDate,
    extractRealImageUrl,
    parseKumariExpiryDate,
    classifyKumariJobBadge,
    sanitizeJobFields
};
