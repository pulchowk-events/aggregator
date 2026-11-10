// src/core/cronParser.js
// Minimal 5-field cron -> "next run" / "previous run" resolver.
//
// node-cron fires the actual schedule but doesn't expose when it will fire
// next — this fills that gap so /status can show a live "next scrape at
// <t:...>" and the missed-scrape catch-up check can detect "the cron
// should have fired since the last completed scrape, but didn't" (laptop
// was asleep).
//
// Scope: handles the standard 5-field syntax this bot actually uses —
// *, */N, N-M, N-M/S, and comma-separated lists. It is NOT a general
// cron-parser replacement (no seconds field, no @daily/@hourly aliases,
// no L/W/# — none of which the bot uses).
//
// Resolution is a minute-by-minute scan, capped at ~1 year out. That's
// fine for the expressions we schedule (minutely / hourly / every-N /
// daily); it would be too slow for a "run once a decade" expression, but
// nothing here is ever that sparse.

const FIELD_RANGES = [
    /* minute */ { min: 0, max: 59 },
    /* hour   */ { min: 0, max: 23 },
    /* dom    */ { min: 1, max: 31 },
    /* month  */ { min: 1, max: 12 },
    /* dow    */ { min: 0, max: 6 }
];

// Expand one cron field ("*", "*/5", "1-5", "1,3,5", "1-5/2", "7") into a
// Set of integers. Unknown tokens are silently skipped; a fully-bad field
// yields an empty Set, which the caller treats as "no match ever".
function expandCronField(field, min, max) {
    const values = new Set();
    for (const part of field.split(',')) {
        let m;
        if (part === '*') {
            for (let i = min; i <= max; i++) values.add(i);
        } else if ((m = part.match(/^\*\/(\d+)$/))) {
            const step = parseInt(m[1], 10);
            if (step > 0) {
                for (let i = min; i <= max; i += step) values.add(i);
            }
        } else if ((m = part.match(/^(\d+)-(\d+)\/(\d+)$/))) {
            const start = parseInt(m[1], 10);
            const end = parseInt(m[2], 10);
            const step = parseInt(m[3], 10);
            if (step > 0) {
                for (let i = start; i <= end; i += step) values.add(i);
            }
        } else if ((m = part.match(/^(\d+)-(\d+)$/))) {
            const start = parseInt(m[1], 10);
            const end = parseInt(m[2], 10);
            for (let i = start; i <= end; i++) values.add(i);
        } else if (/^\d+$/.test(part)) {
            values.add(parseInt(part, 10));
        }
    }
    return values;
}

// Parsed representation of a cron expression, reused by both the next-run
// and previous-run scanners. Returns null if the expression doesn't have
// exactly 5 fields.
function parseCron(cronExpr) {
    const parts = (cronExpr || '').trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [minF, hourF, domF, monF, dowF] = parts;
    const [minRange, hourRange, domRange, monRange, dowRange] = FIELD_RANGES;
    return {
        minutes: expandCronField(minF, minRange.min, minRange.max),
        hours:   expandCronField(hourF, hourRange.min, hourRange.max),
        doms:    expandCronField(domF, domRange.min, domRange.max),
        months:  expandCronField(monF, monRange.min, monRange.max),
        dows:    expandCronField(dowF, dowRange.min, dowRange.max),
        domWild: domF === '*',
        dowWild: dowF === '*'
    };
}

// Standard cron day-matching semantics: if EITHER day field is wildcarded,
// use the OTHER one; if NEITHER is wildcarded, match if EITHER field
// matches. (This is the classic "OR of DOM and DOW unless one is *" rule.)
function dayMatches(parsed, dom, dow) {
    const domMatch = parsed.domWild || parsed.doms.has(dom);
    const dowMatch = parsed.dowWild || parsed.dows.has(dow);
    if (parsed.domWild && parsed.dowWild) return true;
    if (parsed.domWild) return dowMatch;
    if (parsed.dowWild) return domMatch;
    return domMatch || dowMatch;
}

function matches(parsed, date) {
    return parsed.minutes.has(date.getMinutes())
        && parsed.hours.has(date.getHours())
        && parsed.months.has(date.getMonth() + 1)
        && dayMatches(parsed, date.getDate(), date.getDay());
}

const MAX_SCAN_MINUTES = 60 * 24 * 366;

// Most recent scheduled run <= fromDate (inclusive of the current minute).
// Used by getLastScheduledScrapeTime() to detect missed cycles.
function getPreviousCronRun(cronExpr, fromDate = new Date()) {
    const parsed = parseCron(cronExpr);
    if (!parsed) return null;
    let candidate = new Date(fromDate.getTime());
    candidate.setSeconds(0, 0);
    for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
        if (matches(parsed, candidate)) return candidate;
        candidate = new Date(candidate.getTime() - 60000);
    }
    return null;
}

// Next scheduled run strictly after fromDate (the current minute is
// skipped even if it matches — avoids returning a run that's already
// firing right now).
function getNextCronRun(cronExpr, fromDate = new Date()) {
    const parsed = parseCron(cronExpr);
    if (!parsed) return null;
    let candidate = new Date(fromDate.getTime());
    candidate.setSeconds(0, 0);
    candidate = new Date(candidate.getTime() + 60000);
    for (let i = 0; i < MAX_SCAN_MINUTES; i++) {
        if (matches(parsed, candidate)) return candidate;
        candidate = new Date(candidate.getTime() + 60000);
    }
    return null;
}

module.exports = {
    getNextCronRun,
    getPreviousCronRun
};
