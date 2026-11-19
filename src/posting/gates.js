// src/posting/gates.js
// Four small predicates every post passes through before it can go live.
// Each is pure-ish: reads from cache.settings only, never mutates.
//
//   hasValidImage(bot, item)      — can this go to a live channel?
//                                   Scholarships are exempt: their image is
//                                   optional by product decision, so this
//                                   always returns true for them.
//
//   shouldPingForEvent(bot, ev)   — should this post include a role ping?
//                                   Three conditions must all pass:
//                                     (a) global ping enabled
//                                     (b) category ping not explicitly off
//                                     (c) if ping keywords are set, at least
//                                         one must match title/desc/tags
//
//   hasDataQualityWarnings(event) — does the item carry unresolved
//                                   sanitize warnings? If yes, it's blocked
//                                   from live (but still postable to test,
//                                   and still force-postable manually).
//
//   hasJunkTitle(bot, event)      - is the title scraper junk (placeholder, empty-state
//                                   banner, nav heading, listing page)? LIVE only, no force
//                                   bypass. See the junk-title gate block below.

const { isValidImageUrl } = require('../core/normalize');

function hasValidImage(bot, event) {
    if (!event) return false;
    // Product decision: images are optional for scholarships.
    // Everything in this file that gates on has-valid-image relies on
    // THIS check, so overriding here cascades everywhere — autopost's
    // has-image filter, postEventToCategory's LIVE gate, /pending's
    // "Post to Live" button disabled state, and the needs-attention
    // archival sweep all see the same answer.
    if (event.itemType === 'scholarship') return true;
    return isValidImageUrl(event.image);
}

function shouldPingForEvent(bot, event) {
    if (!event) return false;
    if (bot.cache.settings.pingEnabled === false) return false;

    const categoryKey = event._pingCategoryKey; // set by the caller when known
    if (categoryKey) {
        const catEnabled = bot.cache.settings.categoryPingEnabled || {};
        if (catEnabled[categoryKey] === false) return false;
    }

    const keywords = bot.cache.settings.pingKeywords || [];
    if (keywords.length === 0) return true;

    const haystack = [event.title, event.description, (event.tags || []).join(' ')]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return keywords.some((kw) => haystack.includes(String(kw).toLowerCase()));
}

function hasDataQualityWarnings(event) {
    return Array.isArray(event && event.dataQualityWarnings) && event.dataQualityWarnings.length > 0;
}

// ---------------------------------------------------------------------------
// Junk-title gate
//
//   getJunkTitleReason(event, settings) -> null | rule code
//   hasJunkTitle(bot, event)            -> boolean
//
// Is this item's title scraper junk (placeholder, empty-state banner, nav
// heading, listing page) rather than the name of a real item? Enforced at
// the post.js LIVE branch only: a hit refuses mode=main with reason
// 'junk_title' and is audited under the 'junk_title' category with the rule
// code below. Test posts stay ungated so junk stays inspectable.
//
// Stateless: judged on the CURRENT title, so fixing the title (Customize)
// clears it. No force bypass (same as the image gate). Escape hatches:
//   settings.junkTitle = { enabled: true, allow: [], extraPatterns: [] }
//   allow          exact titles (case-insensitive) that are never junk
//   extraPatterns  regex sources (strings) that also count as junk
// All keys optional; defaults apply when the object is missing.
//
// Rule codes, first match wins:
//   empty_title     nothing left after normalization
//   too_short       fewer than 3 letters/digits
//   no_letters      no letter at all (digits/punctuation only)
//   placeholder     whole title is "Untitled [Job|Internship|Event|...]", null, tbd
//   empty_state     "Sorry, there are no ..." / "No open positions" banners
//   nav_heading     whole title is a site-nav word (Home, About Us, Careers)
//   allcaps_single  ONE ALLCAPS word, jobs only (CONTENT, MANAGEMENT, FINANCE)
//   nav_suffix      title ENDS in page/blog/"internship projects"/"travel opportunities"
//   listing_page    title ENDS in "Events in Kathmandu" (category index pages)
//   extra           matched settings.junkTitle.extraPatterns
// ---------------------------------------------------------------------------

// Single-word ALLCAPS job titles that are real roles. Seeded from the
// audit-log ALLCAPS inventory: the only single-word ALLCAPS titles on
// record are CONTENT, MANAGEMENT and FINANCE (department headings, all
// junk), so there is nothing real to seed yet. Extend per deploy through
// settings.junkTitle.allow.
const ROLE_ALLOW = Object.freeze([]);

const JUNK_NAV_HEADINGS = new Set([
    'home', 'about', 'about us', 'contact', 'contact us', 'careers', 'career',
    'jobs', 'job', 'blog', 'blogs', 'news', 'menu', 'login', 'log in',
    'sign in', 'sign up', 'register', 'faq', 'faqs', 'search', 'events',
    'internships', 'opportunities', 'apply', 'apply now', 'read more', 'learn more'
]);
const JUNK_PLACEHOLDER_RE = /^(?:untitled(?: (?:job|internship|event|scholarship|position|opportunity|post|listing))?|unnamed|no title|null|undefined|tbd|tba)$/i;
const JUNK_EMPTY_STATE_RES = [
    /^sorry\b.{0,30}\bno (?:open |current |available )?(?:positions?|openings?|vacanc(?:y|ies)|jobs?|internships?|results?|listings?|events?)\b/i,
    /^no (?:open |current |available )?(?:positions?|openings?|vacanc(?:y|ies)|jobs?|internships?|results?|listings?|events?)(?: (?:available|found|currently|at this time))?$/i
];
const JUNK_ALLCAPS_SINGLE_RE = /^[A-Z]{4,}$/;
const JUNK_NAV_SUFFIX_RE = /\b(?:pages?|blogs?|internship projects|travel opportunities)$/i;
const JUNK_LISTING_PAGE_RE = /\bevents in kathmandu$/i;

// Matching form only; the event object is never mutated. Zero-width and
// curly-quote characters are built with fromCharCode so this source stays
// pure ASCII.
const JUNK_ZERO_WIDTH_RE = new RegExp('[' + String.fromCharCode(0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF) + ']', 'g');
const JUNK_QUOTE_CLASS = '"\'' + String.fromCharCode(0x2018, 0x2019, 0x201C, 0x201D);
const JUNK_WRAP_QUOTES_RE = new RegExp('^[' + JUNK_QUOTE_CLASS + ']+|[' + JUNK_QUOTE_CLASS + ']+$', 'g');
const JUNK_TRAIL_PUNCT_RE = new RegExp('[.!:' + String.fromCharCode(0x2026) + ']+$');

function normalizeJunkTitle(raw) {
    let t = String(raw === null || raw === undefined ? '' : raw);
    t = t.normalize('NFKC');
    t = t.replace(JUNK_ZERO_WIDTH_RE, '');
    t = t.replace(/\s+/g, ' ').trim();
    t = t.replace(JUNK_WRAP_QUOTES_RE, '').trim();
    t = t.replace(JUNK_TRAIL_PUNCT_RE, '').trim();
    return t;
}

function readJunkConfig(settings) {
    const raw = settings && typeof settings.junkTitle === 'object' && settings.junkTitle ? settings.junkTitle : {};
    return {
        enabled: raw.enabled !== false,
        allow: Array.isArray(raw.allow) ? raw.allow : [],
        extraPatterns: Array.isArray(raw.extraPatterns) ? raw.extraPatterns : []
    };
}

function getJunkTitleReason(event, settings) {
    if (!event) return null;
    const cfg = readJunkConfig(settings);
    if (!cfg.enabled) return null;

    const t = normalizeJunkTitle(event.title);
    if (t === '') return 'empty_title';

    const lower = t.toLowerCase();
    const allowed = ROLE_ALLOW.concat(cfg.allow);
    for (let i = 0; i < allowed.length; i++) {
        if (normalizeJunkTitle(allowed[i]).toLowerCase() === lower) return null;
    }

    const alnum = (t.match(/[\p{L}\p{M}\p{N}]/gu) || []).length;
    if (alnum < 3) return 'too_short';
    if (!/\p{L}/u.test(t)) return 'no_letters';
    if (JUNK_PLACEHOLDER_RE.test(t)) return 'placeholder';
    for (let i = 0; i < JUNK_EMPTY_STATE_RES.length; i++) {
        if (JUNK_EMPTY_STATE_RES[i].test(t)) return 'empty_state';
    }
    const navKey = lower.replace(/[^a-z0-9 ]/g, '').replace(/ +/g, ' ').trim();
    if (JUNK_NAV_HEADINGS.has(navKey)) return 'nav_heading';
    if (event.itemType === 'job' && JUNK_ALLCAPS_SINGLE_RE.test(t)) return 'allcaps_single';
    if (JUNK_NAV_SUFFIX_RE.test(t)) return 'nav_suffix';
    if (JUNK_LISTING_PAGE_RE.test(t)) return 'listing_page';

    for (let i = 0; i < cfg.extraPatterns.length; i++) {
        let re = null;
        try {
            re = cfg.extraPatterns[i] instanceof RegExp ? cfg.extraPatterns[i] : new RegExp(String(cfg.extraPatterns[i]), 'i');
        } catch (e) {
            re = null; // invalid operator pattern: skip, never throw in the post path
        }
        if (re) {
            re.lastIndex = 0;
            if (re.test(t)) return 'extra';
        }
    }
    return null;
}

function hasJunkTitle(bot, event) {
    const settings = bot && bot.cache && bot.cache.settings ? bot.cache.settings : null;
    return getJunkTitleReason(event, settings) !== null;
}

module.exports = {
    getJunkTitleReason,
    hasJunkTitle,
    hasValidImage,
    shouldPingForEvent,
    hasDataQualityWarnings
};
