'use strict';
// Offline tests: live items keep their dedup key / name / id in the tracking
// arrays when postedEvents grows past the cap, and the hard ceiling warns
// loudly when it drops live items. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const cache = require('../src/core/cache');
const { getEventDedupKey } = require('../src/posting/dedup');
const { normalizeEventName } = require('../src/core/normalize');
const { CACHE_CAP } = require('../src/config/constants');

const HARD = CACHE_CAP * 2;
const mk = (type, i, past) => ({
    id: type + '-' + i, itemType: type,
    title: 'Title ' + type + ' number ' + i,
    url: 'https://x.invalid/' + type + '/' + i,
    past: !!past
});

function mkBot() {
    const bot = {
        cache: { postedEvents: [], postedEventKeys: [], postedEventNames: [], lastEventIds: [] },
        isEventPast: (e) => !!e.past,
        logs: []
    };
    bot.sendLogMessage = (m) => { bot.logs.push(m); return Promise.resolve(); };
    return bot;
}

function seed(bot, items) {
    items.forEach((e) => {
        bot.cache.postedEvents.push(e);
        bot.cache.postedEventKeys.push(getEventDedupKey(e));
        bot.cache.postedEventNames.push(normalizeEventName(e.title || ''));
        bot.cache.lastEventIds.push(e.id);
    });
}

test('exports are present', () => {
    assert.equal(typeof cache.markEventPosted, 'function');
    assert.equal(typeof cache.trimTrackingArrays, 'function');
});

test('trimTrackingArrays tolerates a bare cache', () => {
    assert.doesNotThrow(() => cache.trimTrackingArrays({ cache: {} }));
});

test('live items keep key, name and id when postedEvents grows past the cap', () => {
    const bot = mkBot();
    const nLive = CACHE_CAP - 100;
    const live = [];
    const old = [];
    for (let i = 0; i < nLive; i++) live.push(mk('scholarship', i, false));
    for (let i = 0; i < 100; i++) old.push(mk('event', i, false));
    seed(bot, live.concat(old));
    assert.equal(bot.cache.postedEvents.length, CACHE_CAP);

    for (let i = 0; i < 150; i++) cache.markEventPosted(bot, mk('job', i, false));

    // all 100 events dropped, every live item kept, postedEvents above the cap
    assert.equal(bot.cache.postedEvents.length, nLive + 150);
    assert.ok(bot.cache.postedEvents.length > CACHE_CAP);
    assert.ok(bot.cache.postedEvents.length <= HARD);

    const keys = new Set(bot.cache.postedEventKeys);
    const names = new Set(bot.cache.postedEventNames);
    const ids = new Set(bot.cache.lastEventIds);
    bot.cache.postedEvents.forEach((e) => {
        assert.ok(keys.has(getEventDedupKey(e)), 'key kept for ' + e.id);
        assert.ok(names.has(normalizeEventName(e.title)), 'name kept for ' + e.id);
        assert.ok(ids.has(e.id), 'id kept for ' + e.id);
    });

    // keys of the dropped events are gone, and the array tracks postedEvents
    assert.ok(!keys.has(getEventDedupKey(old[0])), 'dropped event key removed');
    assert.equal(bot.cache.postedEventKeys.length, bot.cache.postedEvents.length);
});

test('re-marking a live item whose key is still tracked does not duplicate it', () => {
    const bot = mkBot();
    const nLive = CACHE_CAP - 100;
    const live = [];
    const old = [];
    for (let i = 0; i < nLive; i++) live.push(mk('scholarship', i, false));
    for (let i = 0; i < 100; i++) old.push(mk('event', i, false));
    seed(bot, live.concat(old));
    for (let i = 0; i < 150; i++) cache.markEventPosted(bot, mk('job', i, false));
    const before = bot.cache.postedEvents.length;
    cache.markEventPosted(bot, live[0]);
    assert.equal(bot.cache.postedEvents.length, before);
});

test('below the cap nothing changes', () => {
    const bot = mkBot();
    seed(bot, [mk('job', 1, false), mk('scholarship', 1, false), mk('event', 1, false)]);
    cache.markEventPosted(bot, mk('job', 2, false));
    assert.equal(bot.cache.postedEvents.length, 4);
    assert.equal(bot.cache.postedEventKeys.length, 4);
});

test('hard ceiling dropping live items warns loudly; log channel message is throttled', () => {
    const bot = mkBot();
    const items = [];
    for (let i = 0; i < HARD + 5; i++) items.push(mk('scholarship', i, false));
    bot.cache.postedEvents = items.slice();
    const warns = [];
    const orig = console.warn;
    console.warn = (...a) => { warns.push(a.join(' ')); };
    try {
        cache.trimPostedEvents(bot);
        bot.cache.postedEvents = bot.cache.postedEvents.concat([mk('scholarship', 99999, false)]);
        cache.trimPostedEvents(bot);
    } finally {
        console.warn = orig;
    }
    assert.equal(bot.cache.postedEvents.length, HARD);
    assert.equal(warns.length, 2);
    assert.match(warns[0], /hard ceiling/);
    assert.match(warns[0], /dropped 5 live/);
    assert.equal(bot.logs.length, 1, 'logs channel notified once, second call throttled');
});
