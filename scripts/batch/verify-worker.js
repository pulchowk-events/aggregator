#!/usr/bin/env node
// scripts/batch/verify-worker.js
// Persistent worker for parallel batch verify. Reads SITE <name> lines from
// stdin (one per job), runs the site against a shared Chromium, emits a
// delimited result block on stdout. Loops until SHUTDOWN or stdin EOF.
//
// Protocol (line-oriented, no JSON, no framing ambiguity):
//   Parent -> worker stdin:  "SITE <name>\n"  or  "SHUTDOWN\n"
//   Worker -> parent stdout: "::: SITE_BEGIN <name>\n...\n::: SITE_END <name>\n"
//
// A worker holds ONE browser instance for its lifetime. That's the point:
// amortize launch/close cost over N sites. Parent spawns `parallel` workers
// and dispatches sites dynamically -- a worker finishing its site gets the
// next pending name immediately, so a slow site blocks only itself.
//
// On per-site timeout: worker emits a timeout block, closes and relaunches
// its browser (a wedged page can poison the next site), continues.
// On SHUTDOWN: closes browser, exits cleanly.
// On stdin EOF (parent died): closes browser, exits cleanly.

const path = require('path');
const readline = require('readline');

const argv = process.argv.slice(2);
const PER_SITE_TIMEOUT_MS = Math.max(15000, parseInt(argv[0], 10) || 60000);

const REPO = path.resolve(__dirname, '..', '..');
const fs = require('fs');
const { withPage, closeBrowser } = require(path.join(REPO, 'src', 'scrapers', 'browser'));
const { ScrapeProgressTracker } = require(path.join(REPO, 'src', 'scrapers', 'progress'));
const { loadExtractor } = require(path.join(REPO, 'src', 'scrapers', 'extractors'));
const { classifyOutcome } = require(path.join(REPO, 'src', 'scrapers', 'diagnostics'));
const { normalizeByType } = require(path.join(REPO, 'src', 'scrapers', 'scrapeAll'));
const { runSource } = require(path.join(REPO, 'src', 'scrapers', 'sources', '_orchestrate'));

const TYPES = ['events', 'jobs', 'scholarships'];

function findType(name) {
    for (const t of TYPES) {
        const dir = path.join(REPO, 'src', 'scrapers', 'sources', t);
        if (fs.existsSync(path.join(dir, `${name}.js`))) return t;
    }
    return null;
}

// Extractors are loaded lazily and cached. Loading throws if the extractor
// file is missing/invalid; we translate that into an error block for the
// parent to record.
const extractorCache = new Map();
function getExtractor(name) {
    if (extractorCache.has(name)) return extractorCache.get(name);
    const sourceType = findType(name);
    if (!sourceType) throw new Error(`no source wrapper for ${name}`);
    const { extractor, isStub } = loadExtractor(sourceType, name);
    if (isStub) throw new Error(`stub only for ${name}`);
    const entry = { extractor, sourceType };
    extractorCache.set(name, entry);
    return entry;
}

function emit(name, lines) {
    process.stdout.write(`::: SITE_BEGIN ${name}\n`);
    for (const line of lines) process.stdout.write(line + '\n');
    process.stdout.write(`::: SITE_END ${name}\n`);
}

async function runSite(name) {
    const t0 = Date.now();

    let loadErr = null;
    let extractor = null;
    let sourceType = null;
    try {
        const got = getExtractor(name);
        extractor = got.extractor;
        sourceType = got.sourceType;
    } catch (e) {
        loadErr = e;
    }
    if (loadErr) {
        const sec = Math.round((Date.now() - t0) / 1000);
        emit(name, [
            'items: 0',
            'verdict: load_failed',
            'listingHits: 0', 'detailPages: 0', 'parseFailures: 0', 'looksBlocked: false',
            `duration: ${sec}s`,
            `error: ${String(loadErr.message).replace(/\n/g, ' ')}`
        ]);
        return;
    }

    const progress = new ScrapeProgressTracker();
    progress.start([name]);
    const meta = {
        pagesVisited: 0, listingHits: 0, detailPagesVisited: 0,
        detailParseFailures: 0, looksBlocked: false
    };

    // Deep timing log emitted to stderr so parent capture (stdout for
    // protocol markers, stderr for diagnostics) keeps them separate.
    // Parent's stderrTail in results/<name>.json captures the tail.
    const dbg = (msg) => process.stderr.write(`::: DBG ${name} +${((Date.now()-t0)/1000).toFixed(1)}s ${msg}\n`);

    // Production-pipeline verification: runSource applies the full
    // layer chain (geo filter -> itemFilter -> universalNormalize ->
    // image enrichment -> shape). Items returned here are what would
    // reach pendingEvents after a real scrape, not raw extractor output.
    //
    // Raw count is derived from layer drop counters rather than a second
    // extraction pass. Every layer increments its own counter on drop:
    //   meta.locationDropped    (geo)
    //   meta.descriptionDropped (itemFilter)
    //   meta.expiredSkipped     (universalNormalize)
    // If a new layer is added that drops items, its counter MUST be
    // added to rawCount below or the delta display will be wrong.
    const dbgStart = Date.now();
    dbg('runSource start (full pipeline)');

    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('per-site timeout'), { __timedOut: true })), PER_SITE_TIMEOUT_MS);
    });

    let runResult;
    try {
        runResult = await Promise.race([
            runSource(name, sourceType, { withPage, progress }),
            timeoutPromise
        ]);
        clearTimeout(timer);
    } catch (e) {
        clearTimeout(timer);
        const sec = Math.round((Date.now() - t0) / 1000);
        dbg(`runSource FAILED (${sec}s): ${e && e.message}`);
        if (e && e.__timedOut) {
            emit(name, [
                'items: 0', 'rawItems: 0', 'verdict: timeout',
                'listingHits: 0', 'detailPages: 0', 'parseFailures: 0', 'looksBlocked: false',
                `duration: ${sec}s`,
                `error: per-site timeout ${PER_SITE_TIMEOUT_MS}ms`
            ]);
            // Exit cleanly (same reasoning as prior extract timeout path).
            process.exit(0);
        }
        emit(name, [
            'items: 0', 'rawItems: 0', 'verdict: parse_failed',
            'listingHits: 0', 'detailPages: 0', 'parseFailures: 0', 'looksBlocked: false',
            `duration: ${sec}s`,
            `error: ${String(e && e.message || 'unknown').replace(/\n/g, ' ')}`
        ]);
        return;
    }

    try {
        const sec = Math.round((Date.now() - t0) / 1000);
        dbg(`runSource end (${sec}s, total)`);

        const result = runResult;
        const rmeta = result.meta || {};
        const verdict = classifyOutcome(result);

        // Derive raw (pre-layer) item count from drop counters.
        const rawCount = result.items.length
            + (rmeta.locationDropped || 0)
            + (rmeta.descriptionDropped || 0)
            + (rmeta.expiredSkipped || 0);

        const lines = [
            `items: ${result.items.length}`,
            `rawItems: ${rawCount}`,
            `verdict: ${verdict.status}`,
            `listingHits: ${rmeta.listingHits || 0}`,
            `detailPages: ${rmeta.detailPagesVisited || 0}`,
            `parseFailures: ${rmeta.detailParseFailures || 0}`,
            `looksBlocked: ${rmeta.looksBlocked || false}`,
            `duration: ${sec}s`
        ];
        if (verdict.quality) {
            lines.push(`quality: ${verdict.quality}`);
            lines.push(`qualityScore: ${verdict.score}`);
            if (verdict.coverage) {
                lines.push(`coverageDesc: ${verdict.coverage.description}`);
                lines.push(`coverageLoc: ${verdict.coverage.location}`);
                lines.push(`coverageImg: ${verdict.coverage.image}`);
                lines.push(`coverageDeadline: ${verdict.coverage.deadline}`);
            }
        }
        // Per-layer drop breakdown. Only emit nonzero counters so the
        // stdout stays compact for clean sources.
        if (rmeta.locationDropped > 0) lines.push(`layerGeoDropped: ${rmeta.locationDropped}`);
        if (rmeta.descriptionDropped > 0) lines.push(`layerFilterDropped: ${rmeta.descriptionDropped}`);
        if (rmeta.expiredSkipped > 0) lines.push(`layerExpiredDropped: ${rmeta.expiredSkipped}`);
        if (rmeta.navDumpsCleared > 0) lines.push(`layerNavCleared: ${rmeta.navDumpsCleared}`);
        if (rmeta.qualLeaksCleared > 0) lines.push(`layerQualCleared: ${rmeta.qualLeaksCleared}`);
        if (rmeta.imagesEnriched > 0) lines.push(`layerImagesAdded: ${rmeta.imagesEnriched}`);
        if (rmeta.timedOut) lines.push(`timedOut: true`);

        if (result.items.length > 0) {
            lines.push('--- first 3 items ---');
            for (let j = 0; j < Math.min(3, result.items.length); j++) {
                lines.push(`[${j}] ${result.items[j].title}`);
            }
        }
        emit(name, lines);
    } catch (e) {
        // Inner try/catch tail for unexpected errors during emit processing.
        const sec = Math.round((Date.now() - t0) / 1000);
        dbg(`emit processing FAILED (${sec}s): ${e && e.message}`);
        emit(name, [
            'items: 0', 'rawItems: 0', 'verdict: parse_failed',
            'listingHits: 0', 'detailPages: 0', 'parseFailures: 0', 'looksBlocked: false',
            `duration: ${sec}s`,
            `error: ${String(e && e.message || 'unknown').replace(/\n/g, ' ')}`
        ]);
    }
}

// Warm the browser up-front so the first SITE command doesn't pay launch
// cost. This also means a broken launch (missing Chromium) fails before
// we accept the first command, and the parent sees a clean exit.
(async () => {
    try {
        await withPage(async () => { /* warm launch */ });
    } catch (e) {
        process.stderr.write(`WORKER_LAUNCH_FAILED: ${e.message}\n`);
        process.exit(1);
    }

    const rl = readline.createInterface({ input: process.stdin });
    const commandQueue = [];
    let processing = false;

    const drain = async () => {
        if (processing) return;
        processing = true;
        while (commandQueue.length > 0) {
            const line = commandQueue.shift();
            const cmd = line.trim();
            if (!cmd) continue;
            if (cmd === 'SHUTDOWN') {
                try { await closeBrowser(); } catch (_) { /* ignore */ }
                rl.close();
                process.exit(0);
            }
            const m = cmd.match(/^SITE\s+(\S+)$/);
            if (!m) {
                process.stderr.write(`WORKER_BAD_COMMAND: ${cmd}\n`);
                continue;
            }
            await runSite(m[1]);
        }
        processing = false;
    };

    rl.on('line', (line) => {
        commandQueue.push(line);
        drain();
    });
    rl.on('close', async () => {
        try { await closeBrowser(); } catch (_) { /* ignore */ }
        process.exit(0);
    });
})().catch((e) => {
    process.stderr.write(`WORKER_CRASH: ${(e && e.stack) || e}\n`);
    try { closeBrowser(); } catch (_) { /* ignore */ }
    process.exit(1);
});
