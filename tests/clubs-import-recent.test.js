'use strict';
// Offline tests: argument parsing and newest-N selection of scripts/clubs-import-recent.js. No network, no browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, pickNewest } = require('../scripts/clubs-import-recent');

test('defaults: dry run, 4 per club, 5 clubs', () => {
    const o = parseArgs([]);
    assert.equal(o.error, null);
    assert.equal(o.apply, false);
    assert.equal(o.per, 4);
    assert.equal(o.limitClubs, 5);
    assert.equal(o.clubs, null);
});

test('flags parse, club names are normalised', () => {
    const o = parseArgs(['--apply', '--per', '2', '--clubs', 'A,@b, ']);
    assert.equal(o.error, null);
    assert.equal(o.apply, true);
    assert.equal(o.per, 2);
    assert.deepEqual(o.clubs, ['a', 'b']);
});

test('bad input is rejected', () => {
    assert.ok(parseArgs(['--per', '13']).error);
    assert.ok(parseArgs(['--per', '0']).error);
    assert.ok(parseArgs(['--per', 'x']).error);
    assert.ok(parseArgs(['--limit-clubs', '0']).error);
    assert.ok(parseArgs(['--bogus']).error);
    assert.ok(parseArgs(['--clubs', ',']).error);
});

test('pickNewest: newest first, untimed last, ties keep page order, limit applied', () => {
    const items = [
        { shortcode: 'old', takenAt: '2026-01-01T00:00:00.000Z' },
        { shortcode: 'none1', takenAt: null },
        { shortcode: 'new', takenAt: '2026-11-01T00:00:00.000Z' },
        { shortcode: 'mid', takenAt: '2026-06-01T00:00:00.000Z' },
        { shortcode: 'none2' }
    ];
    assert.deepEqual(pickNewest(items, 3).map((x) => x.shortcode), ['new', 'mid', 'old']);
    assert.deepEqual(pickNewest(items, 5).map((x) => x.shortcode), ['new', 'mid', 'old', 'none1', 'none2']);
    assert.deepEqual(pickNewest([], 4), []);
    assert.deepEqual(pickNewest(null, 4), []);
});
