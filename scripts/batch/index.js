// scripts/batch/index.js
// Top-level batch dispatcher. Subcommands:
//
//   init       -- create a new run directory, seed urls.txt from a file
//   discover   -- fetch + classify every URL
//   generate   -- render ATS templates / write wizard prompts
//   verify     -- stage + run verify-source.js + unstage
//   report     -- aggregate, print table, write report.json
//   status     -- show current run state (a quick report without verify)
//
// Usage:
//   pulchowk-events batch init <file> [--run <id>]
//   pulchowk-events batch discover [--run <id>] [--concurrency 5]
//   pulchowk-events batch generate [--run <id>] [--only name1,name2]
//   pulchowk-events batch verify  [--run <id>] [--only name1,name2] [--keep]
//   pulchowk-events batch report  [--run <id>] [--json] [-v]
//
// One run per invocation of `init`. `--run <id>` picks a specific run;
// without it, each subcommand resolves the most recent via latest.txt.
//
// Contract guarantees:
//   - verify never leaves staged files in src/ on any exit path
//     (including SIGINT; see verify.js)
//   - a source that classifies to an ATS template and currently returns
//     zero postings is a PASS (empty is not broken)
//   - re-running discover/generate/verify is idempotent -- each run dir
//     is self-contained, no cross-run state
//   - adding sites later = new `init` + repeat; adding sites inside an
//     existing run = append to urls.txt + re-run discover onward

const fs = require('fs');
const path = require('path');

const {
    BATCH_ROOT,
    newRunId,
    resolveRunDir,
    writeLatest,
    paths,
    ensureRunLayout
} = require('./lib/paths');
const { runDiscover, parseArgs: parseDiscoverArgs } = require('./discover');
const { runGenerate, parseArgs: parseGenerateArgs } = require('./generate');
const { runVerify, parseArgs: parseVerifyArgs } = require('./verify');
const { runReport, parseArgs: parseReportArgs } = require('./report');
const { runCheck, parseArgs: parseCheckArgs } = require('./check');
const { writeSnapshot } = require('./lib/snapshot');
const { runPaste, parseArgs: parsePasteArgs } = require('./paste');
const { runFollow, parseArgs: parseFollowArgs } = require('./follow');
const { runRefine, parseArgs: parseRefineArgs } = require('./refine');
const { runAuto, parseArgs: parseAutoArgs } = require('./auto');
const { runDeploy, parseArgs: parseDeployArgs } = require('./deploy');
const { runBatch, parseArgs: parseBatchArgs } = require('./run');
const { runPromote, parseArgs: parsePromoteArgs } = require('./promote');

const C = (code) => (process.stdout.isTTY ? `\x1b[${code}m` : '');
const R = C('0'), B = C('1'), D = C('2');
const CYAN = C('36'), GREEN = C('32'), YELLOW = C('33'), RED = C('31');

function printHelp() {
    console.log('');
    console.log(`${B}pulchowk-events batch${R} ${D}-- add many sources in one run${R}`);
    console.log('');
    console.log(`${B}USAGE${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} batch <command> [options]`);
    console.log('');
    console.log(`${B}COMMANDS${R}`);
    console.log(`  ${CYAN}init${R} <file>       Create a new run. <file> is one URL per line.`);
    console.log(`  ${CYAN}discover${R}          Fetch and classify every URL.`);
    console.log(`  ${CYAN}generate${R}          Render ATS templates, write wizard prompts.`);
    console.log(`  ${CYAN}verify${R}            Stage + run verify-source.js + unstage.`);
    console.log(`  ${CYAN}report${R}            Print a table of pass/fail/blocked.`);
    console.log(`  ${CYAN}check${R}             Validate prompt structure (guards against wizard-template drift).`);
    console.log(`  ${CYAN}paste${R}             Interactive loop: copy prompt, paste LLM reply, write extractor.`);
    console.log(`  ${CYAN}follow${R}            Follow CAREERS_PAGE_REDIRECT verdicts (re-dump, re-prompt).`);
    console.log(`  ${CYAN}refine${R}            Re-prompt LLM-origin failed sites with verify failure evidence.`);
    console.log(`  ${CYAN}auto${R}              One-shot: discover -> generate -> paste -> verify -> refine, loops until stable.`);
    console.log(`  ${CYAN}deploy${R}            Copy verified-passing extractors into src/scrapers/ for production.`);
    console.log(`  ${CYAN}run${R} <urls>        One-shot: all phases with checkpointing -- the recommended entry point.`);
    console.log(`  ${CYAN}promote${R}           Promote template-failed sites to LLM prompts (dump-reuse, no re-scrape).`);
    console.log(`  ${CYAN}status${R}            Quick view of current run state (no verify).`);
    console.log(`  ${CYAN}help${R}              This help.`);
    console.log('');
    console.log(`${B}COMMON FLAGS${R}`);
    console.log(`  ${D}--run <id>${R}       Use a specific run instead of the latest.`);
    console.log(`  ${D}--only name1,name2${R} Limit generate/verify to specific sources.`);
    console.log(`  ${D}--json${R}            Machine-readable report output (report subcommand).`);
    console.log(`  ${D}-v, --verbose${R}     Extra detail per source (report subcommand).`);
    console.log('');
    console.log(`${B}EXAMPLE${R}`);
    console.log(`  ${D}# 76-company run, end-to-end${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} batch init /tmp/companies.txt`);
    console.log(`  ${CYAN}pulchowk-events${R} batch discover`);
    console.log(`  ${CYAN}pulchowk-events${R} batch generate`);
    console.log(`  ${CYAN}pulchowk-events${R} batch check      ${D}# validate prompt structure${R}`);
    console.log(`  ${D}# ... paste each prompts/*.md into DeepSeek, save reply as generated/<name>.js${R}`);
    console.log(`  ${CYAN}pulchowk-events${R} batch verify`);
    console.log(`  ${CYAN}pulchowk-events${R} batch report`);
    console.log('');
}

// `init` -- create run dir, seed urls.txt. Returns runId.
function cmdInit(argv) {
    const urlsFile = argv[0];
    if (!urlsFile || urlsFile.startsWith('-')) {
        console.error(`${RED}✗ batch init${R}: missing <file>`);
        console.error(`   usage: ${CYAN}pulchowk-events${R} batch init <url-file> [--run <id>]`);
        return 1;
    }
    if (!fs.existsSync(urlsFile)) {
        console.error(`${RED}✗ batch init${R}: file not found: ${urlsFile}`);
        return 1;
    }

    let runId = null;
    for (let i = 1; i < argv.length; i++) {
        if (argv[i] === '--run' && argv[i + 1]) runId = argv[++i];
    }
    if (!runId) runId = newRunId();

    let runDir;
    try {
        runDir = resolveRunDir(runId);
    } catch (e) {
        console.error(`${RED}✗ batch init${R}: ${e.message}`);
        return 1;
    }
    if (fs.existsSync(runDir)) {
        console.error(`${RED}✗ batch init${R}: run dir already exists: ${runDir}`);
        console.error(`   pick a different --run id, or delete the existing dir first`);
        return 1;
    }

    const p = ensureRunLayout(runDir);
    fs.copyFileSync(urlsFile, p.urls);
    writeLatest(runId);

    // Freeze src/scrapers state at init time so naming is stable across
    // every subsequent discover re-run for this run-id. Without this,
    // orphans left by an interrupted verify shift names mid-batch and
    // orphan the already-generated files keyed by old names.
    const snapshot = writeSnapshot(runDir);
    const snapshotCount = Object.values(snapshot.sources).reduce((a, b) => a + b.length, 0)
        + Object.values(snapshot.extractors).reduce((a, b) => a + b.length, 0);

    const urls = fs.readFileSync(p.urls, 'utf8').split('\n').filter((l) => l.trim());
    console.log('');
    console.log(`${GREEN}✓ batch init${R} -- new run created`);
    console.log(`  run-id:  ${B}${runId}${R}`);
    console.log(`  run-dir: ${runDir}`);
    console.log(`  urls:    ${urls.length} line(s) from ${urlsFile}`);
    console.log(`  snapshot: ${snapshotCount} committed file(s) frozen at init`);
    console.log('');
    console.log(`  next: ${CYAN}pulchowk-events batch discover${R}`);
    console.log('');
    return 0;
}

// `status` -- read-only snapshot without running verify.
function cmdStatus(argv) {
    let runId = null;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--run' && argv[i + 1]) runId = argv[++i];
    }
    const { readLatest } = require('./lib/paths');
    if (!runId) runId = readLatest();
    if (!runId) {
        console.error(`${RED}✗ batch status${R}: no active run; start with \`batch init\``);
        return 1;
    }
    let runDir;
    try {
        runDir = resolveRunDir(runId);
    } catch (e) {
        console.error(`${RED}✗ batch status${R}: ${e.message}`);
        return 1;
    }
    if (!fs.existsSync(runDir)) {
        console.error(`${RED}✗ batch status${R}: run dir missing: ${runDir}`);
        return 1;
    }
    const p = paths(runDir);

    const urlsCount = (() => { try { return fs.readFileSync(p.urls, 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; } })();
    const classes = (() => { try { return JSON.parse(fs.readFileSync(p.classes, 'utf8')); } catch (e) { return null; } })();
    const genCount = (() => { try { return fs.readdirSync(p.generated).filter((f) => f.endsWith('.js')).length; } catch (e) { return 0; } })();
    const promptsCount = (() => { try { return fs.readdirSync(p.prompts).filter((f) => f.endsWith('.md')).length; } catch (e) { return 0; } })();
    const resCount = (() => { try { return fs.readdirSync(p.results).filter((f) => f.endsWith('.json')).length; } catch (e) { return 0; } })();
    const hasReport = fs.existsSync(p.report);

    console.log('');
    console.log(`${B}batch status${R}  run-id: ${CYAN}${runId}${R}`);
    console.log(`  run-dir:     ${runDir}`);
    console.log(`  urls:        ${urlsCount}`);
    console.log(`  classes:     ${classes ? Object.keys(classes).length + ' classified' : D + 'not run' + R}`);
    console.log(`  generated:   ${genCount} extractor(s)`);
    console.log(`  prompts:     ${promptsCount} prompt(s) waiting for LLM answers`);
    console.log(`  results:     ${resCount} verify result(s)`);
    console.log(`  report:      ${hasReport ? GREEN + 'yes' + R : D + 'no' + R}`);

    if (classes) {
        const counts = {};
        for (const v of Object.values(classes)) {
            const t = v.classResult ? v.classResult.type : 'unknown';
            counts[t] = (counts[t] || 0) + 1;
        }
        console.log('');
        console.log('  classification:');
        for (const [t, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
            console.log(`    ${String(n).padStart(3)}  ${t}`);
        }
    }

    console.log('');
    return 0;
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
        printHelp();
        return 0;
    }
    const sub = argv[0];
    const rest = argv.slice(1);

    switch (sub) {
        case 'init':     return cmdInit(rest);
        case 'status':   return cmdStatus(rest);

        case 'discover': {
            const opts = parseDiscoverArgs(rest);
            return runDiscover(opts).then(() => 0).catch((e) => {
                console.error(`${RED}✗ discover failed:${R} ${e.message}`);
                return 1;
            });
        }
        case 'generate': {
            const opts = parseGenerateArgs(rest);
            return runGenerate(opts).then(() => 0).catch((e) => {
                console.error(`${RED}✗ generate failed:${R} ${e.message}`);
                return 1;
            });
        }
        case 'verify': {
            const opts = parseVerifyArgs(rest);
            return runVerify(opts)
                .then((r) => (r && r.failedCount > 0) ? 1 : 0)
                .catch((e) => {
                    console.error(`${RED}✗ verify failed:${R} ${e.message}`);
                    return 1;
                });
        }
        case 'promote': {
            const opts = parsePromoteArgs(rest);
            try {
                const r = runPromote(opts);
                return r.promoted >= 0 ? 0 : 1;
            } catch (e) {
                console.error(`${RED}✗ promote failed:${R} ${e.message}`);
                return 1;
            }
        }
        case 'run': {
            const opts = parseBatchArgs(rest);
            return runBatch(opts).then((r) => (r.ok ? 0 : 1)).catch((e) => {
                console.error(`${RED}\u2717 run failed:${R} ${e.message}`);
                return 1;
            });
        }
        case 'deploy': {
            const opts = parseDeployArgs(rest);
            try {
                const r = runDeploy(opts);
                return r.deployed >= 0 ? 0 : 1;
            } catch (e) {
                console.error(`${RED}\u2717 deploy failed:${R} ${e.message}`);
                return 1;
            }
        }
        case 'auto': {
            const opts = parseAutoArgs(rest);
            return runAuto(opts).then(() => 0).catch((e) => {
                console.error(`${RED}✗ auto failed:${R} ${e.message}`);
                return 1;
            });
        }
        case 'refine': {
            const opts = parseRefineArgs(rest);
            try {
                const r = runRefine(opts);
                // Return 1 only when the refine itself crashed. Sites that
                // exhausted attempts are a "nothing more to do for that site"
                // outcome -- refine still succeeded at its job. Otherwise
                // `|| (refine && paste && verify)` would stop on a site that
                // simply hit its cap.
                return r && r.error ? 1 : 0;
            } catch (e) {
                console.error(`${RED}✗ refine failed:${R} ${e.message}`);
                return 1;
            }
        }
        case 'follow': {
            const opts = parseFollowArgs(rest);
            return runFollow(opts)
                .then((r) => (r && r.failed > 0) ? 1 : 0)
                .catch((e) => {
                    console.error(`${RED}✗ follow failed:${R} ${e.message}`);
                    return 1;
                });
        }
        case 'paste': {
            const opts = parsePasteArgs(rest);
            return runPaste(opts).then(() => 0).catch((e) => {
                console.error(`${RED}✗ paste failed:${R} ${e.message}`);
                return 1;
            });
        }
        case 'check': {
            const opts = parseCheckArgs(rest);
            try {
                const r = runCheck(opts);
                return r.ok ? 0 : 1;
            } catch (e) {
                console.error(`${RED}✗ check failed:${R} ${e.message}`);
                return 1;
            }
        }
        case 'report': {
            const opts = parseReportArgs(rest);
            try {
                const r = runReport(opts);
                return r.exitCode;
            } catch (e) {
                console.error(`${RED}✗ report failed:${R} ${e.message}`);
                return 1;
            }
        }
        default:
            console.error(`${RED}✗ unknown batch command:${R} "${sub}"`);
            console.error(`   run ${CYAN}pulchowk-events batch help${R} for the list`);
            return 1;
    }
}

// main() may return a number (sync) or a Promise<number> (async subcommand).
// Wrap so process.exit fires with the right code either way.
Promise.resolve(main())
    .then((code) => process.exit(typeof code === 'number' ? code : 0))
    .catch((e) => {
        console.error(`${RED}✗ batch crashed:${R} ${e.message}`);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    });

module.exports = { main, printHelp };
