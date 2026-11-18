// scripts/test/dryrun.gates.test.js
// Tests for scripts/batch/dry-run.js. Uses temp dirs (same mechanism as
// --items). No browser, no network, no data/ access.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseDryRunArgs, evaluateItem, analyzeRun, renderText, runDryRun } = require('../batch/dry-run');

const GOOD_IMG = 'https://example.com/photo.jpg';

function mkdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dryrun-')); }
function writeItems(dir, name, items) {
    fs.writeFileSync(path.join(dir, `${name}.items.json`), JSON.stringify(items));
}
function item(over) { return Object.assign({ title: 't', image: GOOD_IMG }, over); }

test('(a) missing/invalid images are rejected no_image in main, accepted in test', () => {
    const dir = mkdir();
    writeItems(dir, 'src_a', [
        item({ image: null }),
        item({ image: '' }),
        item({ image: 'ftp://example.com/a.jpg' }),
        item({ image: 'https://example.com/placeholder.png' })
    ]);
    const main = analyzeRun({ itemsDir: dir, mode: 'main' });
    assert.strictEqual(main.aggregate.items, 4);
    assert.strictEqual(main.aggregate.modes.main.ok, 0);
    assert.strictEqual(main.aggregate.modes.main.reasons.no_image, 4);
    const test_ = analyzeRun({ itemsDir: dir, mode: 'test' });
    assert.strictEqual(test_.aggregate.modes.test.ok, 4);
    assert.strictEqual(test_.aggregate.modes.test.rejected, 0);
});

test('(b) dataQualityWarnings -> data_quality_warning in main, accepted in test', () => {
    const dir = mkdir();
    writeItems(dir, 'src_b', [
        item({ dataQualityWarnings: ['Possible duplicate'] }),
        item({ dataQualityWarnings: [] })
    ]);
    const r = analyzeRun({ itemsDir: dir });
    assert.strictEqual(r.aggregate.modes.main.reasons.data_quality_warning, 1);
    assert.strictEqual(r.aggregate.modes.main.ok, 1);
    assert.strictEqual(r.aggregate.modes.test.ok, 2);
});

test('(c) all-clean items all pass in both modes', () => {
    const dir = mkdir();
    writeItems(dir, 'src_c', [item(), item(), item()]);
    const r = analyzeRun({ itemsDir: dir });
    assert.strictEqual(r.aggregate.modes.main.ok, 3);
    assert.strictEqual(r.aggregate.modes.test.ok, 3);
    assert.strictEqual(r.errors.length, 0);
    assert.strictEqual(runDryRun({ itemsDir: dir, print: false }).exitCode, 0);
});

test('(d1) scholarship without image passes main; with warnings it does not', () => {
    assert.deepStrictEqual(evaluateItem({ itemType: 'scholarship', image: null }, 'main'), { ok: true });
    const r = evaluateItem({ itemType: 'scholarship', image: null, dataQualityWarnings: ['x'] }, 'main');
    assert.strictEqual(r.reason, 'data_quality_warning');
});

test('(d2) item with both defects counts once, as no_image (gate order)', () => {
    const dir = mkdir();
    writeItems(dir, 'both', [{ title: 't', image: null, dataQualityWarnings: ['x'] }]);
    const r = analyzeRun({ itemsDir: dir, mode: 'main' });
    assert.strictEqual(r.aggregate.modes.main.rejected, 1);
    assert.deepStrictEqual(r.aggregate.modes.main.reasons, { no_image: 1 });
});

test('(d3) category/channel gates are "not evaluated" without resolvers', () => {
    const dir = mkdir();
    writeItems(dir, 's', [item()]);
    const r = analyzeRun({ itemsDir: dir });
    assert.deepStrictEqual(r.gates.notEvaluated, ['no_category', 'no_channel']);
    assert.strictEqual(r.aggregate.modes.main.ok, 1);
    assert.match(renderText(r), /not_evaluated: no_category=1, no_channel=1/);
});

test('(d4) injected resolvers produce no_category / no_channel rejects', () => {
    const dir = mkdir();
    writeItems(dir, 's', [item({ k: 'jobs' }), item({ k: 'ghost' }), item({ k: null })]);
    const opts = {
        itemsDir: dir,
        resolveCategory: (it) => it.k,
        resolveChannel: (k, mode) => (k === 'jobs' ? 'chan-' + mode : null)
    };
    const r = analyzeRun(opts);
    assert.deepStrictEqual(r.gates.notEvaluated, []);
    assert.strictEqual(r.aggregate.modes.main.ok, 1);
    assert.strictEqual(r.aggregate.modes.main.reasons.no_category, 1);
    assert.strictEqual(r.aggregate.modes.main.reasons.no_channel, 1);
});

test('(d5) non-object entries are rejected invalid_item, not a crash', () => {
    const dir = mkdir();
    writeItems(dir, 's', [null, 'str', item()]);
    const r = analyzeRun({ itemsDir: dir, mode: 'main' });
    assert.strictEqual(r.aggregate.modes.main.reasons.invalid_item, 2);
    assert.strictEqual(r.aggregate.modes.main.ok, 1);
});

test('(d6) missing dir throws a clear error; malformed JSON is reported, exit 1', () => {
    assert.throws(() => analyzeRun({ itemsDir: path.join(os.tmpdir(), 'dryrun-does-not-exist-xyz') }), /items dir not found/);
    const dir = mkdir();
    fs.writeFileSync(path.join(dir, 'bad.items.json'), '{not json');
    writeItems(dir, 'good', [item()]);
    const res = runDryRun({ itemsDir: dir, print: false });
    assert.strictEqual(res.exitCode, 1);
    assert.strictEqual(res.report.errors.length, 1);
    assert.match(res.report.errors[0], /bad\.items\.json/);
    assert.strictEqual(res.report.aggregate.modes.main.ok, 1);
});

test('(d7) --source filters; unknown source throws; verify flag read from <name>.json', () => {
    const dir = mkdir();
    writeItems(dir, 'one', [item()]);
    writeItems(dir, 'two', [item(), item()]);
    fs.writeFileSync(path.join(dir, 'two.json'), JSON.stringify({ pass: true }));
    const r = analyzeRun({ itemsDir: dir, source: 'two' });
    assert.strictEqual(r.sources.length, 1);
    assert.strictEqual(r.sources[0].verify, 'pass');
    assert.strictEqual(r.aggregate.items, 2);
    assert.throws(() => analyzeRun({ itemsDir: dir, source: 'nope' }), /source not found/);
});

test('(d8) empty items dir reports zero without crashing', () => {
    const r = analyzeRun({ itemsDir: mkdir() });
    assert.strictEqual(r.aggregate.items, 0);
    assert.ok(renderText(r).includes('(no *.items.json files found)'));
});

test('arg parser maps --items to itemsDir and validates', () => {
    const a = parseDryRunArgs(['--run', 'companies-76', '--mode', 'main', '--source', 'x', '--items', '/tmp/stub', '--json']);
    assert.deepStrictEqual(a, { run: 'companies-76', mode: 'main', source: 'x', itemsDir: '/tmp/stub', json: true });
    assert.throws(() => parseDryRunArgs(['--mode', 'live']), /--mode must be/);
    assert.throws(() => parseDryRunArgs(['--run']), /requires a value/);
    assert.throws(() => parseDryRunArgs(['--bogus']), /unknown argument/);
});

test('--run required when --items is absent', () => {
    assert.throws(() => analyzeRun({}), /--run <id> is required/);
});
