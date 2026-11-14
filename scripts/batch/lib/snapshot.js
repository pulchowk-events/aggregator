// scripts/batch/lib/snapshot.js
// Snapshot of the committed source/extractor set, captured once at `init`
// and reused by every subsequent `discover` for that run.
//
// Why: `deriveName` currently checks the live src/scrapers/ tree to decide
// whether a name collides. That means the same URL produces different names
// on different discover runs, depending on whether a previous verify was
// interrupted (leaving orphans), or whether a batch-specific file got left
// behind. A run whose names shift between discover passes can no longer be
// resumed -- the generated/*.js, prompts/*.md, results/*.json keyed by the
// old names become orphans.
//
// Fix: freeze the "already taken" set at init time. A run's naming is
// therefore stable across any number of discover re-runs. If a site really
// needs to collide-suffix (because a real committed source shares its name),
// the suffix is decided once, at init, and holds for the run.
//
// Snapshot format (data/batch/<run>/src-snapshot.json):
//   {
//     snapshotAt: ISO8601,
//     sources:    { jobs: ["sathijob", ...], events: [...], scholarships: [...] },
//     extractors: { jobs: [...], events: [...], scholarships: [...] }
//   }
//
// The taken set for a (type) is the union of sources[type] and extractors[type].

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SRC_SOURCES = path.join(REPO, 'src', 'scrapers', 'sources');
const SRC_EXTRACTORS = path.join(REPO, 'src', 'scrapers', 'extractors');
const TYPES = ['events', 'jobs', 'scholarships'];

function listJsBasenames(dir) {
    try {
        return fs.readdirSync(dir)
            .filter((f) => f.endsWith('.js') && !f.endsWith('.batchbak'))
            .map((f) => f.slice(0, -3))
            .sort();
    } catch (e) {
        return [];
    }
}

// Capture current src/scrapers state into a snapshot object.
function captureSnapshot() {
    const sources = {};
    const extractors = {};
    for (const t of TYPES) {
        sources[t] = listJsBasenames(path.join(SRC_SOURCES, t));
        extractors[t] = listJsBasenames(path.join(SRC_EXTRACTORS, t));
    }
    return {
        snapshotAt: new Date().toISOString(),
        sources,
        extractors
    };
}

// Write snapshot to <runDir>/src-snapshot.json. Atomic.
function writeSnapshot(runDir) {
    const snap = captureSnapshot();
    const dest = path.join(runDir, 'src-snapshot.json');
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
    fs.renameSync(tmp, dest);
    return snap;
}

// Read snapshot from <runDir>. Returns null if missing (old runs, or runs
// created before this module existed).
function readSnapshot(runDir) {
    const p = path.join(runDir, 'src-snapshot.json');
    if (!fs.existsSync(p)) return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
        return null;
    }
}

// Build a Set of taken names for a given type from a snapshot. Returns
// null if snapshot is null (caller falls back to live filesystem).
function takenSetFromSnapshot(snapshot, type) {
    if (!snapshot) return null;
    const srcList = (snapshot.sources && snapshot.sources[type]) || [];
    const extList = (snapshot.extractors && snapshot.extractors[type]) || [];
    return new Set([...srcList, ...extList]);
}

module.exports = {
    captureSnapshot,
    writeSnapshot,
    readSnapshot,
    takenSetFromSnapshot,
    SRC_SOURCES,
    SRC_EXTRACTORS,
    TYPES
};
