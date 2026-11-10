// src/core/deadlineText.js
// Extracts a clean, human-readable deadline from a scraped raw string.
//
// The scrapers pull `deadlineRaw` from fields like ScholarshipsAds' "deadline
// body text" — which on real pages reads like:
//   "Application Deadline: 15 September 2026 | Also see: Application process"
// We want "15 September 2026" out of that, without re-deriving the date logic
// that parseScholarshipDeadline already does. This module is display-only:
// it makes the string look right for a human, it does NOT decide whether
// the deadline is past, rolling, or unknown — that's parseScholarshipDeadline.

const DEADLINE_LABEL_RE = /\b(?:application\s+)?deadline\s*:?\s*/i;

// Matches:
//   "15 September 2026", "15 September 2026 at 11:59 PM", "... India time"
//   "September 15, 2026", "Sep 15, 2026"
// Deliberately lenient; anything genuinely unparseable falls through to the
// raw-text-return path below.
const DATE_PATTERN = /\b\d{1,2}\s+[A-Za-z]+\.?\s+\d{4}(?:\s+at\s+\d{1,2}:\d{2}\s*(?:[AaPp][Mm])?(?:\s+[A-Za-z]+\s+time)?)?\b|\b[A-Za-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}(?:\s+at\s+\d{1,2}:\d{2}\s*(?:[AaPp][Mm])?(?:\s+[A-Za-z]+\s+time)?)?\b/;

function cleanScholarshipDeadlineText(raw) {
    if (!raw || typeof raw !== 'string') return raw;

    // Scrapers often glue fragments together with " | " — split and inspect
    // each fragment individually before falling back.
    const parts = raw.split('|').map((p) => p.trim()).filter(Boolean);

    // 1. Prefer a fragment that explicitly labels itself as the deadline.
    for (const part of parts) {
        if (DEADLINE_LABEL_RE.test(part)) {
            const stripped = part.replace(DEADLINE_LABEL_RE, '').trim();
            const dateMatch = stripped.match(DATE_PATTERN);
            return dateMatch ? dateMatch[0] : stripped;
        }
    }

    // 2. Fall back to the first fragment that merely CONTAINS a date.
    for (const part of parts) {
        const dateMatch = part.match(DATE_PATTERN);
        if (dateMatch) return dateMatch[0];
    }

    // 3. Nothing recognizable — don't silently drop it, just cap the length.
    return raw.length > 150 ? raw.slice(0, 150).trim() + '…' : raw.trim();
}

module.exports = { cleanScholarshipDeadlineText, DATE_PATTERN };
