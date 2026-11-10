// src/core/dateUtils.js
// All date parsing and comparison. Pure functions — no bot instance, no
// cache reads. Callers pass everything in explicitly so this module can be
// unit-tested in isolation and reused from scraper code (which has no bot
// instance to call into).
//
// Every "today" / "is this past" comparison is anchored to TARGET_TIMEZONE
// (Asia/Kathmandu), not server-local time. Running this on UTC infra
// without that anchor would silently shift every window by the offset.

const { DateTime } = require('luxon');
const { TARGET_TIMEZONE, YEAR_INFERENCE_PAST_THRESHOLD_MS } = require('../config/constants');

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Build a Date from (monthIndex, day) with a smart year inference:
// - if the resulting date is more than YEAR_INFERENCE_PAST_THRESHOLD_MS in
//   the past relative to "now", assume it means NEXT year (handles
//   scraping in Dec for a Jan event that hasn't happened yet)
// - if that inferred date is invalid (e.g. Feb 30), return null
function resolveYearAndBuild(monthIndex, day) {
    const nowNpt = DateTime.now().setZone(TARGET_TIMEZONE);
    const year = nowNpt.year;
    let candidate = DateTime.fromObject({ year, month: monthIndex + 1, day }, { zone: TARGET_TIMEZONE });
    if (candidate.isValid && (nowNpt.toMillis() - candidate.toMillis()) > YEAR_INFERENCE_PAST_THRESHOLD_MS) {
        candidate = DateTime.fromObject({ year: year + 1, month: monthIndex + 1, day }, { zone: TARGET_TIMEZONE });
    }
    return candidate.isValid ? candidate.toJSDate() : null;
}

// Parse an event-like object's date field into a JS Date, or null if the
// string is unparseable. Accepted formats, in evaluation order:
//   1. ISO date prefix:   2026-10-31...
//   2. Long form:         [Weekday, ]Month D, YYYY [at h:mm AM/PM] [GMT±H:MM]
//   3. Date range:        D Mon ... D Mon   (uses the SECOND/end date)
//   4. Single:            D Mon
//   5. Anything new Date() can handle
//
// Reads event.date first, falls back to event.startDate — both are present
// across the different scrapers' output shapes.
function parseEventDate(event) {
    if (!event) return null;
    const dateStr = event.date || event.startDate || '';
    if (!dateStr) return null;

    // 1. ISO date prefix — matches "2026-10-31" or "2026-10-31T18:00:00Z"
    const isoMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
        const parsed = DateTime.fromObject({
            year: parseInt(isoMatch[1], 10),
            month: parseInt(isoMatch[2], 10),
            day: parseInt(isoMatch[3], 10)
        }, { zone: TARGET_TIMEZONE });
        if (parsed.isValid) return parsed.toJSDate();
    }

    // 2. Long form — handles "Saturday, October 31, 2026 at 12:00 PM GMT+5:45"
    //    with every optional part being, well, optional. new Date() cannot
    //    parse this at all (chokes on "at" and on the colon inside GMT+5:45).
    const longFormMatch = dateStr.match(
        /([A-Za-z]+ \d{1,2}),?\s+(\d{4})(?:,?\s+at\s+(\d{1,2}:\d{2}\s*[AaPp][Mm]))?(?:\s*GMT\s*([+-]\d{1,2}:\d{2}))?/
    );
    if (longFormMatch) {
        const [, monthDay, year, timePart, offsetPart] = longFormMatch;
        let normalizedOffset = null;
        if (offsetPart) {
            const sign = offsetPart[0];
            const [oh, om] = offsetPart.slice(1).split(':');
            normalizedOffset = `${sign}${oh.padStart(2, '0')}${om}`;
        }
        const datePiece = `${monthDay} ${year}`;
        let dt;
        if (timePart && normalizedOffset) {
            dt = DateTime.fromFormat(
                `${datePiece} ${timePart.toUpperCase().replace(/\s+/g, ' ')} GMT${normalizedOffset}`,
                "MMMM d yyyy h:mm a 'GMT'ZZZ"
            );
        } else if (timePart) {
            dt = DateTime.fromFormat(
                `${datePiece} ${timePart.toUpperCase().replace(/\s+/g, ' ')}`,
                'MMMM d yyyy h:mm a',
                { zone: TARGET_TIMEZONE }
            );
        } else {
            dt = DateTime.fromFormat(datePiece, 'MMMM d yyyy', { zone: TARGET_TIMEZONE });
        }
        if (dt.isValid) return dt.toJSDate();
    }

    // 3. Date range — "5 Mar - 10 Mar" — end date wins for "is this past"
    const rangeMatch = dateStr.match(/\b(\d{1,2})\s+(\w{3})\b(?:.*?)\b(\d{1,2})\s+(\w{3})\b/);
    if (rangeMatch) {
        const endDay = parseInt(rangeMatch[3], 10);
        const endMonth = rangeMatch[4];
        const monthIndex = MONTH_NAMES.indexOf(endMonth.toLowerCase());
        if (monthIndex !== -1) {
            const built = resolveYearAndBuild(monthIndex, endDay);
            if (built) return built;
        }
    }

    // 4. Single "D Mon"
    const singleMatch = dateStr.match(/\b(\d{1,2})\s+(\w{3})\b/);
    if (singleMatch) {
        const day = parseInt(singleMatch[1], 10);
        const month = singleMatch[2];
        const monthIndex = MONTH_NAMES.indexOf(month.toLowerCase());
        if (monthIndex !== -1) {
            const built = resolveYearAndBuild(monthIndex, day);
            if (built) return built;
        }
    }

    // 5. Generic fallback
    const generic = new Date(dateStr);
    if (!isNaN(generic)) return generic;

    return null;
}

// Is the event's date strictly before the start of today (in target tz)?
//
// Per-type override:
//   Scholarship with rolling/unknown deadline: never expires by date.
//   Scholarship with no parsed deadline:        never expires by date
//                                               (caught by needs-attention
//                                               archival, not by date).
//   Scholarship with parsed deadline:           compare deadline date.
//
// Anything else (events and jobs) uses parseEventDate's result.
function isEventPast(event) {
    if (!event) return false;

    if (event.itemType === 'scholarship') {
        if (event.deadlineStatus === 'rolling' || event.deadlineStatus === 'unknown') return false;
        if (!event.deadlineParsed) return false;
        const deadlineDate = DateTime.fromFormat(event.deadlineParsed, 'yyyy-LL-dd', { zone: TARGET_TIMEZONE }).toJSDate();
        if (isNaN(deadlineDate)) return false;
        const todayStartNpt = DateTime.now().setZone(TARGET_TIMEZONE).startOf('day').toJSDate();
        return deadlineDate < todayStartNpt;
    }

    const dateObj = parseEventDate(event);
    if (!dateObj) return false;
    const todayStartNpt = DateTime.now().setZone(TARGET_TIMEZONE).startOf('day').toJSDate();
    return dateObj < todayStartNpt;
}

// Is the event less than minLeadDays away from starting? Scholarships skip
// this check entirely — a scholarship stays valid right up to its actual
// deadline, so "how far away is it" isn't a signal that it's already too
// late. Events closer than minLeadDays to their start are probably
// already closed for registration.
//
// Returns false when parse fails — that's the dataQualityWarnings gate's
// job (in core/sanitize), not this gate's.
function isEventTooSoon(event, minLeadDays) {
    if (!event) return false;
    if (event.itemType === 'scholarship') return false;
    const dateObj = parseEventDate(event);
    if (!dateObj) return false;
    const nowMs = DateTime.now().setZone(TARGET_TIMEZONE).toMillis();
    const msUntil = dateObj.getTime() - nowMs;
    return msUntil < (minLeadDays * 24 * 60 * 60 * 1000);
}

// Canonical yyyy-LL-dd date for dedup. Recomputed at call time — for
// year-less source strings this can drift by a year across very long
// windows; not fully closed off, inherited from parseEventDate's design.
function getCanonicalDateForDedup(event) {
    const parsed = parseEventDate(event);
    if (!parsed) return null;
    return DateTime.fromJSDate(parsed).setZone(TARGET_TIMEZONE).toFormat('yyyy-LL-dd');
}

// Sort comparator: ascending by parsed date; events with unparseable dates
// sink to the bottom; ties broken by id string.
function compareByEventDate(a, b) {
    const dateA = parseEventDate(a);
    const dateB = parseEventDate(b);
    if (!dateA && !dateB) return compareById(a, b);
    if (!dateA) return 1;
    if (!dateB) return -1;
    const diff = dateA - dateB;
    if (diff !== 0) return diff;
    return compareById(a, b);
}

function compareById(a, b) {
    const idA = String(a.id || '');
    const idB = String(b.id || '');
    if (idA < idB) return -1;
    if (idA > idB) return 1;
    return 0;
}

module.exports = {
    parseEventDate,
    isEventPast,
    isEventTooSoon,
    getCanonicalDateForDedup,
    compareByEventDate,
    compareById
};
