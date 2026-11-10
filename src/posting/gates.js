// src/posting/gates.js
// Three small predicates every post passes through before it can go live.
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

module.exports = {
    hasValidImage,
    shouldPingForEvent,
    hasDataQualityWarnings
};
