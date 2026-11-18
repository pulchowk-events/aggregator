'use strict';
// Block 5: reference example must follow the task `type`, not just detected.type.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadReference } = require('../wizard/prompt');

const REPO = path.resolve(__dirname, '..', '..');
const DIR = 'src/scrapers/extractors/';
const norm = (p) => p.replace(/\\/g, '/');
const DETECTED = ['single-page-cards', 'listing-to-detail', 'jsonld-first', 'unknown', 'bogus-type'];

test('jobs + listing-to-detail loads a jobs extractor, not events', () => {
    const ref = loadReference('jobs', 'listing-to-detail');
    assert.equal(norm(ref.path), DIR + 'jobs/kumarijob.js');
    assert.ok(!norm(ref.path).includes('/events/'));
});

test('jobs + single-page-cards loads growbydata', () => {
    assert.equal(norm(loadReference('jobs', 'single-page-cards').path), DIR + 'jobs/growbydata.js');
});

test('jobs + jsonld-first loads lftechnology, not growbydata or events', () => {
    const p = norm(loadReference('jobs', 'jsonld-first').path);
    assert.equal(p, DIR + 'jobs/lftechnology.js');
    assert.notEqual(p, DIR + 'jobs/growbydata.js');
    assert.ok(!p.includes('/events/'));
});

test('jobs + unknown and unrecognised detected.type use the jobs default', () => {
    assert.equal(norm(loadReference('jobs', 'unknown').path), DIR + 'jobs/growbydata.js');
    assert.equal(norm(loadReference('jobs', 'bogus-type').path), DIR + 'jobs/growbydata.js');
});

test('events resolution is unchanged for every detected.type', () => {
    const expected = {
        'single-page-cards': DIR + 'events/khalti.js',
        'listing-to-detail': DIR + 'events/katajaam.js',
        'jsonld-first':      DIR + 'events/nepvents.js',
        'unknown':           DIR + 'events/katajaam.js',
        'bogus-type':        DIR + 'events/katajaam.js'
    };
    for (const [d, want] of Object.entries(expected)) {
        assert.equal(norm(loadReference('events', d).path), want, `events/${d}`);
    }
});

test('undefined type keeps legacy events behaviour', () => {
    assert.equal(norm(loadReference(undefined, 'jsonld-first').path), DIR + 'events/nepvents.js');
});

test('scholarships resolve within scholarships, never events', () => {
    assert.equal(norm(loadReference('scholarships', 'listing-to-detail').path), DIR + 'scholarships/erasmusmundus.js');
    assert.equal(norm(loadReference('scholarships', 'single-page-cards').path), DIR + 'scholarships/scholarshipsads.js');
    for (const d of DETECTED) {
        assert.ok(norm(loadReference('scholarships', d).path).startsWith(DIR + 'scholarships/'), `scholarships/${d}`);
    }
});

test('every jobs and scholarships reference exists on disk and loads real code', () => {
    for (const type of ['jobs', 'scholarships']) {
        for (const d of DETECTED) {
            const ref = loadReference(type, d);
            assert.ok(fs.existsSync(path.join(REPO, ref.path)), `${type}/${d}: missing ${ref.path}`);
            assert.ok(!ref.code.startsWith('// Reference example not found'), `${type}/${d}: fallback stub returned`);
            assert.ok(ref.code.length > 200, `${type}/${d}: suspiciously short`);
        }
    }
});
