// scripts/test/scrape-now.test.js
// Fixture wrappers stand in for real sources; no browser, no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { scrapeNow, parseArgs, defaultRunId } = require('../batch/scrape-now');
const { itemsPath } = require('../batch/lib/paths');

const FIXTURE_ITEMS = [
    {
        id: 'fixture-1', title: 'Backend Developer', company: 'Fixture Co',
        url: 'https://example.test/1', registrationUrl: 'https://example.test/1',
        location: null, location_status: 'site_absent', location_evidence: 'none',
        description: 'Build things.', employmentType: 'Full Time',
        image: 'https://example.test/i.png', salary: null, level: 'Mid Level'
    },
    {
        id: 'fixture-2', title: 'QA Engineer', company: 'Fixture Co',
        url: 'https://example.test/2', registrationUrl: 'https://example.test/2',
        location: 'Kathmandu', description: 'Test things.', employmentType: 'Full Time',
        image: 'https://example.test/i.png', salary: null, level: 'Junior'
    }
];

class FakeProgress { start() {} }
function makeDeps() {
    const d = { closeCalls: 0, withPage: async (fn) => fn({}), ScrapeProgressTracker: FakeProgress };
    d.closeBrowser = async () => { d.closeCalls++; };
    return d;
}
function loaderFor(map) {
    return (name) => {
        if (!map[name]) throw new Error(`no source wrapper for ${name}`);
        return { wrapper: map[name], type: 'jobs' };
    };
}

const created = [];
function uniqueRun(tag) {
    const id = `scrape-now-test-${tag}-${process.pid}-${Date.now()}`;
    created.push(id);
    return id;
}
test.after(() => {
    // Remove only dirs we created, and only when the run dir is named after the run id.
    for (const id of created) {
        const resultsDir = path.dirname(itemsPath(id, 'x'));
        const runDir = path.dirname(resultsDir);
        if (path.basename(runDir) === id && fs.existsSync(runDir)) {
            fs.rmSync(runDir, { recursive: true, force: true });
        }
    }
});

test('writes items.json unchanged and a verify-shaped stub', async () => {
    const runId = uniqueRun('ok');
    const wrappers = {
        fixa: { name: 'fixa', type: 'jobs', scrape: async () => ({ items: FIXTURE_ITEMS, meta: {} }) }
    };
    const r = await scrapeNow({
        sources: ['fixa'], runId, loadWrapper: loaderFor(wrappers), deps: makeDeps(), log: () => {}
    });
    assert.strictEqual(r.exitCode, 0);

    const file = itemsPath(runId, 'fixa');
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(written));
    assert.deepStrictEqual(written, FIXTURE_ITEMS);                 // raw runSource output, not re-shaped
    assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify(FIXTURE_ITEMS, null, 2)); // 2-space, same as verify

    const stub = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'fixa.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(stub).sort(), ['items', 'name', 'pass', 'source', 'timestamp']);
    assert.strictEqual(stub.name, 'fixa');
    assert.strictEqual(stub.pass, true);
    assert.strictEqual(stub.items, 2);
    assert.strictEqual(stub.source, 'scrape-now');
    assert.ok(!Number.isNaN(Date.parse(stub.timestamp)));
});

test('a throwing source gives exit 1 and does not stop the others', async () => {
    const runId = uniqueRun('throw');
    const wrappers = {
        bad: { name: 'bad', type: 'jobs', scrape: async () => { throw new Error('boom'); } },
        good: { name: 'good', type: 'jobs', scrape: async () => ({ items: [FIXTURE_ITEMS[0]], meta: {} }) }
    };
    const lines = [];
    const r = await scrapeNow({
        sources: ['bad', 'good'], runId, loadWrapper: loaderFor(wrappers), deps: makeDeps(), log: (l) => lines.push(l)
    });
    assert.strictEqual(r.exitCode, 1);
    assert.deepStrictEqual(r.results.map((x) => [x.name, x.ok]), [['bad', false], ['good', true]]);
    assert.ok(fs.existsSync(itemsPath(runId, 'good')));
    assert.ok(!fs.existsSync(itemsPath(runId, 'bad')));
    assert.ok(lines.some((l) => l.includes('failed sources: bad')));
});

test('extractorMissing stub result counts as a failure', async () => {
    const runId = uniqueRun('stub');
    const wrappers = {
        stubby: { name: 'stubby', type: 'jobs', scrape: async () => ({ items: [], meta: { extractorMissing: true } }) }
    };
    const r = await scrapeNow({
        sources: ['stubby'], runId, loadWrapper: loaderFor(wrappers), deps: makeDeps(), log: () => {}
    });
    assert.strictEqual(r.exitCode, 1);
    assert.ok(!fs.existsSync(itemsPath(runId, 'stubby')));
});

test('timeout fails the source and resets the browser', async () => {
    const runId = uniqueRun('slow');
    const wrappers = {
        slow: { name: 'slow', type: 'jobs', scrape: () => new Promise(() => {}) }
    };
    const deps = makeDeps();
    const r = await scrapeNow({
        sources: ['slow'], runId, timeoutMs: 50, loadWrapper: loaderFor(wrappers), deps, log: () => {}
    });
    assert.strictEqual(r.exitCode, 1);
    assert.ok(deps.closeCalls >= 1);
});

test('rejects path-like source names', async () => {
    const r = await scrapeNow({
        sources: ['../evil'], runId: uniqueRun('name'), loadWrapper: loaderFor({}), deps: makeDeps(), log: () => {}
    });
    assert.strictEqual(r.exitCode, 1);
});

test('parseArgs and default run id', () => {
    const a = parseArgs(['--sources', 'blacktech, f1soft', '--type', 'jobs']);
    assert.deepStrictEqual(a.sources, ['blacktech', 'f1soft']);
    assert.strictEqual(a.type, 'jobs');
    assert.throws(() => parseArgs([]), /--sources is required/);
    assert.throws(() => parseArgs(['--sources', 'a', '--type', 'nope']), /--type/);
    assert.ok(/^scrape-now-[0-9T-]+Z$/.test(defaultRunId(new Date('2026-11-19T10:20:30.456Z'))));
});
