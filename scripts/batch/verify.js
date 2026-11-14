// scripts/batch/verify.js
// Phase 3: stage generated extractors into src/scrapers/, run
// scripts/verify-source.js against each, parse the verdict, unstage.
//
// Staging is necessary because verify-source.js resolves extractors from
// src/scrapers/extractors/<type>/<name>.js on disk. The batch keeps its
// working copy in generated/<name>.js so failure never pollutes the tree.
//
// The "empty is not broken" rule (see classify.js header) lives here:
//   - verdict 'ok'                                 -> pass
//   - verdict 'empty' AND template site (ATS)       -> pass (valid API, zero rows today)
//   - verdict 'empty' AND wizard site               -> soft-warn, count as pass
//   - verdict 'blocked'                             -> fail (retry when profile configured)
//   - verdict 'dom_drift_listing'|'dom_drift_detail'-> fail
//   - verdict 'extractor_not_implemented'           -> fail (stub not replaced)
//   - verdict 'parse_failed'                        -> fail (extractor threw)
//
// A future batch adds/removes/modifies postings; verify re-run is the
// recompute step. No cross-run state to clean.
//
// Signal handling: SIGINT/SIGTERM triggers synchronous unstage of every
// file staged so far, then exit(130). Prevents a Ctrl-C from leaving
// staged files polluting src/.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { paths, readClasses, readLatest, resolveRunDir, ensureRunLayout } = require('./lib/paths');
const { audit } = require('./lib/audit');
const messages = require('./lib/messages');
const ui = require('./lib/ui');
const { Heartbeat } = require('./lib/heartbeat');
const { sourceWrapper } = require('../wizard/templates');

const REPO = path.resolve(__dirname, '..', '..');
const VERIFY_SCRIPT = path.join(REPO, 'scripts', 'verify-source.js');
const WORKER_SCRIPT = path.join(REPO, 'scripts', 'batch', 'verify-worker.js');
const SRC_SOURCES = path.join(REPO, 'src', 'scrapers', 'sources');
const SRC_EXTRACTORS = path.join(REPO, 'src', 'scrapers', 'extractors');

function parseArgs(argv) {
    const args = { runId: null, only: null, keep: false, timeoutMs: 60000, parallel: 3 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run' && argv[i + 1]) { args.runId = argv[++i]; }
        else if (a === '--only' && argv[i + 1]) { args.only = argv[++i].split(',').map((s) => s.trim()); }
        else if (a === '--keep') { args.keep = true; }
        else if (a === '--timeout' && argv[i + 1]) { args.timeoutMs = Math.max(15000, parseInt(argv[++i], 10) || 60000); }
        else if (a === '--parallel' && argv[i + 1]) { args.parallel = Math.max(1, parseInt(argv[++i], 10) || 3); }
    }
    return args;
}

function pickRunDir(runId) {
    if (runId) return resolveRunDir(runId);
    const latest = readLatest();
    if (!latest) throw new Error('no --run and no latest pointer; run discover first');
    return resolveRunDir(latest);
}

// Track staged files for cleanup on signal.
const staged = [];
function stage(name, generatedPath) {
    const sourcesDir = path.join(SRC_SOURCES, 'jobs');
    const extractorsDir = path.join(SRC_EXTRACTORS, 'jobs');
    const wrapperPath = path.join(sourcesDir, `${name}.js`);
    const extractorPath = path.join(extractorsDir, `${name}.js`);
    fs.mkdirSync(sourcesDir, { recursive: true });
    fs.mkdirSync(extractorsDir, { recursive: true });

    const entry = {
        name,
        wrapperPath,
        extractorPath,
        wrapperBackup: null,
        extractorBackup: null
    };
    if (fs.existsSync(wrapperPath)) {
        entry.wrapperBackup = wrapperPath + '.batchbak';
        fs.copyFileSync(wrapperPath, entry.wrapperBackup);
    }
    if (fs.existsSync(extractorPath)) {
        entry.extractorBackup = extractorPath + '.batchbak';
        fs.copyFileSync(extractorPath, entry.extractorBackup);
    }

    fs.writeFileSync(wrapperPath, sourceWrapper(name, 'jobs'));
    fs.copyFileSync(generatedPath, extractorPath);
    staged.push(entry);
    return entry;
}

function unstage(entry, { keepNew = false } = {}) {
    // Restore backup if there was one; otherwise remove our staged file.
    const restore = (destPath, backupPath) => {
        try {
            if (backupPath && fs.existsSync(backupPath)) {
                fs.copyFileSync(backupPath, destPath);
                fs.unlinkSync(backupPath);
            } else if (!keepNew && fs.existsSync(destPath)) {
                fs.unlinkSync(destPath);
            }
        } catch (e) { /* ignore */ }
    };
    restore(entry.wrapperPath, entry.wrapperBackup);
    restore(entry.extractorPath, entry.extractorBackup);
}

function unstageAll({ keepNew = false } = {}) {
    for (const e of staged) unstage(e, { keepNew });
    staged.length = 0;
}

// Install signal handlers once. Synchronous unstage, then exit.
let handlersInstalled = false;
function installSignalHandlers() {
    if (handlersInstalled) return;
    handlersInstalled = true;
    const shutdown = (sig) => {
        try { unstageAll(); } catch (e) { /* ignore */ }
        console.error(`\n✗ interrupted (${sig}); staged files unstaged.`);
        process.exit(sig === 'SIGINT' ? 130 : 143);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Strip ANSI color codes so regexes match values regardless of whether
// verify-source.js was invoked with color on. verify-source.js prints
// `items: \x1b[33m3\x1b[39m` -- the escape between ':' and '3' breaks a
// plain `^items: (\d+)` match, silently giving `items: null` in results.
// Stripping first is cheap and correct.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s) {
    return String(s || '').replace(ANSI_RE, '');
}

// Async spawn of verify-source.js. Returns { status, stdout, stderr,
// timedOut }. Used by the parallel pool -- spawnSync would serialize the
// whole batch because it blocks the event loop for the child's lifetime.
function spawnVerify(name, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn('node', [VERIFY_SCRIPT, name], { cwd: REPO });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }, 5000);
        }, timeoutMs);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ status: code, signal: null, stdout, stderr, timedOut });
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ status: null, signal: null, stdout, stderr, timedOut, error: err });
        });
    });
}

// Split array into N contiguous slices. Used to distribute sites across
// workers -- contiguous slices mean each worker's sites are stable and
// predictable, useful if we ever want to resume mid-batch.
function sliceArray(arr, n) {
    if (n <= 0) return [arr];
    const out = [];
    const size = Math.ceil(arr.length / n);
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

// Spawn one verify-worker.js with a slice of names. Returns when the
// worker exits or the wall-clock timeout fires. On timeout, SIGTERM then
// SIGKILL 5s later. Partial stdout is preserved (the worker emits
// delimited blocks as each site finishes, so a hung worker doesn't lose
// already-completed sites).
function spawnWorker(names, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn('node', [WORKER_SCRIPT, names.join(','), String(timeoutMs)], { cwd: REPO });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        // Worker gets a generous outer budget: N sites × per-site timeout,
        // so its own per-site timer always fires first. Outer kill is a
        // last resort for a wedged parent (signal deadlock, browser stuck
        // in closeBrowser, etc.).
        const outerTimeoutMs = timeoutMs * names.length + 30000;
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
            setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }, 5000);
        }, outerTimeoutMs);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ status: code, stdout, stderr, timedOut });
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ status: null, stdout, stderr, timedOut, error: err });
        });
    });
}

// Parse worker stdout. Worker emits:
//   ::: SITE_BEGIN <name>
//   <content lines>
//   ::: SITE_END <name>
// Each SITE_BEGIN must have a matching SITE_END. Content is whatever the
// per-site block printed (see verify-worker.js). Returns a Map of
// name -> content (unparsed; caller runs parseVerifyOutput on it).
function parseWorkerOutput(stdout) {
    const out = new Map();
    // Match "::: SITE_BEGIN name" through "::: SITE_END name" (same name
    // backreference enforced so cross-matching can't happen even if the
    // worker's own stdout contains a stray delimiter string).
    const re = /::: SITE_BEGIN (\S+)\n([\s\S]*?)::: SITE_END \1\n/g;
    let m;
    while ((m = re.exec(stdout)) !== null) {
        out.set(m[1], m[2]);
    }
    return out;
}

// Simple concurrency-limited pool. Preserves input order.
async function pool(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function worker_() {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    }
    const workers = [];
    for (let k = 0; k < Math.min(concurrency, items.length); k++) workers.push(worker_());
    await Promise.all(workers);
    return results;
}

// Parse verify-source.js stdout. Same regexes interactive.js uses.
function parseVerifyOutput(rawStdout) {
    const stdout = stripAnsi(rawStdout);
    const itemsMatch = stdout.match(/^items:\s*(\d+)/m);
    const listingHitsMatch = stdout.match(/^listingHits:\s*(\d+)/m);
    const verdictMatch = stdout.match(/^verdict:\s*(\w+)/m);
    const durMatch = stdout.match(/^duration:\s*(\d+)s/m);
    const blockedMatch = stdout.match(/^looksBlocked:\s*(true|false)/m);
    return {
        items: itemsMatch ? parseInt(itemsMatch[1], 10) : null,
        listingHits: listingHitsMatch ? parseInt(listingHitsMatch[1], 10) : null,
        verdict: verdictMatch ? verdictMatch[1] : null,
        durationSec: durMatch ? parseInt(durMatch[1], 10) : null,
        looksBlocked: blockedMatch ? blockedMatch[1] === 'true' : null
    };
}

// Decide pass/fail given verdict, whether this is an ATS template, and the
// discovery-time resolution (preflight signals + page shape).
//
// The resolution argument lets us distinguish the four root causes that
// all produce verdict `dom_drift_listing`:
//   - real selector drift (page is a listing; extractor missed items)
//   - spa-shell (page needs JS to render; extractor's initial-HTML scan
//     will never see items -- needs different fix than "update selector")
//   - unknown-shape (page didn't clearly look like a listing at discovery;
//     extractor was written against uncertain evidence)
//   - blocked (already its own verdict, but if it becomes block during
//     verify it lands here)
//
// Similarly for `empty`: a wizard extractor returning 0 on a page where
// preflight saw jobAnchors>=3 or JSON-LD JobPostings>=1 is NOT genuinely
// empty, it's a selector miss that happened to also yield empty. Flag as
// 'empty-wizard-suspicious' so the human knows diagnose is the next step.
// Read the discovery-time dump for a site to distinguish "extractor missed
// real jobs" from "site has no jobs right now". The dump's cardCandidates
// each carry jobTitleRatio (fraction of child headings with a job-role
// word). If the best candidate is < 0.3, no plausible job group existed
// at discovery time -- the site is likely empty and an extractor returning
// 0 items is correct, not broken. If any candidate >= 0.3, the dump DID
// see job content and the extractor's zero is real drift.
function loadDumpEvidence(dumpsDir, name) {
    const p = path.join(dumpsDir, `${name}.json`);
    if (!fs.existsSync(p)) return null;
    try {
        const d = JSON.parse(fs.readFileSync(p, 'utf8'));
        const cands = (d && d.listing && Array.isArray(d.listing.cardCandidates))
            ? d.listing.cardCandidates : [];
        const top = cands[0] || null;
        const maxRatio = cands.reduce((m, c) => Math.max(m, c.jobTitleRatio || 0), 0);
        return {
            hasDump: true,
            cardCandidateCount: cands.length,
            topJobTitleRatio: top ? (top.jobTitleRatio || 0) : 0,
            maxJobTitleRatio: maxRatio,
            topSelector: top ? top.selector : null
        };
    } catch (e) {
        return null;
    }
}

function decidePass(parsed, { isTemplate, isHtmlTemplate, resolution, dumpEvidence }) {
    // Precision gate: if the extractor saw N cards (listingHits) but kept
    // fewer than 1/3 as items (after its own title-vocab filter), the
    // template was matching the wrong group. This is the case where a
    // culture/values section passed hasJobishContent and then produced
    // 0-2 "job titles" that were actually marketing copy. It "passes"
    // the verdict check but produces no real jobs -- fail it explicitly.
    if (parsed.verdict === 'ok' && parsed.listingHits && parsed.listingHits > 3) {
        const kept = parsed.items || 0;
        const ratio = kept / parsed.listingHits;
        if (ratio < 0.3) {
            return {
                pass: false,
                reason: 'low_precision',
                warn: `extractor kept ${kept}/${parsed.listingHits} cards (${Math.round(ratio*100)}%) -- template matched the wrong group`
            };
        }
    }
    if (parsed.verdict === 'ok') return { pass: true, reason: 'ok' };

    if (parsed.verdict === 'empty') {
        if (isTemplate) return { pass: true, reason: 'empty-ats' };
        const sig = resolution && resolution.preflight && resolution.preflight.signals;
        const preflightSaw = sig && (sig.jobAnchors >= 3 || sig.jsonLdJobPostings >= 1);
        if (preflightSaw) {
            return {
                pass: false,
                reason: 'empty-wizard-suspicious',
                warn: `preflight saw jobAnchors=${sig.jobAnchors} jsonLdJobPostings=${sig.jsonLdJobPostings} but extractor returned 0 -- likely a selector miss, run diagnose`
            };
        }
        return { pass: true, reason: 'empty-wizard', warn: 'wizard extractor returned zero items (preflight also saw no items)' };
    }

    if (parsed.verdict === 'blocked') return { pass: false, reason: 'blocked' };

    if (parsed.verdict === 'dom_drift_listing') {
        const shape = resolution && resolution.pageShape;

        // Empty-vs-drift discrimination. Sites with zero plausible job
        // candidates in the dump AND zero items returned by the extractor
        // are almost certainly "no current postings", not broken.
        // Safety: if dump saw a real job group (max ratio >= 0.3), the
        // extractor's zero IS real drift and falls through to the existing
        // failure branches below.
        const noRealJobsInDump = dumpEvidence
            && dumpEvidence.hasDump
            && dumpEvidence.maxJobTitleRatio < 0.3;
        const extractorReportedZero = (parsed.items || 0) === 0
            && (parsed.listingHits || 0) === 0;
        if (noRealJobsInDump && extractorReportedZero) {
            return {
                pass: true,
                reason: 'empty-wizard',
                warn: `site has no visible job postings right now (discovery snapshot max jobTitleRatio=${dumpEvidence.maxJobTitleRatio.toFixed(2)})`
            };
        }

        if (shape === 'spa-shell') {
            return {
                pass: false,
                reason: 'dom_drift_spa_needs_js',
                warn: 'page is a JS-rendered shell; extractor must waitForSelector on client-rendered cards, not just initial HTML'
            };
        }
        if (shape === 'unknown') {
            return {
                pass: false,
                reason: 'dom_drift_unknown_shape',
                warn: 'page did not look like a listing at discovery time; extractor was written against uncertain evidence'
            };
        }
        return { pass: false, reason: 'dom_drift_listing' };
    }

    if (parsed.verdict === 'dom_drift_detail') return { pass: false, reason: 'dom_drift_detail' };
    if (parsed.verdict === 'extractor_not_implemented') return { pass: false, reason: 'not_implemented' };
    if (parsed.verdict === 'parse_failed') return { pass: false, reason: 'parse_failed' };
    return { pass: false, reason: parsed.verdict || 'unknown_verdict' };
}

async function runVerify(opts) {
    installSignalHandlers();

    // Sweep orphans from previous interrupted runs. A .batchbak file in
    // src/scrapers is always leftover from a previous stage() -- our own
    // staging uses them and always deletes on clean exit. Any non-.batchbak
    // orphans in jobs/ we report but don't delete, to avoid accidentally
    // removing real committed sources.
    const scanDirs = [
        path.join(SRC_EXTRACTORS, 'jobs'),
        path.join(SRC_SOURCES, 'jobs')
    ];
    const batchbakFiles = [];
    for (const dir of scanDirs) {
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.batchbak')) batchbakFiles.push(path.join(dir, f));
        }
    }
    if (batchbakFiles.length > 0) {
        console.log(`  ⚠ cleaning ${batchbakFiles.length} orphan .batchbak file(s) from a previous interrupted run`);
        for (const f of batchbakFiles) {
            try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
        }
    }


    const runDir = pickRunDir(opts.runId);
    const p = ensureRunLayout(runDir);
    const classes = readClasses(runDir) || {};

    // Enumerate generated/<name>.js.
    const genDir = p.generated;
    if (!fs.existsSync(genDir)) {
        throw new Error(`generated/ directory not found in ${runDir}; run generate first`);
    }
    let genFiles = fs.readdirSync(genDir).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)).sort();
    if (opts.only) genFiles = genFiles.filter((n) => opts.only.includes(n));

    ui.banner({
        title: 'Batch Verify',
        sub: `${genFiles.length} extractor(s) · ${opts.parallel} worker(s) · ${Math.round(opts.timeoutMs / 1000)}s timeout/site · est ~${Math.round((Math.ceil(genFiles.length / opts.parallel) * 15 + 5))}s`,
        subShort: `${genFiles.length} sites · ${opts.parallel} workers · ${Math.round(opts.timeoutMs / 1000)}s`
    });
    ui.line(`  ${ui.progressBar(0, genFiles.length)}  ${ui.colors.GRAY}starting${ui.colors.R}`);
    ui.blank();

    // Zero-generated is a loud condition, not a silent no-op. Exit non-zero
    // with a clear next-step. The old behavior printed "✓ verify complete"
    // on an empty run, which falsely reads as success.
    if (genFiles.length === 0) {
        console.error('✗ verify: no generated/<name>.js files to verify.');
        console.error('');
        console.error('  next steps:');
        console.error('    1. Run `pulchowk-events batch generate` (if not run yet)');
        console.error('    2. Run `pulchowk-events batch paste` (if prompts exist but no answers)');
        console.error('    3. Or `--only <name>` if only certain sources need verifying');
        console.error('');
        return { error: 'no-generated-files', exitCode: 1 };
    }

    const results = {};
    const start = Date.now();
    const total = genFiles.length;

    // Stage all extractors upfront.
    const entries = {};
    const stageFailed = new Set();
    for (const name of genFiles) {
        const genPath = path.join(genDir, `${name}.js`);
        try {
            entries[name] = stage(name, genPath);
        } catch (e) {
            results[name] = { name, pass: false, reason: 'stage_failed', detail: e.message };
            stageFailed.add(name);
        }
    }

    const pendingQueue = genFiles.filter((n) => !stageFailed.has(n));
    const workerCount = Math.min(opts.parallel, pendingQueue.length);
    let completed = 0;

    if (workerCount > 0) {
        ui.line(`  ${ui.colors.CYAN}▸${ui.colors.R} ${ui.colors.B}${workerCount} worker(s)${ui.colors.R} ${ui.colors.GRAY}· dynamic queue · ${pendingQueue.length} site(s) · ${Math.round(opts.timeoutMs / 1000)}s timeout/site${ui.colors.R}`);
        ui.blank();
    }

    const startWorkers = Date.now();
    const elapsed = () => ((Date.now() - startWorkers) / 1000).toFixed(1);
    const ts = () => `${ui.colors.GRAY}[+${elapsed().padStart(5)}s]${ui.colors.R}`;

    // recordSiteResult: same logic as before -- parse the emitted block,
    // decidePass, write results/<name>.json, audit, print one line.
    const recordSiteResult = (name, blockContent) => {
        const cls = classes[name];
        const isTemplate = Boolean(
            (cls && cls.classResult && cls.classResult.template)
            || (cls && cls.templatedBy)
        );
        const isHtmlTemplate = Boolean(cls && cls.templatedBy === 'html-cards-listing');

        const parsed = parseVerifyOutput(blockContent);
        let decision;
        if (['timeout', 'parse_failed', 'not_found', 'stub', 'load_failed'].includes(parsed.verdict)) {
            const errLine = (blockContent.match(/^error: (.+)$/m) || [])[1] || null;
            decision = { pass: false, reason: parsed.verdict, warn: errLine };
        } else {
            const dumpEvidence = loadDumpEvidence(path.join(runDir, 'dumps'), name);
            decision = decidePass(parsed, { isTemplate, isHtmlTemplate, resolution: cls && cls.resolution, dumpEvidence });
        }

        results[name] = {
            name,
            template: cls && cls.classResult ? cls.classResult.template : null,
            pass: decision.pass,
            // Human label instead of the raw code. "Page layout not
            // recognized" not "dom_drift_unknown_shape". Raw code still
            // in results/<name>.json for debugging.
            reason: messages.label(decision.reason),
            warn: decision.warn || null,
            verdict: parsed.verdict,
            items: parsed.items,
            durationSec: parsed.durationSec,
            exitCode: null,
            timedOut: parsed.verdict === 'timeout',
            stdoutTail: blockContent.split('\n').slice(-15).join('\n'),
            stderrTail: ''
        };

        const resPath = path.join(p.results, `${name}.json`);
        fs.writeFileSync(resPath, JSON.stringify(results[name], null, 2));

        if (decision.pass) {
            audit.verifyPass(runDir, { name, template: results[name].template, verdict: parsed.verdict, items: parsed.items, durationSec: parsed.durationSec });
        } else {
            audit.verifyFail(runDir, { name, template: results[name].template, verdict: parsed.verdict, items: parsed.items, reason: decision.reason, durationSec: parsed.durationSec });
        }

        // Note: inflight/inflightStartedAt is cleared by the caller
        // (dispatch result handler) right after this function returns.
        completed++;
        const statusTag = decision.pass ? ui.tag('pass') : ui.tag('fail');
        const itemsStr = parsed.items === null ? '?' : String(parsed.items);
        const kept = (opts.keep && decision.pass) ? ' [kept]' : '';
        const siteDur = parsed.durationSec === null ? '?' : parsed.durationSec + 's';
        const metaStr = `${itemsStr} items${kept}`;

        // Responsive result row via ui.resultRow(). At wide/medium it's
        // one line with right-aligned timing; at narrow/tiny it goes
        // multi-line with tree continuation for reason/warn. Never
        // truncates critical info.
        const rowLines = ui.resultRow({
            ts: ts(),
            tag: statusTag,
            name,
            meta: metaStr,
            right: siteDur,
            // Human label instead of the code. "No jobs right now"
            // reads better than "empty-wizard"; the raw code is still in
            // results/<name>.json for anyone debugging.
            reason: messages.label(decision.reason),
            warn: decision.warn
        });
        for (const ln of rowLines) ui.line(ln);
        ui.blank();
    };

    // Dynamic dispatch pool. N persistent workers pull from a shared
    // queue; each takes one site at a time. Fast workers process more
    // sites; a slow site only blocks its own worker.
    await new Promise((resolve) => {
        let activeWorkers = 0;
        let finishedWorkers = 0;

        const dispatch = (slot) => {
            // Worker died (SITE_END was the last thing it wrote, then it
            // exited). Skip -- the exit handler spawns a replacement.
            if (slot.dead) return;
            if (pendingQueue.length === 0) {
                try { slot.w.stdin.write('SHUTDOWN\n'); } catch (e) { /* ignore */ }
                return;
            }
            const name = pendingQueue.shift();
            slot.inflight = name;
            heartbeat.setOp(name, 'verifying');
            ui.line(`  ${ts()} ${ui.colors.CYAN}→${ui.colors.R} ${ui.colors.GRAY}dispatch${ui.colors.R} ${ui.colors.B}${name}${ui.colors.R}`);
            try {
                slot.w.stdin.write(`SITE ${name}\n`);
            } catch (e) {
                // EPIPE / socket destroyed. Worker died between the SITE_END
                // we just processed and this write. Push the name back and
                // let the exit handler spawn a replacement to retry it.
                pendingQueue.unshift(name);
                slot.inflight = null;
                slot.dead = true;
            }
        };

        const spawnReplacement = (oldSlot) => {
            if (pendingQueue.length === 0) return;
            const w = spawn('node', [WORKER_SCRIPT, String(opts.timeoutMs)], { cwd: REPO });
            const slot = { w, inflight: null };
            setupSlot(slot);
            dispatch(slot);
        };

        const setupSlot = (slot) => {
            let buf = '';
            let openName = null;
            let openBuf = '';
            let stderrBuf = '';
            slot.warm = false;

            slot.w.stdout.on('data', (chunk) => {
                buf += chunk.toString();
                while (true) {
                    if (openName === null) {
                        const m = buf.match(/::: SITE_BEGIN (\S+)\n/);
                        if (!m) break;
                        openName = m[1];
                        openBuf = '';
                        buf = buf.slice(m.index + m[0].length);
                    } else {
                        const endMarker = `::: SITE_END ${openName}\n`;
                        const pos = buf.indexOf(endMarker);
                        if (pos === -1) break;
                        openBuf += buf.slice(0, pos);
                        buf = buf.slice(pos + endMarker.length);
                        const finished = openName;
                        openName = null;
                        const content = openBuf;
                        openBuf = '';
                        slot.inflight = null;
                        heartbeat.endOp(finished);
                        recordSiteResult(finished, content);
                        dispatch(slot);
                    }
                }
            });

            slot.w.stderr.on('data', (d) => {
                stderrBuf += d.toString();
                // Forward ::: DBG lines to screen live, so user sees the
                // per-site timeline unfold instead of a silent terminal.
                const lines = stderrBuf.split('\n');
                stderrBuf = lines.pop() || '';
                for (const line of lines) {
                    const m = line.match(/^::: DBG (\S+) \+(\S+) (.+)$/);
                    if (m) {
                        ui.line(`  ${ts()} ${ui.colors.GRAY}[${m[1]}] ${m[3]}${ui.colors.R}`);
                    } else if (line.startsWith('::: DBG')) {
                        ui.line(`  ${ts()} ${ui.colors.GRAY}${line}${ui.colors.R}`);
                    }
                }
            });

            // Swallow stdin EPIPE / async error events. Without this, a
            // worker dying between SITE_END and next dispatch crashes the
            // whole verify run with an unhandled error event on the stream.
            slot.w.stdin.on('error', () => {
                slot.dead = true;
                if (slot.inflight) {
                    pendingQueue.unshift(slot.inflight);
                    slot.inflight = null;
                }
            });

            slot.w.on('exit', () => {
                slot.dead = true;
                if (slot.inflight) {
                    // Site was in flight when the worker died. End the
                    // heartbeat for it, then push back to the front of the
                    // queue so a replacement retries it.
                    heartbeat.endOp(slot.inflight);
                    pendingQueue.unshift(slot.inflight);
                    ui.line(`  ${ts()} ${ui.colors.YELLOW}!${ui.colors.R}  ${ui.colors.GRAY}worker exited mid-site (${slot.inflight}); re-queued for retry${ui.colors.R}`);
                    slot.inflight = null;
                }
                finishedWorkers++;
                if (pendingQueue.length > 0) {
                    // Spawn a replacement to keep parallelism up.
                    try { spawnReplacement(slot); } catch (_) { /* ignore */ }
                } else if (finishedWorkers >= activeWorkers) {
                    resolve();
                }
            });
        };

        const allSlots = [];
        for (let i = 0; i < workerCount; i++) {
            activeWorkers++;
            const w = spawn('node', [WORKER_SCRIPT, String(opts.timeoutMs)], { cwd: REPO });
            const slot = { w, inflight: null, warm: false };
            setupSlot(slot);
            allSlots.push(slot);
        }
        // Heartbeat: shared helper tracks in-flight sites and prints
        // status for any site running >3s. Replaces the inline setInterval
        // that used to live here -- behavior identical, but the same
        // helper is now used by generate.js and discover.js for
        // consistency across phases.
        const heartbeat = new Heartbeat({ intervalMs: 3000, minAgeMs: 3000 });
        heartbeat.onTick((ops) => {
            const parts = ops.map((op) => `${op.name} (${(op.ageMs / 1000).toFixed(1)}s)`);
            const fitted = ui.fitList(parts, { prefix: '⏱  still running: ' });
            ui.line(`  ${ts()} ${ui.colors.GRAY}${fitted}${ui.colors.R}`);
        });
        heartbeat.start();

        ui.line(`  ${ts()} ${ui.colors.GRAY}spawned ${workerCount} worker(s), dispatching ${pendingQueue.length} site(s)${ui.colors.R}`);
        ui.blank();
        for (const slot of allSlots) {
            dispatch(slot);
        }



        // Clear heartbeat when all workers done. The Promise resolve()
        // fires from the exit handler when finishedWorkers >= activeWorkers.
        const origResolve = resolve;
        // eslint-disable-next-line no-func-assign
        resolve = (...args) => {
            heartbeat.stop();
            origResolve(...args);
        };

        // If workerCount is 0 (all stage-failed), resolve immediately.
        if (workerCount === 0) resolve();
    });

    const workerWallSec = ((Date.now() - startWorkers) / 1000).toFixed(1);
    ui.blank();
    ui.line(`  ${ui.colors.GRAY}workers finished in ${workerWallSec}s${ui.colors.R}`);

    // Unstage everything.
    for (const name of Object.keys(entries)) {
        const entry = entries[name];
        const r = results[name];
        const shouldKeep = opts.keep && r && r.pass;
        unstage(entry, { keepNew: shouldKeep });
        const idx = staged.indexOf(entry);
        if (idx !== -1) staged.splice(idx, 1);
    }

    // Aggregate summary.
    const pass = Object.values(results).filter((r) => r.pass).length;
    const fail = Object.values(results).filter((r) => !r.pass).length;

    ui.blank();
    ui.divider('Summary');
    ui.blank();
    const headline = fail === 0 ? ui.tag('pass') : ui.tag('warn');
    ui.line(`  ${headline}  verify complete in ${((Date.now() - start) / 1000).toFixed(0)}s`);
    ui.blank();
    ui.summary([
        ['pass', pass === genFiles.length ? `${pass} (all)` : String(pass)],
        ['fail', fail > 0 ? `${fail} -- see failures below` : '0']
    ]);
    if (fail > 0) {
        ui.blank();
        ui.info('failures:');
        for (const r of Object.values(results).filter((x) => !x.pass)) {
            const sev = messages.severity(r.reason);
            const fTag = sev === 'warn' ? ui.tag('warn') : ui.tag('fail');
            const msg = messages.lookup(r.reason);
            ui.line(`    ${fTag}  ${ui.colors.B}${r.name.padEnd(22)}${ui.colors.R}  ${ui.colors.GRAY}${msg.label}${ui.colors.R}`);
            // Multi-line: explanation and (if available) fix.
            // messages.render returns label + explanation + fix; we already
            // printed the label, so slice it off and render the rest.
            const detailed = messages.render(r.reason, { indent: 4, includeExplanation: true, includeFix: true, prefix: '' });
            const lines = detailed.split('\n').slice(1);
            for (const el of lines) {
                ui.line(`  ${ui.colors.GRAY}${el}${ui.colors.R}`);
            }
        }
    }
    ui.blank();

    // Also write a combined report so report.js can read one file.
    fs.writeFileSync(path.join(runDir, 'verify-summary.json'), JSON.stringify(results, null, 2));

    // Propagate hard-failure state to caller AND exit code. Any failure ->
    // non-zero, so shell chains (verify && paste || refine) behave as
    // expected. Previously returned exit 0 even when sites failed, meaning
    // `verify && x || y` always ran x -- silent error.
    const failedCount = Object.values(results).filter((r) => !r.pass).length;
    if (failedCount > 0) process.exitCode = 1;
    return { results, failedCount, passCount: Object.keys(results).length - failedCount };
}

module.exports = { runVerify, parseArgs, parseVerifyOutput, decidePass };

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    runVerify(opts).catch((e) => {
        try { unstageAll(); } catch (_) { /* ignore */ }
        console.error('✗ verify failed:', e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    });
}
