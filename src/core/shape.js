// src/core/shape.js
// Normalize job/scholarship records onto the same field names the event
// pipeline already uses. That's the whole point of the abstraction: dedup,
// categorisation, /pending rendering, and autopost were all written for
// events and don't need to grow item-type-specific branches — they just
// need the shape to match. Each item keeps its original fields on top of
// the mapped ones, so item-type-specific renderers (formatJobMessage,
// formatScholarshipMessage) can still read every raw field.
//
// Field mappings (this is the contract; do not change without updating the
// corresponding formatter and any test):
//
//   job                              scholarship
//   -----------------------------    ---------------------------------
//   date   <- applicationEndsRaw      date   <- deadlineParsed || deadlineRaw
//   image  <- companyLogoUrl          image  <- scholarship.image
//   price  <- salary                  price  <- fundingAmount || fundingType
//   tags   <- skills                  tags   <- scholarship.tags
//   organizer <- company              organizer <- provider
//
// Scholarship-specific extra mappings:
//   deadlineDisplay is computed from deadlineStatus + deadlineRaw/Parsed.
//   'rolling'             -> "Rolling / Ongoing"
//   'parsed'              -> cleaned raw text
//   'estimated-year-only' -> just the year
//   'unknown'             -> null (nothing shown)
//
// Notes:
//   * date <- deadlineParsed (ISO 'yyyy-LL-dd') is what feeds
//     parseEventDate/dedup. The DISPLAY string lives in deadlineDisplay,
//     not `date`, so the raw phrase never accidentally enters dedup.
//   * image is set but NOT required for scholarships — see hasValidImage
//     override in the posting layer.

const { cleanScholarshipDeadlineText } = require('./deadlineText');

function normalizeJobToEventShape(job) {
    return {
        ...job,
        itemType: 'job',
        date: job.applicationEndsRaw || null,
        image: job.companyLogoUrl || null,
        price: job.salary || null,
        tags: job.skills || [],
        category: 'jobs',
        organizer: job.company || null
    };
}

function normalizeScholarshipToEventShape(scholarship) {
    let deadlineDisplay = null;
    if (scholarship.deadlineStatus === 'rolling') {
        deadlineDisplay = 'Rolling / Ongoing';
    } else if (scholarship.deadlineStatus === 'parsed') {
        deadlineDisplay = cleanScholarshipDeadlineText(scholarship.deadlineRaw || scholarship.deadlineParsed);
    } else if (scholarship.deadlineStatus === 'estimated-year-only') {
        deadlineDisplay = scholarship.deadlineParsed ? scholarship.deadlineParsed.slice(0, 4) : null;
    }
    // 'unknown' -> stays null, nothing shown, nothing blocked

    return {
        ...scholarship,
        itemType: 'scholarship',
        date: scholarship.deadlineParsed || scholarship.deadlineRaw || null,
        deadlineDisplay,
        image: scholarship.image || null,
        price: scholarship.fundingAmount || scholarship.fundingType || null,
        tags: scholarship.tags || [],
        category: 'scholarships',
        organizer: scholarship.provider || null
    };
}

module.exports = {
    normalizeJobToEventShape,
    normalizeScholarshipToEventShape
};
