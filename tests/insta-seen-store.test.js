'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSeenStore, addSeen, isDue, MAX_SEEN } = require('../src/scrapers/lib/insta-seen-store');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'insta-seen-'));

test('missing record reads as cold start', () => {
    const store = createSeenStore({ rootDir: tmp() });
    const rec = store.load('locus_ioe');
    assert.equal(rec.exists, false);
    assert.deepEqual(rec.seen, []);
});

test('save/load roundtrip is case-insensitive and has the documented shape', () => {
    const root = tmp();
    const store = createSeenStore({ rootDir: root });
    store.save('Locus_IOE', { seen: ['a', 'b', 'a'], lastFetchedAt: '2026-11-22T00:00:00.000Z' });
    const rec = store.load('locus_ioe');
    assert.equal(rec.exists, true);
    assert.deepEqual(rec.seen, ['a', 'b']);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'seen', 'locus_ioe.json'), 'utf8'));
    assert.deepEqual(Object.keys(onDisk).sort(), ['lastFetchedAt', 'seen', 'username']);
    assert.equal(fs.readdirSync(path.join(root, 'seen')).some((f) => f.endsWith('.tmp')), false);
});

test('rejects path-traversal usernames', () => {
    const store = createSeenStore({ rootDir: tmp() });
    assert.throws(() => store.load('../etc/passwd'));
    assert.throws(() => store.save('a/b', { seen: [] }));
});

test('corrupt file reads as cold start', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'seen'), { recursive: true });
    fs.writeFileSync(path.join(root, 'seen', 'x.json'), '{not json');
    const rec = createSeenStore({ rootDir: root }).load('x');
    assert.equal(rec.exists, false);
    assert.equal(rec.corrupt, true);
});

test('addSeen dedupes, keeps order, caps at MAX_SEEN dropping oldest', () => {
    assert.deepEqual(addSeen(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
    const many = Array.from({ length: MAX_SEEN + 50 }, (_, i) => 'c' + i);
    const out = addSeen([], many);
    assert.equal(out.length, MAX_SEEN);
    assert.equal(out[out.length - 1], 'c' + (MAX_SEEN + 49));
});

test('isDue honours the interval', () => {
    const now = Date.parse('2026-11-22T12:00:00Z');
    const rec = (iso) => ({ exists: true, lastFetchedAt: iso });
    assert.equal(isDue({ exists: false }, now, 86400000), true);
    assert.equal(isDue(rec('2026-11-22T11:00:00Z'), now, 86400000), false);
    assert.equal(isDue(rec('2026-11-21T11:00:00Z'), now, 86400000), true);
    assert.equal(isDue(rec('garbage'), now, 86400000), true);
});

test('global state patch/delete', () => {
    const store = createSeenStore({ rootDir: tmp() });
    assert.deepEqual(store.readState(), {});
    store.patchState({ sessionDeadAt: 'x', other: 1 });
    assert.equal(store.readState().sessionDeadAt, 'x');
    store.patchState({ sessionDeadAt: null });
    assert.equal('sessionDeadAt' in store.readState(), false);
    assert.equal(store.readState().other, 1);
});
