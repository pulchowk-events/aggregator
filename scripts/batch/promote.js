// scripts/batch/promote.js
// Promote template-failed sites back to LLM prompts. Reads the saved dump
// for each failed template site, rebuilds the wizard prompt from it, and
// writes prompts/<name>.md. No browser, no re-scrape -- the dump already
// exists from the generate phase.
//
// This closes the P10 loop: template-first, LLM-fallback. A site whose
// template didn't work (verify marked templatedBy but failed, OR the
// template was generated but the site didn't match the card-group shape
// the heuristic expected) gets a prompt just like a site the wizard never
// templated. The human's paste experience is identical either way.
//
// Idempotent: re-running only re-writes prompts for sites that (a) still
// have templatedBy set, (b) don't already have a prompt, (c) still lack
// a passing verify result.

const fs = require('fs');
const path = require('path');

const { paths, readClasses, readLatest, resolveRunDir, ensureRunLayout } = require('./lib/paths');
const { buildPrompt } = require('../wizard/prompt');
const ui = require('./lib/ui');

function parseArgs(argv) {
    const args = { runId: null, only: null, force: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run' && argv[i + 1]) { args.runId = argv[++i]; }
        else if (a === '--only' && argv[i + 1]) { args.only = argv[++i].split(',').map((s) => s.trim()); }
        else if (a === '--force') { args.force = true; }
    }
    return args;
}

function pickRunDir(runId) {
    if (runId) return resolveRunDir(runId);
    const latest = readLatest();
    if (!latest) throw new Error('no --run and no latest pointer; run discover first');
    return resolveRunDir(latest);
}

function loadVerifySummary(runDir) {
    const p = path.join(runDir, 'verify-summary.json');
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function runPromote(opts) {
    const runDir = pickRunDir(opts.runId);
    const p = ensureRunLayout(runDir);
    const classes = readClasses(runDir) || {};
    const verifySummary = loadVerifySummary(runDir);

    // Candidates: templatedBy set, dump exists, no prompt yet (unless
    // --force overwrites an existing prompt).
    const candidates = [];
    for (const [name, entry] of Object.entries(classes)) {
        if (!entry.templatedBy) continue;
        if (opts.only && !opts.only.includes(name)) continue;

        const dumpPath = path.join(p.dumps, `${name}.json`);
        if (!fs.existsSync(dumpPath)) {
            ui.warn(`${name}: no dump found at dumps/${name}.json -- skipping`);
            continue;
        }

        const verifyResult = verifySummary ? verifySummary[name] : null;
        const passing = verifyResult && verifyResult.pass;
        const promptPath = path.join(p.prompts, `${name}.md`);
        const hasPrompt = fs.existsSync(promptPath);

        if (passing && !opts.force) {
            // Template passed -- no need to promote.
            continue;
        }
        if (hasPrompt && !opts.force) {
            // Prompt already exists -- another run wrote it, don't clobber.
            continue;
        }
        candidates.push({ name, entry, dumpPath, promptPath, verifyResult });
    }

    ui.banner({
        title: 'Batch Promote (template-fail → LLM prompt)',
        sub: `${candidates.length} site(s) to promote`
    });

    if (candidates.length === 0) {
        ui.info('nothing to promote -- all templated sites either pass verify or already have prompts');
        ui.blank();
        return { promoted: 0 };
    }

    let promoted = 0;
    for (const c of candidates) {
        const dump = JSON.parse(fs.readFileSync(c.dumpPath, 'utf8'));
        const targetUrl = c.entry.targetUrl || c.entry.url;
        const type = 'jobs';

        const promptBody = buildPrompt({
            name: c.name,
            type,
            url: targetUrl,
            listing: dump.listing,
            detail: dump.detail || null,
            detected: dump.detected || { type: 'unknown', signals: {}, evidence: {} }
        });

        fs.writeFileSync(c.promptPath, promptBody);

        // Delete the broken template's generated file. Otherwise `paste`
        // sees hasGenerated=true, skips the site as "already present", and
        // the old failing extractor gets re-verified. Promote's whole job
        // is "this template failed, LLM takes over" -- the template output
        // must go.
        const genPath = path.join(p.generated, `${c.name}.js`);
        if (fs.existsSync(genPath)) fs.unlinkSync(genPath);

        // Clear templatedBy so the next generate run doesn't re-template
        // (which would delete the working prompt). After a promote, the
        // site's authoritative path is LLM. If the user wants to retry
        // templating later, they can --force regenerate.
        delete c.entry.templatedBy;
        delete c.entry.wizardDetectedType;

        const reason = c.verifyResult ? c.verifyResult.reason : 'no verify result';
        ui.line(`  ${ui.tag('pass')}  ${c.name.padEnd(22)}  (was: ${reason})  → prompts/${c.name}.md (${(promptBody.length / 1024).toFixed(1)} KB)`);
        promoted++;
    }

    // Persist classes with templatedBy cleared.
    const { writeClasses } = require('./lib/paths');
    writeClasses(runDir, classes);

    ui.blank();
    ui.ok(`${promoted} prompt(s) written -- run \`pulchowk-events batch paste\``);
    ui.blank();

    return { promoted };
}

module.exports = { runPromote, parseArgs };

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    try {
        runPromote(opts);
    } catch (e) {
        ui.fail(`promote failed: ${e.message}`);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    }
}
