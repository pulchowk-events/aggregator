// scripts/batch/auto.js
// One-command orchestrator. Runs the entire pipeline loop, deciding per
// site what the next action is and executing it. Only pauses for the
// human at the paste step (LLM round-trip is inherently interactive).
//
// State machine, evaluated every round:
//
//   no classes.json              -> discover
//   redirects/REDIRECT pending   -> follow
//   prompts pending paste        -> paste (interactive)
//   generated not yet verified   -> verify
//   verified pass                -> terminal (done)
//   verified fail, template-origin, attempts < cap  -> promote (write new prompt)
//   verified fail, LLM-origin,    attempts < cap    -> refine (append failure evidence)
//   verified fail, attempts >= cap                  -> terminal (given up)
//   redirects/NOT_CAREERS        -> terminal (URL not a careers page)
//   rejected at discovery        -> terminal (URL rejected)
//
// Loop breaks when: (a) every site is terminal, or (b) a full round
// produces no state change, or (c) maxRounds reached. Then runs `report`.
//
// Interrupt behaviour: Ctrl+C during paste aborts paste (loop keeps its
// state). Ctrl+C during any other step exits auto -- the run directory
// preserves state, so re-running `batch auto` picks up where it left off.
//
// Flags:
//   --run <id>          target run (default: latest)
//   --only a,b,c        restrict all phases to specific sites (dev/test)
//   --parallel <n>      verify parallelism (default 10)
//   --timeout <ms>      verify per-site timeout (default 60000)
//   --max-rounds <n>    hard cap on loop iterations (default 5)
//   --max-attempts <n>  refine/promote attempt cap per site (default 3)
//
// Uses existing phase functions directly (not subprocess-spawned) so
// state passes in-memory between phases and errors propagate cleanly.

const fs = require('fs');
const path = require('path');

const { paths, readClasses, readLatest, resolveRunDir, ensureRunLayout } = require('./lib/paths');
const { runDiscover } = require('./discover');
const { runGenerate } = require('./generate');
const { runFollow } = require('./follow');
const { runPaste } = require('./paste');
const { runVerify } = require('./verify');
const { runPromote } = require('./promote');
const { runRefine } = require('./refine');
const { runReport } = require('./report');
const ui = require('./lib/ui');

const DEFAULTS = {
    parallel: 10,
    timeoutMs: 60000,
    maxRounds: 5,
    maxAttempts: 3
};

function parseArgs(argv) {
    const args = {
        runId: null,
        only: null,
        parallel: DEFAULTS.parallel,
        timeoutMs: DEFAULTS.timeoutMs,
        maxRounds: DEFAULTS.maxRounds,
        maxAttempts: DEFAULTS.maxAttempts
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run' && argv[i + 1]) args.runId = argv[++i];
        else if (a === '--only' && argv[i + 1]) args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
        else if (a === '--parallel' && argv[i + 1]) args.parallel = Math.max(1, parseInt(argv[++i], 10) || DEFAULTS.parallel);
        else if (a === '--timeout' && argv[i + 1]) args.timeoutMs = Math.max(15000, parseInt(argv[++i], 10) || DEFAULTS.timeoutMs);
        else if (a === '--max-rounds' && argv[i + 1]) args.maxRounds = Math.max(1, parseInt(argv[++i], 10) || DEFAULTS.maxRounds);
        else if (a === '--max-attempts' && argv[i + 1]) args.maxAttempts = Math.max(1, parseInt(argv[++i], 10) || DEFAULTS.maxAttempts);
    }
    return args;
}

function pickRunDir(runId) {
    if (runId) return resolveRunDir(runId);
    const latest = readLatest();
    if (!latest) throw new Error('no --run and no latest pointer; run `batch init` first');
    return resolveRunDir(latest);
}

// Read-only snapshot of every site's current state. Used by decision
// helpers and by the per-round banner. Never mutates anything.
function computeState(runDir, only) {
    const p = paths(runDir);
    const classes = (() => {
        try { return JSON.parse(fs.readFileSync(p.classes, 'utf8')); } catch (e) { return null; }
    })() || {};
    const verifySummary = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(runDir, 'verify-summary.json'), 'utf8')); } catch (e) { return {}; }
    })() || {};

    const prompts = fs.existsSync(p.prompts)
        ? new Set(fs.readdirSync(p.prompts).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)))
        : new Set();
    const generated = fs.existsSync(p.generated)
        ? new Set(fs.readdirSync(p.generated).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)))
        : new Set();
    const redirects = (() => {
        const out = {};
        if (!fs.existsSync(p.redirects)) return out;
        for (const f of fs.readdirSync(p.redirects).filter((x) => x.endsWith('.json'))) {
            try { out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(p.redirects, f), 'utf8')); }
            catch (e) { /* skip malformed */ }
        }
        return out;
    })();

    const allNames = Object.keys(classes).filter((n) => !only || only.includes(n));

    // Per-site bucket. Single classification per site so we can count
    // and dispatch without ambiguity.
    const sites = {};
    for (const name of allNames) {
        const cls = classes[name] || {};
        const clsType = cls.classResult && cls.classResult.type;
        const rd = redirects[name];
        const rdType = rd && rd.type;
        const hasPrompt = prompts.has(name);
        const hasGenerated = generated.has(name);
        const v = verifySummary[name];

        let state;
        if (clsType === 'rejected') state = 'rejected';
        else if (clsType === 'fetch-failed') state = 'fetch-failed';
        else if (rdType === 'NOT_CAREERS_PAGE') state = 'not-careers';
        else if (rdType === 'CAREERS_PAGE_REDIRECT') state = 'needs-follow';
        else if (rdType === 'FOLLOWED' && !hasPrompt) state = 'followed-no-prompt';
        else if (hasPrompt && !hasGenerated) state = 'needs-paste';
        else if (hasGenerated && !v) state = 'needs-verify';
        else if (v && v.pass) state = 'pass';
        else if (v && !v.pass) {
            // Origin (template vs LLM) and attempt count are handled by
            // classifyFails(); this bucket is intentionally just 'fail'.
            state = 'fail';
        } else state = 'unknown';
        sites[name] = { name, state, cls, rd, verify: v || null, hasPrompt, hasGenerated };
    }
    return { classes, verifySummary, prompts, generated, redirects, sites, allNames };
}

// Small helper set. All take the state object from computeState().
const has = (state, bucket) => Object.values(state.sites).some((s) => s.state === bucket);
const collect = (state, bucket) => Object.values(state.sites).filter((s) => s.state === bucket).map((s) => s.name);

function isTemplateOrigin(site) {
    return Boolean(
        (site.cls.classResult && site.cls.classResult.template) ||
        site.cls.templatedBy
    );
}

function classifyFails(state, maxAttempts) {
    const out = { actionable: [], exhausted: [] };
    for (const s of Object.values(state.sites)) {
        if (s.state !== 'fail') continue;
        const attempts = s.cls.llmAttempts || 0;
        if (attempts >= maxAttempts) {
            out.exhausted.push(s.name);
            continue;
        }
        out.actionable.push({
            name: s.name,
            isTemplate: isTemplateOrigin(s),
            attempts,
            reason: s.verify.reason
        });
    }
    return out;
}

// Human-readable per-round banner with the full site census.
function printRoundBanner(round, state) {
    const buckets = {};
    for (const s of Object.values(state.sites)) {
        buckets[s.state] = (buckets[s.state] || 0) + 1;
    }
    ui.banner({
        title: `Batch Auto -- round ${round}`,
        sub: `${state.allNames.length} site(s) tracked`
    });
    const order = ['pass', 'needs-paste', 'needs-verify', 'needs-follow', 'followed-no-prompt', 'fail', 'not-careers', 'rejected', 'fetch-failed', 'unknown'];
    ui.blank();
    ui.info('state census:');
    for (const b of order) {
        if (buckets[b]) ui.line(`  ${String(buckets[b]).padStart(3)}  ${b}`);
    }
    ui.blank();
}

async function runAuto(opts) {
    const runDir = pickRunDir(opts.runId);
    ensureRunLayout(runDir);

    let lastStateSig = '';

    for (let round = 1; round <= opts.maxRounds; round++) {
        // --- 1. discover if this is a fresh run -----------------------
        if (!fs.existsSync(paths(runDir).classes)) {
            ui.action('no classes.json -- running discover');
            await runDiscover({ runId: opts.runId, concurrency: 15 });
        }

        let state = computeState(runDir, opts.only);
        printRoundBanner(round, state);

        // Loop detection: if state is identical to last round AND we
        // already ran promote/refine, we're stuck.
        const sig = JSON.stringify(Object.fromEntries(
            Object.entries(state.sites).map(([k, v]) => [k, v.state])
        ));
        if (sig === lastStateSig) {
            ui.warn('auto: no state change since last round -- stopping');
            break;
        }
        lastStateSig = sig;

        // --- 2. follow pending redirect verdicts (from prior round) ---
        if (has(state, 'needs-follow')) {
            ui.action(`following ${collect(state, 'needs-follow').length} pending redirect verdict(s)`);
            await runFollow({ runId: opts.runId, only: opts.only, maxHops: opts.maxAttempts });
            state = computeState(runDir, opts.only);
        }

        // --- 3. generate prompts/templates for sites without them -----
        // (Skipped when discover/generate was already done for this run
        //  and no new sites have appeared. generate is idempotent but
        //  slow, so only run when there's real work.)
        const needsGenerate = Object.values(state.sites).some((s) =>
            s.state === 'needs-paste' && !s.hasPrompt && !s.hasGenerated
        );
        // (Above condition rarely fires post-discover; generate runs
        //  in the initial pass. Kept for resume-after-interruption.)

        // --- 4. paste (interactive) ----------------------------------
        if (has(state, 'needs-paste') || has(state, 'followed-no-prompt')) {
            const pending = collect(state, 'needs-paste').concat(collect(state, 'followed-no-prompt'));
            ui.blank();
            ui.action(`${pending.length} site(s) need paste -- opening interactive loop`);
            ui.info('  (Ctrl+C during paste aborts paste but keeps the auto loop;');
            ui.info('   Ctrl+C during any other step exits auto -- re-run to resume)');
            ui.blank();
            try {
                await runPaste({
                    runId: opts.runId,
                    only: opts.only,
                    provider: 'deepseek',
                    skipBrowser: false,
                    timeoutMs: 5 * 60 * 1000,
                    usePoll: true
                });
            } catch (e) {
                // Paste threw -- likely SIGINT during the clipboard wait.
                // Fall through to next step so the loop can decide whether
                // to retry or terminate.
                ui.warn(`paste aborted: ${e.message || 'interrupted'}`);
            }
            state = computeState(runDir, opts.only);
        }

        // --- 5. verify -----------------------------------------------
        if (has(state, 'needs-verify')) {
            ui.action(`verifying ${collect(state, 'needs-verify').length} site(s)`);
            const r = await runVerify({
                runId: opts.runId,
                only: opts.only,
                parallel: opts.parallel,
                timeoutMs: opts.timeoutMs,
                keep: false
            });
            state = computeState(runDir, opts.only);
            if (r && r.error === 'no-generated-files') {
                ui.warn('auto: verify had nothing to run');
                break;
            }
        }

        // --- 6. classify fails, drive next round --------------------
        const fails = classifyFails(state, opts.maxAttempts);
        if (fails.actionable.length === 0) {
            const terminal = state.allNames.length - fails.exhausted.length;
            ui.blank();
            ui.divider('Auto complete');
            ui.blank();
            ui.ok(`all ${state.allNames.length} site(s) reached terminal state`);
            if (fails.exhausted.length > 0) {
                ui.warn(`${fails.exhausted.length} site(s) exhausted retry attempts (${opts.maxAttempts}x)`);
                for (const n of fails.exhausted) ui.plain(`  ${n}`);
            }
            ui.blank();
            break;
        }

        // Partition for promote vs refine
        const templateFails = fails.actionable.filter((f) => f.isTemplate);
        const llmFails = fails.actionable.filter((f) => !f.isTemplate);

        ui.blank();
        ui.action(`refining ${fails.actionable.length} failed site(s):`);
        if (templateFails.length > 0) {
            ui.plain(`  ${templateFails.length} template-origin -> promote`);
        }
        if (llmFails.length > 0) {
            ui.plain(`  ${llmFails.length} LLM-origin -> refine`);
        }
        ui.blank();

        if (templateFails.length > 0) {
            runPromote({
                runId: opts.runId,
                only: templateFails.map((f) => f.name),
                force: true
            });
        }
        if (llmFails.length > 0) {
            runRefine({
                runId: opts.runId,
                only: llmFails.map((f) => f.name),
                maxAttempts: opts.maxAttempts
            });
        }
        // Fall through to next round. New prompts exist; next iteration
        // hits paste, then verify again.
    }

    // --- final report -----------------------------------------------
    ui.blank();
    ui.divider('Final report');
    ui.blank();
    try {
        runReport({ runId: opts.runId, json: false, verbose: false });
    } catch (e) {
        ui.warn(`report failed: ${e.message}`);
    }

    return { ok: true };
}

module.exports = { runAuto, parseArgs };

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    runAuto(opts).catch((e) => {
        console.error('✗ auto failed:', e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    });
}
