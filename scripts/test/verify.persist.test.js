// scripts/test/verify.persist.test.js
// Parent-side tests for persist-meta: the new worker markers parse into
// results[name].meta, none of them can change decidePass, and layer
// counters parse (regression for the '\s' string-escape bug).
// Pure: synthetic worker blocks only. No browser, no network, no data/.

const test = require('node:test');
const assert = require('node:assert');

const { parseVerifyOutput, decidePass, buildResultMeta } = require('../batch/verify');

const block = (lines) => lines.join('\n') + '\n';

const OK_LINES = [
    'items: 3', 'rawItems: 3', 'verdict: ok', 'listingHits: 3', 'detailPages: 3',
    'parseFailures: 0', 'looksBlocked: false', 'duration: 13s',
    'itemsFile: written',
    'quality: medium', 'qualityScore: 70',
    'coverageTitle: 3/3', 'coverageCompany: 3/3', 'coverageDesc: 3/3',
    'coverageLoc: 3/3', 'coverageImg: 3/3', 'coverageDeadline: 0/3',
    '--- first 3 items ---',
    '[0] Frontend Developer (Intern)',
    '[1] Backend Developer (Intern)',
    '[2] Graphics Designer (Intern)'
];

const CTX = { isTemplate: false, isHtmlTemplate: false, resolution: null, dumpEvidence: null };

test('meta carries the worker scalars; existing fields are untouched', () => {
    const parsed = parseVerifyOutput(block(OK_LINES));
    assert.strictEqual(parsed.items, 3);
    assert.strictEqual(parsed.verdict, 'ok');
    assert.strictEqual(parsed.durationSec, 13);
    assert.strictEqual(parsed.quality, 'medium');
    assert.deepStrictEqual(buildResultMeta(parsed), {
        listingHits: 3,
        detailPages: 3,
        parseFailures: 0,
        looksBlocked: false,
        timedOut: false,
        itemsFile: 'written'
    });
});

test('itemsFile: written | skipped | failed parse; absent or unknown is null', () => {
    for (const status of ['written', 'skipped', 'failed']) {
        const lines = OK_LINES.map((l) => (l.startsWith('itemsFile:') ? `itemsFile: ${status}` : l));
        assert.strictEqual(parseVerifyOutput(block(lines)).itemsFile, status);
    }
    const absent = OK_LINES.filter((l) => !l.startsWith('itemsFile:'));
    assert.strictEqual(parseVerifyOutput(block(absent)).itemsFile, null);
    assert.strictEqual(buildResultMeta(parseVerifyOutput(block(absent))).itemsFile, null);
    const bogus = OK_LINES.map((l) => (l.startsWith('itemsFile:') ? 'itemsFile: bogus' : l));
    assert.strictEqual(parseVerifyOutput(block(bogus)).itemsFile, null);
});

test('timeout block: meta.timedOut true via verdict, itemsFile skipped', () => {
    const parsed = parseVerifyOutput(block([
        'items: 0', 'rawItems: 0', 'verdict: timeout',
        'listingHits: 0', 'detailPages: 0', 'parseFailures: 0', 'looksBlocked: false',
        'duration: 61s', 'itemsFile: skipped', 'error: per-site timeout 60000ms'
    ]));
    assert.strictEqual(parsed.timedOut, false);
    assert.deepStrictEqual(buildResultMeta(parsed), {
        listingHits: 0,
        detailPages: 0,
        parseFailures: 0,
        looksBlocked: false,
        timedOut: true,
        itemsFile: 'skipped'
    });
});

test('extractor-level timedOut line sets meta.timedOut', () => {
    const parsed = parseVerifyOutput(block([...OK_LINES, 'timedOut: true']));
    assert.strictEqual(parsed.verdict, 'ok');
    assert.strictEqual(buildResultMeta(parsed).timedOut, true);
});

test('first itemsFile line wins; a later line cannot override it', () => {
    const parsed = parseVerifyOutput(block([...OK_LINES, 'itemsFile: failed']));
    assert.strictEqual(parsed.itemsFile, 'written');
});

test('layer counters parse (not silently 0)', () => {
    const parsed = parseVerifyOutput(block([
        ...OK_LINES, 'layerImagesAdded: 3', 'layerGeoDropped: 2', 'layerExpiredDropped: 1'
    ]));
    assert.strictEqual(parsed.layers.imagesAdded, 3);
    assert.strictEqual(parsed.layers.geoDropped, 2);
    assert.strictEqual(parsed.layers.expiredDropped, 1);
    assert.strictEqual(parsed.layers.filterDropped, 0);
    assert.strictEqual(parseVerifyOutput(block(OK_LINES)).layers.imagesAdded, 0);
});

test('decidePass unchanged: new marker lines do not alter a passing decision', () => {
    const withNew = parseVerifyOutput(block(OK_LINES));
    const withoutNew = parseVerifyOutput(block(
        OK_LINES.filter((l) => !/^(itemsFile|detailPages|parseFailures):/.test(l))
    ));
    const a = decidePass(withNew, CTX);
    const b = decidePass(withoutNew, CTX);
    assert.deepStrictEqual(
        { pass: a.pass, reason: a.reason },
        { pass: b.pass, reason: b.reason }
    );
    assert.deepStrictEqual({ pass: a.pass, reason: a.reason }, { pass: true, reason: 'ok' });
});

test('decidePass unchanged: low_field_coverage still fails (aarambhait shape)', () => {
    const lines = OK_LINES.map((l) => (l === 'coverageLoc: 3/3' ? 'coverageLoc: 0/3' : l));
    const parsed = parseVerifyOutput(block(lines));
    const d = decidePass(parsed, CTX);
    assert.strictEqual(d.pass, false);
    assert.strictEqual(d.reason, 'low_field_coverage');
    assert.strictEqual(d.field, 'location');
});
