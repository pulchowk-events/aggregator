// scripts/batch/check.js
// Run the structural validator over every prompt in a batch run. Catches
// wizard-prompt drift before the human pastes 70 of them into an LLM.
//
// Exit 0 if all prompts pass. Exit 1 if any prompt fails structure. A
// malformed prompt does not abort the batch -- `paste` will refuse that
// one item, but the rest continue. `check` is the human-facing heads-up.

const fs = require('fs');
const path = require('path');

const { paths, readLatest, resolveRunDir } = require('./lib/paths');
const { validatePromptFile } = require('./lib/prompt-structure');

function parseArgs(argv) {
    const args = { runId: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run' && argv[i + 1]) { args.runId = argv[++i]; }
    }
    return args;
}

function pickRunDir(runId) {
    if (runId) return resolveRunDir(runId);
    const latest = readLatest();
    if (!latest) throw new Error('no --run and no latest pointer; run discover first');
    return resolveRunDir(latest);
}

function runCheck(opts) {
    const runDir = pickRunDir(opts.runId);
    const p = paths(runDir);

    if (!fs.existsSync(p.prompts)) {
        console.log(`  no prompts/ in ${runDir}; nothing to validate.`);
        return { ok: true, results: [] };
    }
    const prompts = fs.readdirSync(p.prompts).filter((f) => f.endsWith('.md')).sort();

    console.log('');
    console.log(`▶ check: ${prompts.length} prompt(s) in ${runDir}`);
    console.log('');

    const results = [];
    let fail = 0;
    for (const f of prompts) {
        const name = f.slice(0, -3);
        let r;
        try {
            r = validatePromptFile(path.join(p.prompts, f));
        } catch (e) {
            r = { ok: false, path: f, reasons: ['read failed: ' + e.message], sections: {} };
        }
        results.push({ name, ...r });
        if (r.ok) {
            console.log(`  ✓ ${name.padEnd(22)}  ok`);
        } else {
            fail++;
            console.log(`  ✗ ${name.padEnd(22)}  FAIL`);
            for (const reason of r.reasons) {
                console.log(`      - ${reason}`);
            }
        }
    }

    console.log('');
    if (fail === 0) {
        console.log(`✓ all ${prompts.length} prompt(s) structurally valid`);
    } else {
        console.log(`✗ ${fail} prompt(s) failed structural validation`);
        console.log(`  likely cause: scripts/wizard/prompt.js was edited and the`);
        console.log(`  REQUIRED_SECTIONS / REQUIRED_OUTPUT_PHRASE in`);
        console.log(`  scripts/batch/lib/prompt-structure.js were not updated.`);
        console.log(`  Fix the template OR the validator, in the same commit.`);
    }
    console.log('');

    return { ok: fail === 0, results };
}

module.exports = { runCheck, parseArgs };

if (require.main === module) {
    try {
        const opts = parseArgs(process.argv.slice(2));
        const r = runCheck(opts);
        process.exit(r.ok ? 0 : 1);
    } catch (e) {
        console.error('✗ check failed:', e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    }
}
