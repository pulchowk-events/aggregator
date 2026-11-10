// src/config/constants.js
// Every tuning knob, magic number, and word list the bot uses — grouped by
// what it controls so a forker can find and adjust the right value without
// grepping through behaviour code.
//
// Rule: this file must stay declarative. No side effects, no imports of
// runtime modules, no timers. Pure data + tiny helper lookups only.

// ---------- Global timing ----------
// All date math is anchored to Nepal time, not server-local time — if this
// ever runs on UTC infra, "is this today/soon" checks would silently shift.
const TARGET_TIMEZONE = 'Asia/Kathmandu';

// Missing-year dates falling this far into the past are inferred to mean
// "next year" (scraping Dec for a Jan event that hasn't happened yet).
const YEAR_INFERENCE_PAST_THRESHOLD_MS = 60 * 24 * 60 * 60 * 1000;

// ---------- Autopost: live-window + throttle ----------
// Live posts ping a role, so they must never go out late at night.
// Live autopost (tick + test->live promotion sweep) is capped to this
// window in Nepal time. Test autopost is exempt (no ping, meant for review).
const AUTOPOST_LIVE_WINDOW_START_HOUR = 6;   // 6 AM inclusive
const AUTOPOST_LIVE_WINDOW_END_HOUR = 22;    // 10 PM exclusive

// Throttle so "holding off, nighttime" doesn't spam the logs channel.
const AUTOPOST_NIGHT_BLOCK_LOG_THROTTLE_MS = 60 * 60 * 1000;

// At interval=0 ("back-to-back"), an empty tick would busy-loop. Real posts
// still fire instantly on the next tick; only the idle case is delayed.
const AUTOPOST_IDLE_RETRY_MS = 30 * 1000;
const AUTOPOST_IDLE_LOG_THROTTLE_MS = 5 * 60 * 1000;

// Missed-scrape Discord log throttle (console still logs every attempt).
const MISSED_SCRAPE_LOG_THROTTLE_MS = 30 * 60 * 1000;

// ---------- Dedup / post-race protection ----------
// 0.85 catches minor wording drift on the SAME date across sources. Fuzzy
// matching is a secondary signal only — never used standalone.
const FUZZY_TITLE_SIMILARITY_THRESHOLD = 0.85;

// Scholarships need a stricter bar (their titles share a lot of boilerplate
// across sources). This lives in scholarshipScraper.js too so that module
// stays self-contained; duplicated here as the canonical default.
const SCHOLARSHIP_FUZZY_TITLE_SIMILARITY_THRESHOLD = 0.93;

// A reservation's heartbeat (not original reservedAt) older than this is
// "possibly abandoned" and gets verified against Discord before being
// cleared. Measured from latest heartbeat, so a slow-but-alive send never
// reads as abandoned mid-flight.
const STALE_RESERVATION_MS = 90 * 1000;
const RECONCILIATION_MESSAGE_FETCH_LIMIT = 50;

// Every cache array caps at this many entries (oldest silently dropped).
const CACHE_CAP = 1000;

// Posted-marker retention (authoritative cross-process "was this posted").
const MARKER_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

// ---------- Message formatting ----------
// Custom-id separator for button/modal routing, e.g. `post_live:event_123`.
const CUSTOM_ID_SEPARATOR = ':';

// Discord hard-caps message content at 2000 chars. We leave a buffer so the
// truncation never lands mid-sentence right at the limit.
const DISCORD_CONTENT_LIMIT = 2000;
const SAFETY_BUFFER = 20;

// Tags rendered in the post body. Excess tags collapse into "(+N more)".
const MAX_TAGS_RENDERED = 8;
const MAX_TAG_LENGTH = 30;

// Appended to job descriptions. Currently disabled (returns '' effectively)
// — kept here so a deployment can turn it back on by editing one line.
const SAFETY_NOTE = "Always secure a written contract and verify the company's background before any work.";

// ---------- Source lists ----------
// Event sources currently wired. Any source here must have a matching
// file under src/scrapers/sources/events/ — the registry enforces this at
// startup (a missing file = a loud warning, not a silent skip).
const EVENT_SOURCES = ['khalti', 'katajaam', 'nepvents', 'kgarira'];
const JOB_SOURCES = ['sathijob', 'internsathi', 'merojob', 'kumarijob'];
const SCHOLARSHIP_SOURCES = ['scholarshipsads', 'erasmusmundus'];

// ---------- Category classification ----------
// Values that look like a category chip in a field that should hold real
// data (date, price, location...). Used by sanitize to spot mislabelled
// scrapes — see core/sanitize.js.
const SUSPECT_CATEGORY_WORDS = new Set([
    'music', 'sports', 'sport', 'gaming', 'business', 'hardware',
    'software', 'tech', 'technology', 'art', 'food', 'nightlife',
    'outdoors', 'education', 'cultural', 'general', 'miscellaneous'
]);

// Keyword dictionary used by determineCategory() when no fast-path tag hit.
// Order matters: earlier keys win ties. Add new categories here AND in
// src/config/env.js CHANNELS — both must contain the same set.
const CATEGORY_KEYWORDS = {
    sports: [
        'sports', 'sport', 'football', 'soccer', 'cricket', 'basketball',
        'volleyball', 'marathon', 'running', 'race', 'tournament', 'league',
        'futsal', 'badminton', 'tennis', 'athletics', 'gym', 'fitness',
        'cycling', 'swimming', 'trekking', 'hiking', 'chess tournament',
        'martial arts', 'boxing', 'wrestling', 'yoga', 'climbing'
    ],
    software: [
        'software', 'tech', 'technology', 'programming', 'coding',
        'developer', 'dev', 'hackathon', 'ai', 'artificial intelligence',
        'machine learning', 'ml', 'data science', 'web development',
        'app development', 'cybersecurity', 'blockchain', 'cloud',
        'devops', 'open source', 'github', 'algorithm',
        'software engineering', 'computer science', 'automation', 'python',
        'javascript', 'fellowship', 'bootcamp', 'ctf', 'llm',
        'safety research'
    ],
    hardware: [
        'hardware', 'electronics', 'circuit', 'embedded', 'iot', 'arduino',
        'raspberry pi', 'pcb', 'robotics', 'maker', 'makerspace',
        'fabrication', '3d printing', 'drone', 'mechatronics', 'sensors',
        'microcontroller', 'vlsi', 'chip design', 'semiconductor'
    ],
    gaming: [
        'gaming', 'esports', 'valorant', 'pubg', 'free fire', 'dota',
        'league of legends', 'fifa', 'counter-strike', 'cs2', 'lan party',
        'game jam', 'video game', 'console', 'playstation', 'xbox',
        'nintendo', 'mobile legends', 'streamer', 'gameplay', 'speedrun'
    ],
    music: [
        'music', 'concert', 'gig', 'band', 'singer', 'song', 'album', 'dj',
        'live music', 'open mic', 'jam session', 'orchestra', 'choir',
        'instrument', 'guitar', 'piano', 'rap', 'hip hop', 'rock band',
        'edm', 'music festival', 'karaoke', 'songwriting'
    ],
    business: [
        'business', 'startup', 'entrepreneur', 'entrepreneurship',
        'networking', 'pitch', 'investment', 'investor', 'venture capital',
        'marketing', 'finance', 'economics', 'leadership', 'career fair',
        'job fair', 'conference', 'summit', 'management', 'strategy',
        'branding', 'ecommerce', 'sales'
    ]
};

// ---------- Scrape cron default ----------
// Overridable at runtime via /settings set-schedule; this is the fallback
// used when nothing's been set. Kept here instead of env.js because it's a
// behavioural default, not a secret.
const DEFAULT_SCRAPE_CRON = '0 */6 * * *';   // every 6 hours

// ---------- Autopost sanity defaults ----------
// Both are overridable at runtime via cache.settings.<field>. These are the
// fallbacks used before any /settings command has ever run.
const DEFAULT_AUTOPOST_MIN_LEAD_DAYS = 3;
const DEFAULT_NEEDS_ATTENTION_EXPIRY_DAYS = 14;

// ---------- Source-failure alerts ----------
// A source-failure streak of consecutive non-'ok' verdicts (blocked /
// DOM drift / parse failure) has to hit this before pinging the alert
// channel. Singles and pairs are common (transient network hiccups,
// legitimately empty scrapes) — three in a row is a real problem.
const DEFAULT_SOURCE_ALERT_THRESHOLD = 3;

// Once a source is firing alerts, don't re-ping the same source more than
// once per this window. Keeps an extended outage from spamming the channel
// every scrape cycle. Console + audit log still record every occurrence.
const DEFAULT_SOURCE_ALERT_COOLDOWN_MINUTES = 60;

module.exports = {
    TARGET_TIMEZONE,
    YEAR_INFERENCE_PAST_THRESHOLD_MS,

    AUTOPOST_LIVE_WINDOW_START_HOUR,
    AUTOPOST_LIVE_WINDOW_END_HOUR,
    AUTOPOST_NIGHT_BLOCK_LOG_THROTTLE_MS,
    AUTOPOST_IDLE_RETRY_MS,
    AUTOPOST_IDLE_LOG_THROTTLE_MS,
    MISSED_SCRAPE_LOG_THROTTLE_MS,

    FUZZY_TITLE_SIMILARITY_THRESHOLD,
    SCHOLARSHIP_FUZZY_TITLE_SIMILARITY_THRESHOLD,
    STALE_RESERVATION_MS,
    RECONCILIATION_MESSAGE_FETCH_LIMIT,
    CACHE_CAP,
    MARKER_RETENTION_MS,

    CUSTOM_ID_SEPARATOR,
    DISCORD_CONTENT_LIMIT,
    SAFETY_BUFFER,
    MAX_TAGS_RENDERED,
    MAX_TAG_LENGTH,
    SAFETY_NOTE,

    EVENT_SOURCES,
    JOB_SOURCES,
    SCHOLARSHIP_SOURCES,

    SUSPECT_CATEGORY_WORDS,
    CATEGORY_KEYWORDS,

    DEFAULT_SCRAPE_CRON,
    DEFAULT_AUTOPOST_MIN_LEAD_DAYS,
    DEFAULT_NEEDS_ATTENTION_EXPIRY_DAYS,
    DEFAULT_SOURCE_ALERT_THRESHOLD,
    DEFAULT_SOURCE_ALERT_COOLDOWN_MINUTES
};
