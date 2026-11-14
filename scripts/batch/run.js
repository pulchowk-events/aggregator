#!/usr/bin/env node
// scripts/batch/run.js
// One-command pipeline orchestrator. Wraps init -> discover -> generate
// -> check -> paste -> auto -> deploy -> report into a single invocation
// with per-phase checkpointing.
//
// Every phase is idempotent. Each step looks at the on-disk state and
// skips when its output already exists:
//
//   init:     skip if run-dir exists AND urls.txt matches input size
//   discover: skip if classes.json exists
//   generate: skip if every accepted site has either generated/<n>.js
//             or prompts/<n>.md (i.e., nothing left to generate)
//   check:    always runs (instant, guards against prompt drift)
//   paste:    skip if no prompts are waiting paste
//   auto:     always runs (verify + refine loop; stops when stable)
//   deploy:   skip if no passing site lacks a src/scrapers/ extractor
//   report:   always runs (final summary)
//
// This means: fresh run = full pipeline. Interrupted run = resumes from
// wherever you left off. You can re-run `batch run` as many times as you
// want; it only does the work that's still pending.
//
// Paste is the only interactive step. All other phases are unattended.

const fs = require('fs');
const path = require('path');

const { runDiscover } = require('./discover');
const { runGenerate } = require('./generate');
const { runCheck } = require('./check');
const { runPaste } = require('./paste');
const { runAuto } = require('./auto');
const { runDeploy } = require('./deploy');
const { runReport } = require('./report');

const { paths, readLatest, resolveRunDir, ensureRunLayout, newRunId, writeLatest } = require('./lib/paths');
const { writeSnapshot } = require('./lib/snapshot');
const ui = require('./lib/ui');

function parseArgs(argv) {
    const args = {
        urlsFile: null,
        runId: null,
        only: null,
        parallel: 10,
        timeoutMs: 60000,
        maxRounds: 5,
        maxAttempts: 3,
        skipDeploy: false,
        dryRun: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run' && argv[i + 1]) args.runId = argv[++i];
        else if (a === '--only' && argv[i + 1]) args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
        else if (a === '--parallel' && argv[i + 1]) args.parallel = Math.max(1, parseInt(argv[++i], 10) || 10);
        else if (a === '--timeout' && argv[i + 1]) args.timeoutMs = Math.max(15000, parseInt(argv[++i], 10) || 60000);
        else if (a === '--max-rounds' && argv[i + 1]) args.maxRounds = Math.max(1, parseInt(argv[++i], 10) || 5);
        else if (a === '--max-attempts' && argv[i + 1]) args.maxAttempts = Math.max(1, parseInt(argv[++i], 10) || 3);
        else if (a === '--skip-deploy') args.skipDeploy = true;
        else if (a === '--dry-run') args.dryRun = true;
        else if (!a.startsWith('-') && !args.urlsFile) args.urlsFile = a;
    }
    return args;
}

// ---- checkpoint helpers -------------------------------------------------
// Each returns { needed: bool, reason: string }. reason is printed on
// both "running" and "skipping" for diagnostic clarity.

function checkInit(runDir, urlsFile) {
    if (!fs.existsSync(runDir)) return { needed: true, reason: 'run dir does not exist' };
    const p = paths(runDir);
    if (!fs.existsSync(p.urls)) return { needed: true, reason: 'urls.txt missing in existing run dir' };
    if (!urlsFile) return { needed: false, reason: 'run dir + urls.txt present, no new urls file supplied' };
    try {
        const existing = fs.readFileSync(p.urls, 'utf8').split('\n').filter(Boolean).length;
        const incoming = fs.readFileSync(urlsFile, 'utf8').split('\n').filter(Boolean).length;
        if (existing !== incoming) {
            return { needed: false, reason: `existing urls.txt has ${existing} lines, incoming has ${incoming} -- keeping existing to preserve checkpoint state` };
        }
    } catch (e) { /* fall through */ }
    return { needed: false, reason: 'urls.txt present' };
}

function checkDiscover(runDir) {
    const p = paths(runDir);
    return fs.existsSync(p.classes)
        ? { needed: false, reason: 'classes.json exists' }
        : { needed: true, reason: 'classes.json missing' };
}

function checkGenerate(runDir, only) {
    const p = paths(runDir);
    const classes = (() => { try { return JSON.parse(fs.readFileSync(p.classes, 'utf8')); } catch (e) { return null; } })();
    if (!classes) return { needed: true, reason: 'classes.json missing (run discover first)' };
    const prompts = fs.existsSync(p.prompts) ? new Set(fs.readdirSync(p.prompts).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))) : new Set();
    const generated = fs.existsSync(p.generated) ? new Set(fs.readdirSync(p.generated).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3))) : new Set();
    const rejected = new Set();
    for (const [name, cls] of Object.entries(classes)) {
        if (only && !only.includes(name)) continue;
        if (cls.classResult && (cls.classResult.type === 'rejected' || cls.classResult.type === 'fetch-failed')) {
            rejected.add(name);
        }
    }
    const missing = [];
    for (const name of Object.keys(classes)) {
        if (only && !only.includes(name)) continue;
        if (rejected.has(name)) continue;
        if (!prompts.has(name) && !generated.has(name)) missing.push(name);
    }
    if (missing.length === 0) return { needed: false, reason: 'every accepted site has a prompt or extractor' };
    return { needed: true, reason: `${missing.length} site(s) still need a prompt or extractor` };
}

function checkPaste(runDir, only) {
    const p = paths(runDir);
    if (!fs.existsSync(p.prompts)) return { needed: false, reason: 'no prompts dir' };
    const prompts = fs.readdirSync(p.prompts).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    const generated = fs.existsSync(p.generated) ? new Set(fs.readdirSync(p.generated).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3))) : new Set();
    const redirects = fs.existsSync(p.redirects) ? new Set(fs.readdirSync(p.redirects).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))) : new Set();
    const pending = prompts.filter((n) => {
        if (only && !only.includes(n)) return false;
        if (generated.has(n)) return false;
        return !redirects.has(n);
    });
    if (pending.length === 0) return { needed: false, reason: 'no prompts waiting paste' };
    return { needed: true, reason: `${pending.length} prompt(s) need paste` };
}

function checkDeploy(runDir, only) {
    const p = paths(runDir);
    const summaryPath = path.join(runDir, 'verify-summary.json');
    if (!fs.existsSync(summaryPath)) return { needed: true, reason: 'no verify-summary.json yet (auto will create one)' };
    const summary = (() => { try { return JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch (e) { return null; } })();
    if (!summary) return { needed: true, reason: 'verify-summary.json unreadable' };
    const REPO = path.resolve(__dirname, '..', '..');
    const srcDir = path.join(REPO, 'src', 'scrapers', 'extractors', 'jobs');
    const existing = fs.existsSync(srcDir) ? new Set(fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3))) : new Set();
    let deployable = 0;
    for (const [name, r] of Object.entries(summary)) {
        if (only && !only.includes(name)) continue;
        if (!r.pass) continue;
        if (!fs.existsSync(path.join(p.generated, `${name}.js`))) continue;
        if (existing.has(name)) continue;
        deployable++;
    }
    if (deployable === 0) return { needed: false, reason: 'no new passing extractors to deploy' };
    return { needed: true, reason: `${deployable} site(s) to deploy into src/scrapers/` };
}

// ---- init helper --------------------------------------------------------
// Mirrors cmdInit in index.js but callable programmatically. Keeps the
// logic in one place (init on the CLI and init inside run both use it).

function runInit(urlsFile, runId) {
    const fs = require('fs');
    if (!urlsFile || !fs.existsSync(urlsFile)) {
        throw new Error(`init: urls file not found: ${urlsFile || '(none)'}`);
    }
    const finalRunId = runId || newRunId();
    const runDir = resolveRunDir(finalRunId);
    if (fs.existsSync(runDir)) {
        throw new Error(`init: run dir already exists: ${runDir}`);
    }
    const p = ensureRunLayout(runDir);
    fs.copyFileSync(urlsFile, p.urls);
    writeLatest(finalRunId);
    writeSnapshot(runDir);
    return { runId: finalRunId, runDir };
}

// ---- main orchestrator --------------------------------------------------

async function runBatch(opts) {
    // Resolve run dir BEFORE any phase. If --run given, use it (may or
    // may not exist yet). Else infer from urlsFile name or fail.
    let runDir;
    let runId;
    if (opts.runId) {
        runId = opts.runId;
        runDir = resolveRunDir(runId);
    } else if (opts.urlsFile) {
        // Derive a stable run-id from the urls filename stem.
        const stem = path.basename(opts.urlsFile, path.extname(opts.urlsFile)).replace(/[^a-zA-Z0-9_-]/g, '-');
        runId = stem || newRunId();
        runDir = resolveRunDir(runId);
    } else {
        const latest = readLatest();
        if (!latest) throw new Error('batch run: no --run, no urls file, and no latest pointer');
        runId = latest;
        runDir = resolveRunDir(runId);
    }

    ui.banner({
        title: 'Batch Run',
        sub: `run ${runId} · ${opts.skipDeploy ? 'deploy disabled' : 'deploy enabled'}`
    });

    const phases = [
        {
            name: 'init',
            check: () => checkInit(runDir, opts.urlsFile),
            exec: async () => {
                const r = runInit(opts.urlsFile, runId);
                return { ok: true, detail: `created ${r.runId}` };
            }
        },
        {
            name: 'discover',
            check: () => checkDiscover(runDir),
            exec: async () => {
                const r = await runDiscover({ runId, concurrency: 15 });
                return { ok: true, detail: `${r.actionCounts.accept} accept, ${r.actionCounts.reject} reject` };
            }
        },
        {
            name: 'generate',
            check: () => checkGenerate(runDir, opts.only),
            exec: async () => {
                const r = await runGenerate({ runId, only: opts.only, parallel: 5, timeoutSec: 120 });
                return { ok: true, detail: `${r.ats.length} template, ${r.wizard.length} prompt` };
            }
        },
        {
            name: 'check',
            check: () => ({ needed: true, reason: 'always runs (fast)' }),
            exec: async () => {
                const r = runCheck({ runId });
                return { ok: r.ok, detail: `${r.results.length} prompt(s) validated` };
            }
        },
        {
            name: 'paste',
            check: () => checkPaste(runDir, opts.only),
            exec: async () => {
                const r = await runPaste({
                    runId,
                    only: opts.only,
                    provider: 'deepseek',
                    skipBrowser: false,
                    timeoutMs: 5 * 60 * 1000,
                    usePoll: true
                });
                return { ok: r.failed === 0, detail: `${r.written} written, ${r.redirected} followed, ${r.notCareers.length} not-careers, ${r.failed} failed` };
            }
        },
        {
            name: 'auto',
            check: () => ({ needed: true, reason: 'always runs (verify loop)' }),
            exec: async () => {
                await runAuto({
                    runId,
                    only: opts.only,
                    parallel: opts.parallel,
                    timeoutMs: opts.timeoutMs,
                    maxRounds: opts.maxRounds,
                    maxAttempts: opts.maxAttempts
                });
                return { ok: true, detail: 'verify loop complete' };
            }
        },
        {
            name: 'deploy',
            check: () => opts.skipDeploy ? { needed: false, reason: '--skip-deploy' } : checkDeploy(runDir, opts.only),
            exec: async () => {
                const r = runDeploy({ runId, only: opts.only, force: false, type: 'jobs' });
                return { ok: true, detail: `${r.deployed} deployed, ${r.skipped} skipped` };
            }
        },
        {
            name: 'report',
            check: () => ({ needed: true, reason: 'always runs (summary)' }),
            exec: async () => {
                const r = runReport({ runId, json: false, verbose: false });
                return { ok: r.exitCode === 0, detail: `exitCode=${r.exitCode}` };
            }
        }
    ];

    const results = [];
    for (const phase of phases) {
        const { needed, reason } = phase.check();
        if (!needed) {
            ui.line(`  ${ui.colors.GRAY}· SKIP ${phase.name.padEnd(10)} ${reason}${ui.colors.R}`);
            results.push({ name: phase.name, ran: false, ok: true, reason });
            continue;
        }
        ui.blank();
        ui.line(`  ${ui.colors.CYAN}▸${ui.colors.R} ${ui.colors.B}RUN${ui.colors.R}  ${phase.name.padEnd(10)} ${ui.colors.GRAY}${reason}${ui.colors.R}`);
        ui.blank();
        try {
            const r = await phase.exec();
            results.push({ name: phase.name, ran: true, ok: r.ok !== false, detail: r.detail });
            ui.blank();
            ui.line(`  ${ui.tag(r.ok === false ? 'warn' : 'pass')}  ${phase.name} complete · ${r.detail}`);
            if (r.ok === false) {
                ui.warn(`  auto stopped at ${phase.name} -- fix the issue then re-run \`batch run --run ${runId}\``);
                break;
            }
        } catch (e) {
            results.push({ name: phase.name, ran: true, ok: false, error: e.message });
            ui.fail(`${phase.name} failed: ${e.message}`);
            ui.info(`  re-run \`batch run --run ${runId}\` to resume after fixing`);
            break;
        }
    }

    // Final tally.
    ui.blank();
    ui.divider('Batch run summary');
    ui.blank();
    for (const r of results) {
        const tag = r.ran ? (r.ok ? ui.tag('pass') : ui.tag('warn')) : ui.tag('skip');
        ui.line(`  ${tag}  ${r.name.padEnd(12)} ${r.detail || r.reason || r.error || ''}`);
    }
    ui.blank();

    const failed = results.filter((r) => r.ran && r.ok === false);
    return { runId, results, ok: failed.length === 0 };
}

module.exports = { runBatch, parseArgs };

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    runBatch(opts)
        .then((r) => process.exit(r.ok ? 0 : 1))
        .catch((e) => {
            console.error('✗ batch run failed:', e.message);
            if (e.stack) console.error(e.stack);
            process.exit(1);
        });
}
