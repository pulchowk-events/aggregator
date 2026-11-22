'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeShortcodeTimestamp, shortcodeToMediaId, isValidShortcode } = require('../src/scrapers/lib/insta-shortcode');

const NOW = Date.UTC(2026, 10, 23);
// [shortcode, date shown in the grid img alt for that post]
const KNOWN = [
    ['Deo1UA6hr7T', '2026-10-18'],
    ['De4L-t8D9YI', '2026-10-24'],
    ['Df6KP88uCQF', '2026-11-18']
];

for (const [code, day] of KNOWN) {
    test('decodes ' + code + ' to within 1.5 days of alt date ' + day, () => {
        const ms = decodeShortcodeTimestamp(code, { nowMs: NOW });
        assert.ok(ms, 'expected a timestamp');
        const diff = Math.abs(ms - Date.parse(day + 'T12:00:00Z'));
        assert.ok(diff <= 1.5 * 86400000, 'off by ' + (diff / 86400000).toFixed(2) + ' days: ' + new Date(ms).toISOString());
    });
}

test('decoded order matches posting order', () => {
    const t = KNOWN.map(([c]) => decodeShortcodeTimestamp(c, { nowMs: NOW }));
    assert.ok(t[0] < t[1] && t[1] < t[2]);
});

test('only the first 11 chars carry the id', () => {
    assert.equal(
        decodeShortcodeTimestamp('Deo1UA6hr7T' + 'abcdefghijklmnopq', { nowMs: NOW }),
        decodeShortcodeTimestamp('Deo1UA6hr7T', { nowMs: NOW })
    );
});

test('rejects junk', () => {
    assert.equal(decodeShortcodeTimestamp('', { nowMs: NOW }), null);
    assert.equal(decodeShortcodeTimestamp('ab$d-efghij', { nowMs: NOW }), null);
    assert.equal(decodeShortcodeTimestamp(null, { nowMs: NOW }), null);
    assert.equal(shortcodeToMediaId('x'), null);
    assert.equal(isValidShortcode('Deo1UA6hr7T'), true);
});

test('future-dated codes are rejected', () => {
    assert.equal(decodeShortcodeTimestamp('Deo1UA6hr7T', { nowMs: Date.UTC(2026, 0, 1) }), null);
});
