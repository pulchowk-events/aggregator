// scripts/test/verify-worker.items.test.js
// Pure unit tests for itemsPath() in scripts/batch/lib/paths.js.
// No browser, no network, no data/ access.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { itemsPath, resolveRunDir, paths, BATCH_ROOT } = require('../batch/lib/paths');

const VALID_IDS = ['companies-76', '20260101T120000Z', 'run_1', 'A-b_C-9'];
const INVALID_IDS = ['', 'a b', 'a/b', 'a\\b', '../x', '..', '.', 'a.b', 'run;id', 'a\nb'];

test('accepts the same run ids as resolveRunDir', () => {
    for (const id of VALID_IDS) {
        assert.doesNotThrow(() => resolveRunDir(id), `resolveRunDir ${id}`);
        assert.doesNotThrow(() => itemsPath(id, 'src'), `itemsPath ${id}`);
    }
});

test('rejects the same run ids as resolveRunDir', () => {
    for (const id of INVALID_IDS) {
        assert.throws(() => resolveRunDir(id), /invalid run-id/, `resolveRunDir ${JSON.stringify(id)}`);
        assert.throws(() => itemsPath(id, 'src'), /invalid run-id/, `itemsPath ${JSON.stringify(id)}`);
    }
});

test('path shape: <BATCH_ROOT>/<runId>/results/<name>.items.json', () => {
    const p = itemsPath('companies-76', 'aarambhait-2');
    assert.strictEqual(
        p,
        path.join(BATCH_ROOT, 'companies-76', 'results', 'aarambhait-2.items.json')
    );
});

test('lives in the same results dir as the per-site result json', () => {
    const p = itemsPath('run_1', 'cloudfactory');
    const resultsDir = paths(resolveRunDir('run_1')).results;
    assert.strictEqual(path.dirname(p), resultsDir);
    assert.notStrictEqual(p, path.join(resultsDir, 'cloudfactory.json'));
});

test('suffix is .items.json', () => {
    assert.ok(itemsPath('run_1', 'x').endsWith('.items.json'));
    assert.strictEqual(path.basename(itemsPath('run_1', 'x')), 'x.items.json');
});

test('deterministic: same inputs give the same path', () => {
    assert.strictEqual(itemsPath('run_1', 'x'), itemsPath('run_1', 'x'));
});

test('different sources and runs give different paths', () => {
    assert.notStrictEqual(itemsPath('run_1', 'x'), itemsPath('run_1', 'y'));
    assert.notStrictEqual(itemsPath('run_1', 'x'), itemsPath('run_2', 'x'));
});
