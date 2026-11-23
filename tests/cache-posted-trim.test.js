'use strict';
// Offline tests: postedEvents trim keeps unexpired jobs and scholarships. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { trimPostedEvents } = require('../src/core/cache');
const { CACHE_CAP } = require('../src/config/constants');

const mkBot = (arr) => ({ cache: { postedEvents: arr }, isEventPast: (e) => !!e.past });
const ev = (i) => ({ id: 'e' + i, itemType: 'event', title: 'E' + i });
const sch = (i, past) => ({ id: 's' + i, itemType: 'scholarship', title: 'S' + i, past: !!past });
const job = (i, past) => ({ id: 'j' + i, itemType: 'job', title: 'J' + i, past: !!past });

test('under the cap: untouched', () => {
    const arr = [ev(1), sch(1), job(1)];
    const bot = mkBot(arr);
    trimPostedEvents(bot);
    assert.equal(bot.cache.postedEvents.length, 3);
});

test('over the cap: oldest events dropped, live scholarships and jobs kept', () => {
    const arr = [];
    for (let i = 0; i < 60; i++) arr.push(sch(i, false));
    for (let i = 0; i < 20; i++) arr.push(job(i, false));
    for (let i = 0; i < CACHE_CAP - 80 + 101; i++) arr.push(ev(i));
    const bot = mkBot(arr);
    trimPostedEvents(bot);
    const out = bot.cache.postedEvents;
    assert.equal(out.length, CACHE_CAP);
    assert.equal(out.filter((e) => e.itemType === 'scholarship').length, 60);
    assert.equal(out.filter((e) => e.itemType === 'job').length, 20);
    assert.equal(out[out.length - 1].id, 'e' + (CACHE_CAP - 80 + 100));
});

test('expired scholarships and jobs are dropped first-come like events', () => {
    const arr = [];
    for (let i = 0; i < 30; i++) arr.push(sch(i, true));
    for (let i = 0; i < 30; i++) arr.push(job(i, true));
    for (let i = 0; i < CACHE_CAP; i++) arr.push(ev(i));
    const bot = mkBot(arr);
    trimPostedEvents(bot);
    assert.equal(bot.cache.postedEvents.length, CACHE_CAP);
    assert.equal(bot.cache.postedEvents.some((e) => e.itemType !== 'event'), false);
});

test('hard ceiling bounds growth when everything is live', () => {
    const arr = [];
    for (let i = 0; i < CACHE_CAP * 2 + 500; i++) arr.push(sch(i, false));
    const bot = mkBot(arr);
    trimPostedEvents(bot);
    assert.equal(bot.cache.postedEvents.length, CACHE_CAP * 2);
    assert.equal(bot.cache.postedEvents[bot.cache.postedEvents.length - 1].id, 's' + (CACHE_CAP * 2 + 499));
});

test('isEventPast throwing or missing does not crash the trim', () => {
    const arr = [];
    for (let i = 0; i < CACHE_CAP + 10; i++) arr.push(sch(i, false));
    const bot = { cache: { postedEvents: arr }, isEventPast() { throw new Error('boom'); } };
    assert.doesNotThrow(() => trimPostedEvents(bot));
    assert.equal(bot.cache.postedEvents.length, CACHE_CAP);
    const bot2 = { cache: { postedEvents: arr.slice() } };
    assert.doesNotThrow(() => trimPostedEvents(bot2));
});
