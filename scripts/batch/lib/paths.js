// scripts/batch/lib/paths.js
// Run-directory layout for the batch pipeline. One run per invocation,
// named by UTC timestamp. data/batch/latest.txt holds the most recent
// run-id so `verify`/`report` can run without the caller re-typing it.
//
// Why a run directory and not top-level files: successive batches (76
// companies today, 50 tomorrow, then 100) must not clobber each other's
// dumps, prompts, or verify results. Each run is self-contained and can be
// re-inspected or re-verified later without --recheck re-fetching anything.
//
// Layout:
//   data/batch/<run-id>/
//     urls.txt                 — input, one URL per line
//     html/<name>.html         — raw curl body (kept for reclassify)
//     dumps/<name>.json        — wizard listing dump
//     classes.json             — { <name>: classifyHtml() result + meta }
//     prompts/<name>.md        — wizard prompt for wizard-fallback sites
//     generated/<name>.js      — extractor source to be staged into src/
//     results/<name>.json      — verify outcome per source
//     report.json              — aggregate summary
//   data/batch/latest.txt      — most recent run-id
//
// data/ is gitignored. No .gitignore change required.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const BATCH_ROOT = path.join(REPO, 'data', 'batch');
const LATEST_POINTER = path.join(BATCH_ROOT, 'latest.txt');

function newRunId() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (
        d.getUTCFullYear().toString() +
        pad(d.getUTCMonth() + 1) +
        pad(d.getUTCDate()) +
        'T' +
        pad(d.getUTCHours()) +
        pad(d.getUTCMinutes()) +
        pad(d.getUTCSeconds()) +
        'Z'
    );
}

function resolveRunDir(runId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
        throw new Error(`invalid run-id "${runId}" (letters, digits, dash, underscore only)`);
    }
    return path.join(BATCH_ROOT, runId);
}

function writeLatest(runId) {
    fs.mkdirSync(BATCH_ROOT, { recursive: true });
    fs.writeFileSync(LATEST_POINTER, runId + '\n');
}

function readLatest() {
    try {
        const v = fs.readFileSync(LATEST_POINTER, 'utf8').trim();
        return v || null;
    } catch (e) {
        return null;
    }
}

// Return the concrete paths for a run. Directories are NOT created here --
// caller calls ensureRunLayout() first if it needs to write.
function paths(runDir) {
    return {
        runDir,
        urls: path.join(runDir, 'urls.txt'),
        html: path.join(runDir, 'html'),
        dumps: path.join(runDir, 'dumps'),
        classes: path.join(runDir, 'classes.json'),
        prompts: path.join(runDir, 'prompts'),
        generated: path.join(runDir, 'generated'),
        redirects: path.join(runDir, 'redirects'),
        results: path.join(runDir, 'results'),
        report: path.join(runDir, 'report.json')
    };
}

// Create every subdirectory a run may need. Idempotent -- safe to call
// from any phase. mkdir -p semantics.
function ensureRunLayout(runDir) {
    const p = paths(runDir);
    fs.mkdirSync(p.runDir, { recursive: true });
    for (const key of ['html', 'dumps', 'prompts', 'generated', 'redirects', 'results']) {
        fs.mkdirSync(p[key], { recursive: true });
    }
    return p;
}

// Convenience: read classes.json, or return empty map if not yet written.
function readClasses(runDir) {
    const p = paths(runDir);
    try {
        return JSON.parse(fs.readFileSync(p.classes, 'utf8'));
    } catch (e) {
        return null;
    }
}

// Write classes.json atomically (write temp then rename) so a crash
// mid-write doesn't leave an unparseable file. Not using lock semantics
// -- one batch runs at a time, human serializes.
function writeClasses(runDir, obj) {
    const p = paths(runDir);
    fs.mkdirSync(path.dirname(p.classes), { recursive: true });
    const tmp = p.classes + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, p.classes);
}

module.exports = {
    REPO,
    BATCH_ROOT,
    newRunId,
    resolveRunDir,
    writeLatest,
    readLatest,
    paths,
    ensureRunLayout,
    readClasses,
    writeClasses
};
