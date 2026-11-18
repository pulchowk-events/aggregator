#!/usr/bin/env node
// scripts/batch/scrape-now.js
// Operator helper: run source wrappers through runSource (the same path
// verify-worker uses), write data/batch/<run>/results/<name>.items.json
// plus a minimal verify-shaped <name>.json stub, so dry-run can read them.
//
// No Discord, no bot cache, no audit log, no posting, no verify.
// Items are written exactly as runSource returns them (same as
// verify-worker); no normalizeByType, so the shape matches verify's output.
//
// Usage:
//   node scripts/batch/scrape-now.js --sources blacktech,f1soft,technorio
//        [--run <id>] [--type jobs] [--timeout <ms>]
//
// Exit: 0 all sources ran, 1 any source failed, 2 usage error.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const SOURCES_DIR = path.join(REPO, 'src', 'scrapers', 'sources');
const { itemsPath } = require(path.join(__dirname, 'lib', 'paths'));

const TYPES = ['events', 'jobs', 'scholarships'];
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const DEFAULT_TIMEOUT_MS = 120000;

function findType(name, typeHint) {
    const candidates = typeHint ? [typeHint] : TYPES;
    for (const t of candidates) {
        if (fs.existsSync(path.join(SOURCES_DIR, t, `${name}.js`))) return t;
    }
    return null;
}

function defaultLoadWrapper(name, typeHint) {
    const type = findType(name, typeHint);
    if (!type) {
        throw new Error(`no source wrapper for ${name}` + (typeHint ? ` in type ${typeHint}` : ''));
    }
    const wrapper = require(path.join(SOURCES_DIR, type, `${name}.js`));
    if (!wrapper || typeof wrapper.scrape !== 'function') {
        throw new Error(`wrapper for ${name} has no scrape()`);
    }
    return { wrapper, type };
}

function defaultDeps() {
    const { withPage, closeBrowser } = require(path.join(REPO, 'src', 'scrapers', 'browser'));
    const { ScrapeProgressTracker } = require(path.join(REPO, 'src', 'scrapers', 'progress'));
    return { withPage, closeBrowser, ScrapeProgressTracker };
}

function defaultRunId(date) {
    return 'scrape-now-' + date.toISOString().replace(/[:.]/g, '-');
}

function writeOutputs(runId, name, items, timestamp) {
    const itemsFile = itemsPath(runId, name);
    const dir = path.dirname(itemsFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(itemsFile, JSON.stringify(items, null, 2));
    const stubFile = path.join(dir, `${name}.json`);
    const stub = { name, pass: true, items: items.length, source: 'scrape-now', timestamp };
    fs.writeFileSync(stubFile, JSON.stringify(stub, null, 2));
    return { itemsFile, stubFile };
}

async function runWithTimeout(wrapper, ctx, name, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(Object.assign(new Error(`per-source timeout ${timeoutMs}ms`), { timedOut: true }));
        }, timeoutMs);
    });
    try {
        return await Promise.race([wrapper.scrape(ctx), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

async function scrapeNow(opts) {
    const {
        sources,
        runId,
        type = null,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        loadWrapper = defaultLoadWrapper,
        deps = null,
        log = console.log,
        now = () => new Date()
    } = opts;

    const startedAt = now();
    const run = runId || defaultRunId(startedAt);
    const d = deps || defaultDeps();
    const results = [];

    try {
        for (const name of sources) {
            const t0 = Date.now();
            try {
                if (!NAME_RE.test(name)) throw new Error(`invalid source name "${name}"`);
                const { wrapper } = loadWrapper(name, type);
                const progress = new d.ScrapeProgressTracker();
                progress.start([name]);

                const result = await runWithTimeout(
                    wrapper,
                    { withPage: d.withPage, progress },
                    name,
                    timeoutMs
                );
                if (!result || !Array.isArray(result.items)) {
                    throw new Error('scrape() did not return { items: [] }');
                }
                if (result.meta && result.meta.extractorMissing) {
                    throw new Error('extractor not implemented (stub only)');
                }

                const files = writeOutputs(run, name, result.items, now().toISOString());
                const sec = Math.round((Date.now() - t0) / 1000);
                results.push({ name, ok: true, items: result.items.length, itemsFile: files.itemsFile });
                log(`ok   ${name} items=${result.items.length} ${sec}s`);
                if (result.items.length === 0) {
                    const m = result.meta || {};
                    log(`WARN ${name} produced 0 items (listingHits=${m.listingHits || 0}, looksBlocked=${m.looksBlocked || false})`);
                }
            } catch (e) {
                const msg = String((e && e.message) || e).replace(/\n/g, ' ');
                results.push({ name, ok: false, error: msg });
                log(`FAIL ${name}: ${msg}`);
                if (e && e.timedOut && typeof d.closeBrowser === 'function') {
                    // A timed-out page may be wedged; reset before the next source.
                    try { await d.closeBrowser(); } catch (_) { /* best effort */ }
                }
            }
        }
    } finally {
        if (typeof d.closeBrowser === 'function') {
            try { await d.closeBrowser(); } catch (_) { /* best effort */ }
        }
    }

    const failed = results.filter((r) => !r.ok);
    log(`run=${run} ok=${results.length - failed.length} failed=${failed.length}`);
    if (failed.length > 0) log(`failed sources: ${failed.map((r) => r.name).join(', ')}`);
    return { runId: run, results, exitCode: failed.length > 0 ? 1 : 0 };
}

function parseArgs(argv) {
    const out = { sources: null, runId: null, type: null, timeoutMs: DEFAULT_TIMEOUT_MS };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
            return argv[++i];
        };
        if (a === '--sources') out.sources = next().split(',').map((s) => s.trim()).filter(Boolean);
        else if (a === '--run') out.runId = next();
        else if (a === '--type') out.type = next();
        else if (a === '--timeout') out.timeoutMs = parseInt(next(), 10);
        else throw new Error(`unknown argument ${a}`);
    }
    if (!out.sources || out.sources.length === 0) throw new Error('--sources is required');
    if (out.type && !TYPES.includes(out.type)) throw new Error(`--type must be one of ${TYPES.join(', ')}`);
    if (!Number.isFinite(out.timeoutMs) || out.timeoutMs < 1000) throw new Error('--timeout must be >= 1000 ms');
    return out;
}

async function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(`scrape-now: ${e.message}`);
        console.error('usage: node scripts/batch/scrape-now.js --sources a,b,c [--run <id>] [--type jobs] [--timeout <ms>]');
        process.exit(2);
    }
    const r = await scrapeNow(args);
    process.exit(r.exitCode);
}

if (require.main === module) {
    main().catch((e) => {
        console.error(`scrape-now crashed: ${e && e.stack || e}`);
        process.exit(1);
    });
}

module.exports = { scrapeNow, parseArgs, defaultRunId };
