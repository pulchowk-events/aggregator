// scripts/batch/deploy.js
// Copy verified-passing extractors from generated/ into src/scrapers/
// and write the matching thin wrapper in sources/. The deploy step
// turns "the batch verified N sites" into "the bot can actually scrape
// them at next restart".
//
// What it does per site:
//   1. Read verify-summary.json. Skip sites that did not pass.
//   2. Copy generated/<name>.js -> src/scrapers/extractors/jobs/<name>.js
//   3. Write src/scrapers/sources/jobs/<name>.js via the wizard's
//      sourceWrapper() template (the standard 5-line wrapper).
//
// Safety:
//   - Refuses to overwrite existing committed extractors unless --force.
//     A site already in src/ means a human committed it deliberately;
//     silently rewriting would clobber their work.
//   - Validates extractor parses via `node --check` before writing.
//     A malformed file should never reach src/.
//   - Dry-run by default? No. Deploy is the point -- but it prints a
//     summary of what it will do, then does it. No confirmation prompt;
//     the git diff after is the review.
//   - Reports which sites were skipped (already exist) vs deployed.
//
// After deploy, this module prints the exact `git add` command to stage
// the new files. It does NOT run git itself -- that's the human's step.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { paths, readLatest, resolveRunDir, ensureRunLayout } = require('./lib/paths');
const { sourceWrapper } = require('../wizard/templates');
const ui = require('./lib/ui');

const REPO = path.resolve(__dirname, '..', '..');
const SRC_SOURCES = path.join(REPO, 'src', 'scrapers', 'sources', 'jobs');
const SRC_EXTRACTORS = path.join(REPO, 'src', 'scrapers', 'extractors', 'jobs');

function parseArgs(argv) {
    const args = { runId: null, only: null, force: false, type: 'jobs' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run' && argv[i + 1]) { args.runId = argv[++i]; }
        else if (a === '--only' && argv[i + 1]) { args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); }
        else if (a === '--force') { args.force = true; }
        else if (a === '--type' && argv[i + 1]) { args.type = argv[++i]; }
    }
    return args;
}

function pickRunDir(runId) {
    if (runId) return resolveRunDir(runId);
    const latest = readLatest();
    if (!latest) throw new Error('no --run and no latest pointer; run discover first');
    return resolveRunDir(latest);
}

// Parse-check the extractor via `node --check`. Returns { ok, reason }.
function validateExtractorSyntax(filePath) {
    const r = spawnSync('node', ['--check', filePath], { encoding: 'utf8', timeout: 10000 });
    if (r.status === 0) return { ok: true };
    const msg = (r.stderr || r.stdout || 'syntax error').split('\n').slice(0, 2).join(' ').trim();
    return { ok: false, reason: msg };
}

function runDeploy(opts) {
    const runDir = pickRunDir(opts.runId);
    const p = ensureRunLayout(runDir);
    const type = opts.type;
    if (type !== 'jobs' && type !== 'events' && type !== 'scholarships') {
        throw new Error(`invalid --type "${type}"; expected jobs|events|scholarships`);
    }

    // Read summary.
    const summaryPath = path.join(runDir, 'verify-summary.json');
    if (!fs.existsSync(summaryPath)) {
        throw new Error(`verify-summary.json not found in ${runDir}; run \`batch verify\` first`);
    }
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));

    // Target dirs -- type-specific.
    const srcSourcesDir = path.join(REPO, 'src', 'scrapers', 'sources', type);
    const srcExtractorsDir = path.join(REPO, 'src', 'scrapers', 'extractors', type);
    fs.mkdirSync(srcSourcesDir, { recursive: true });
    fs.mkdirSync(srcExtractorsDir, { recursive: true });

    ui.banner({
        title: 'Batch Deploy',
        sub: `run ${path.basename(runDir)} · type ${type}`
    });

    // Partition: passing with a generated file, passing without, not
    // passing, already-deployed.
    const deployable = [];
    const missingGenerated = [];
    const notPassing = [];
    const alreadyExists = [];

    for (const [name, r] of Object.entries(summary)) {
        if (opts.only && !opts.only.includes(name)) continue;
        if (!r.pass) { notPassing.push(name); continue; }
        const genPath = path.join(p.generated, `${name}.js`);
        if (!fs.existsSync(genPath)) { missingGenerated.push(name); continue; }
        const extractorDest = path.join(srcExtractorsDir, `${name}.js`);
        const wrapperDest = path.join(srcSourcesDir, `${name}.js`);
        if ((fs.existsSync(extractorDest) || fs.existsSync(wrapperDest)) && !opts.force) {
            alreadyExists.push(name);
            continue;
        }
        deployable.push({ name, genPath, extractorDest, wrapperDest, items: r.items || 0, reason: r.reason });
    }

    ui.info(`passing: ${Object.values(summary).filter((x) => x.pass).length} / ${Object.keys(summary).length}`);
    if (deployable.length > 0) ui.info(`  deployable: ${deployable.length}`);
    if (alreadyExists.length > 0) ui.info(`  skipped (already in src/): ${alreadyExists.length} -- use --force to overwrite`);
    if (missingGenerated.length > 0) ui.info(`  skipped (no generated file): ${missingGenerated.length}`);
    if (notPassing.length > 0) ui.info(`  skipped (did not pass verify): ${notPassing.length}`);
    ui.blank();

    if (deployable.length === 0) {
        ui.warn('nothing to deploy');
        ui.blank();
        return { deployed: 0, skipped: alreadyExists.length + missingGenerated.length + notPassing.length };
    }

    // Deploy with syntax validation.
    let deployed = 0;
    let failedSyntax = 0;
    for (const d of deployable) {
        const check = validateExtractorSyntax(d.genPath);
        if (!check.ok) {
            ui.fail(`${d.name.padEnd(22)} syntax: ${check.reason}`);
            failedSyntax++;
            continue;
        }
        try {
            fs.copyFileSync(d.genPath, d.extractorDest);
            fs.writeFileSync(d.wrapperDest, sourceWrapper(d.name, type));
            ui.ok(`${d.name.padEnd(22)} ${String(d.items).padStart(3)} items · ${d.reason === 'empty-wizard' ? 'empty-pass' : 'ok'}`);
            deployed++;
        } catch (e) {
            ui.fail(`${d.name.padEnd(22)} copy failed: ${e.message}`);
        }
    }

    // Summary + next-step command.
    ui.blank();
    ui.divider('Summary');
    ui.blank();
    ui.summary([
        ['deployed', `${deployed} / ${deployable.length}`],
        ['syntax rejected', String(failedSyntax)],
        ['already present', String(alreadyExists.length)],
        ['not passing', String(notPassing.length)]
    ]);
    ui.blank();

    if (deployed > 0) {
        ui.action('next: review + commit the deployed sources');
        ui.plain('');
        ui.plain('  git status src/scrapers/');
        ui.plain(`  git add src/scrapers/extractors/${type}/ src/scrapers/sources/${type}/`);
        ui.plain(`  git commit -m "feat(scrapers): add ${deployed} batch-generated ${type} source(s) from ${path.basename(runDir)}"`);
        ui.plain('');
        ui.plain('  then restart the bot on the prod host so it picks up the new sources');
    }
    ui.blank();

    return { deployed, skipped: alreadyExists.length + missingGenerated.length + notPassing.length, failedSyntax };
}

module.exports = { runDeploy, parseArgs };

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    try {
        runDeploy(opts);
    } catch (e) {
        console.error('✗ deploy failed:', e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    }
}
