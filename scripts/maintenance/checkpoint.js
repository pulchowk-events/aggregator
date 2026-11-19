#!/usr/bin/env node
// scripts/maintenance/checkpoint.js
// Save / restore / list / diff / import checkpoints of the bot's dedup state.
//
// Covered (and ONLY these): cache.json, og-image-cache.json,
// posted-channel-markers/, placeholder-images/ (if present).
// Never touched: audit-log.jsonl, batch/, checkpoints/.
//
// Library functions take explicit { dataDir, repoRoot } (no defaults) so tests
// can never reach live data. The CLI wrapper derives defaults from __dirname
// (CHECKPOINT_REPO_ROOT overrides, for tests).
//
// Layout: <dataDir>/checkpoints/<YYYYMMDDTHHMMSSZ>-<name>/{manifest.json,files/...}
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ITEMS = [
    { rel: 'cache.json', type: 'file' },
    { rel: 'og-image-cache.json', type: 'file' },
    { rel: 'posted-channel-markers', type: 'dir' },
    { rel: 'placeholder-images', type: 'dir' },
];
const CP_DIR = 'checkpoints';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_RE = /^\d{8}T\d{6}Z-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

class CheckpointError extends Error {
    constructor(code, message) { super(message); this.name = 'CheckpointError'; this.code = code; }
}

// ---------- small helpers ----------
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function realpathLoose(p) {
    let cur = path.resolve(p);
    const rest = [];
    while (!fs.existsSync(cur)) {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        rest.unshift(path.basename(cur));
        cur = parent;
    }
    let real;
    try { real = fs.realpathSync(cur); } catch (_) { real = cur; }
    return path.join(real, ...rest);
}
const norm = (p) => realpathLoose(p).replace(/[\\/]+$/, '').toLowerCase();
function isInside(child, parent) {
    const c = norm(child), p = norm(parent);
    return c === p || c.startsWith(p + path.sep) || c.startsWith(p + '/');
}

function denyPaths(repoRoot) {
    const parent = path.dirname(path.resolve(repoRoot));
    return [
        path.join(parent, 'pulchowk-events-bot-win'),
        path.join(parent, 'data'),
        path.join(parent, 'events-bot'),
        '/mnt/d/Development/pulchowk-events-bot-win',
        '/mnt/d/Development/data',
        '/mnt/d/Development/events-bot',
    ];
}
function assertNotDenied(p, repoRoot, role) {
    for (const d of denyPaths(repoRoot)) {
        if (isInside(p, d)) throw new CheckpointError('DENIED', `${role} ${p} is inside deny-listed path ${d}`);
    }
}

function layout(dataDir, repoRoot) {
    if (!dataDir || !repoRoot) throw new CheckpointError('ARGS', 'dataDir and repoRoot are required');
    const expected = path.join(path.resolve(repoRoot), 'data');
    if (norm(dataDir) !== norm(expected)) {
        throw new CheckpointError('DENIED', `dataDir ${dataDir} is not this repo's data/ (${expected})`);
    }
    assertNotDenied(dataDir, repoRoot, 'dataDir');
    return { cpRoot: path.join(path.resolve(dataDir), CP_DIR) };
}

function listFilesRec(dir, prefix) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        const rel = prefix + '/' + e.name;
        if (e.isSymbolicLink()) throw new CheckpointError('SYMLINK', `symlink refused: ${abs}`);
        if (e.isDirectory()) out.push(...listFilesRec(abs, rel));
        else if (e.isFile()) out.push({ rel, abs });
    }
    return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}
function fileEntry(abs, rel) {
    const st = fs.statSync(abs);
    return { path: rel, sha256: sha(abs), size: st.size, mtimeMs: st.mtimeMs };
}

// Inventory of the allow-listed items under `root`.
function collect(root) {
    const items = [], files = [];
    for (const it of ITEMS) {
        const abs = path.join(root, it.rel);
        let st;
        try { st = fs.lstatSync(abs); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if (st.isSymbolicLink()) throw new CheckpointError('SYMLINK', `symlink refused: ${abs}`);
        if (it.type === 'file') {
            if (!st.isFile()) throw new CheckpointError('SHAPE', `${abs} should be a file`);
            items.push(it.rel);
            files.push(fileEntry(abs, it.rel));
        } else {
            if (!st.isDirectory()) throw new CheckpointError('SHAPE', `${abs} should be a directory`);
            items.push(it.rel);
            for (const f of listFilesRec(abs, it.rel)) files.push(fileEntry(f.abs, f.rel));
        }
    }
    return { items, files };
}

function sameInventory(a, b) {
    if (a.items.join('|') !== b.items.join('|')) return false;
    if (a.files.length !== b.files.length) return false;
    const m = new Map(b.files.map((f) => [f.path, f.sha256 + ':' + f.size]));
    return a.files.every((f) => m.get(f.path) === f.sha256 + ':' + f.size);
}

function copyOut(srcRoot, entries, items, destRoot) {
    fs.mkdirSync(destRoot, { recursive: true });
    for (const it of ITEMS) {
        if (it.type === 'dir' && items.includes(it.rel)) fs.mkdirSync(path.join(destRoot, it.rel), { recursive: true });
    }
    for (const e of entries) {
        const from = path.join(srcRoot, e.path), to = path.join(destRoot, e.path);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        const t = e.mtimeMs / 1000;
        fs.utimesSync(to, t, t);
        if (sha(to) !== e.sha256) throw new CheckpointError('COPY_MISMATCH', `${e.path}: source changed during copy`);
    }
}

function postedEventsCount(cacheFile) {
    try {
        const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        const v = j && j.postedEvents;
        if (Array.isArray(v)) return v.length;
        if (v && typeof v === 'object') return Object.keys(v).length;
    } catch (_) { /* fall through */ }
    return null;
}
function gitHead(repoRoot) {
    try {
        return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch (_) { return null; }
}
const markerCount = (files) => files.filter((f) => f.path.startsWith('posted-channel-markers/')).length;

function writeManifest(dir, m) { fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2)); }
function readManifest(cpDir) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(cpDir, 'manifest.json'), 'utf8')); }
    catch (e) { throw new CheckpointError('MANIFEST', `cannot read manifest in ${cpDir}: ${e.message}`); }
    if (m.version !== 1 || !Array.isArray(m.files) || !Array.isArray(m.items)) {
        throw new CheckpointError('MANIFEST', `unsupported or corrupt manifest in ${cpDir}`);
    }
    return m;
}

function diffAgainst(root, manifest) {
    const live = collect(root);
    const inScope = (p) => manifest.items.some((i) => p === i || p.startsWith(i + '/'));
    const liveMap = new Map(live.files.filter((f) => inScope(f.path)).map((f) => [f.path, f.sha256]));
    const want = new Map(manifest.files.map((f) => [f.path, f.sha256]));
    const wouldCreate = [], wouldOverwrite = [], wouldDelete = [];
    let unchanged = 0;
    for (const [p, h] of want) {
        if (!liveMap.has(p)) wouldCreate.push(p);
        else if (liveMap.get(p) !== h) wouldOverwrite.push(p);
        else unchanged++;
    }
    for (const p of liveMap.keys()) if (!want.has(p)) wouldDelete.push(p);
    const itemsMissing = manifest.items.filter((i) => !live.items.includes(i));
    return {
        wouldCreate, wouldOverwrite, wouldDelete, unchanged, itemsMissing,
        identical: !wouldCreate.length && !wouldOverwrite.length && !wouldDelete.length && !itemsMissing.length,
    };
}

function verifyCheckpoint(cpDir, manifest) {
    const d = diffAgainst(path.join(cpDir, 'files'), manifest);
    if (!d.identical) {
        throw new CheckpointError('VERIFY_FAILED', `checkpoint ${path.basename(cpDir)} does not match its manifest ` +
            `(missing ${d.wouldCreate.length}, altered ${d.wouldOverwrite.length}, extra ${d.wouldDelete.length})`);
    }
}

function resolveCheckpoint(cpRoot, ref, repoRoot) {
    if (!ref) throw new CheckpointError('ARGS', 'checkpoint id/path required');
    const cpDir = ID_RE.test(ref) ? path.join(cpRoot, ref) : path.resolve(ref);
    assertNotDenied(cpDir, repoRoot, 'restore source');
    if (!isInside(cpDir, cpRoot) || norm(cpDir) === norm(cpRoot)) {
        throw new CheckpointError('DENIED', `restore source must be under data/checkpoints/ (got ${cpDir})`);
    }
    if (!fs.existsSync(path.join(cpDir, 'manifest.json'))) throw new CheckpointError('NOT_FOUND', `no checkpoint at ${cpDir}`);
    return cpDir;
}

function leftoverCheck(dataDir) {
    const left = fs.readdirSync(dataDir).filter((n) => /\.old-|^\.restore-staging-/.test(n));
    if (left.length) {
        throw new CheckpointError('LEFTOVER', `leftover restore artifacts in ${dataDir}: ${left.join(', ')}. ` +
            'A previous restore was interrupted - inspect them (and the auto-pre-restore checkpoint) before retrying.');
    }
}
function cleanupLeftovers(dataDir) {
    for (const n of fs.readdirSync(dataDir)) {
        if (/\.old-|^\.restore-staging-/.test(n)) fs.rmSync(path.join(dataDir, n), { recursive: true, force: true });
    }
}

// true = running, false = not running, null = cannot tell
function detectBotProcess() {
    try {
        const out = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
        return out.split('\n').some((l) => {
            const m = l.trim().match(/^(\d+)\s+(.*)$/);
            if (!m || Number(m[1]) === process.pid) return false;
            return /\bnode\b/.test(m[2]) && /\bbot\.js\b/.test(m[2]) && !/checkpoint\.js/.test(m[2]);
        });
    } catch (_) { return null; }
}

// ---------- save ----------
function saveCheckpoint({ dataDir, repoRoot, name, now = new Date(), allowEmpty = false }) {
    if (!NAME_RE.test(name || '')) throw new CheckpointError('ARGS', 'name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
    const { cpRoot } = layout(dataDir, repoRoot);
    const id = `${stamp(now)}-${name}`;
    const finalDir = path.join(cpRoot, id), partial = finalDir + '.partial';
    if (fs.existsSync(finalDir) || fs.existsSync(partial)) throw new CheckpointError('EXISTS', `checkpoint ${id} already exists`);
    const src = collect(dataDir);
    if (!src.items.length && !allowEmpty) throw new CheckpointError('EMPTY', 'nothing to save: none of the covered items exist');
    fs.mkdirSync(cpRoot, { recursive: true });
    try {
        copyOut(dataDir, src.files, src.items, path.join(partial, 'files'));
        if (!sameInventory(src, collect(dataDir))) throw new CheckpointError('SOURCE_CHANGED', 'data/ changed while saving (is the bot running?)');
        const manifest = {
            version: 1, id, name, createdAt: now.toISOString(), source: 'live', importedFrom: null,
            gitHead: gitHead(repoRoot),
            postedEvents: postedEventsCount(path.join(dataDir, 'cache.json')),
            markers: markerCount(src.files),
            items: src.items, files: src.files,
        };
        writeManifest(partial, manifest);
        fs.renameSync(partial, finalDir);
        return { id, dir: finalDir, manifest };
    } catch (e) {
        fs.rmSync(partial, { recursive: true, force: true });
        throw e;
    }
}

// ---------- import ----------
function importCheckpoint({ dataDir, repoRoot, sourceDir, name, now = new Date() }) {
    if (!NAME_RE.test(name || '')) throw new CheckpointError('ARGS', 'name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
    const { cpRoot } = layout(dataDir, repoRoot);
    const src = path.resolve(sourceDir || '');
    let st;
    try { st = fs.statSync(src); } catch (_) { throw new CheckpointError('NOT_FOUND', `import source not found: ${src}`); }
    if (!st.isDirectory()) throw new CheckpointError('ARGS', `import source is not a directory: ${src}`);
    if (isInside(src, dataDir) || isInside(dataDir, src)) {
        throw new CheckpointError('DENIED', 'import source is (or contains) this repo\'s live data/ - use save instead');
    }
    const id = `${stamp(now)}-${name}`;
    const finalDir = path.join(cpRoot, id), partial = finalDir + '.partial';
    if (fs.existsSync(finalDir) || fs.existsSync(partial)) throw new CheckpointError('EXISTS', `checkpoint ${id} already exists`);
    const pass1 = collect(src); // read-only on source
    if (!pass1.items.length) throw new CheckpointError('EMPTY', `none of the covered items exist in ${src}`);
    fs.mkdirSync(cpRoot, { recursive: true });
    try {
        copyOut(src, pass1.files, pass1.items, path.join(partial, 'files')); // re-hashes every copy
        if (!sameInventory(pass1, collect(src))) throw new CheckpointError('SOURCE_CHANGED', `source ${src} changed during import - aborted`);
        const manifest = {
            version: 1, id, name, createdAt: now.toISOString(), source: 'import', importedFrom: src,
            gitHead: null,
            postedEvents: postedEventsCount(path.join(partial, 'files', 'cache.json')),
            markers: markerCount(pass1.files),
            items: pass1.items, files: pass1.files,
        };
        writeManifest(partial, manifest);
        fs.renameSync(partial, finalDir);
        return { id, dir: finalDir, manifest };
    } catch (e) {
        fs.rmSync(partial, { recursive: true, force: true });
        throw e;
    }
}

// ---------- list / diff ----------
function listCheckpoints({ dataDir, repoRoot }) {
    const { cpRoot } = layout(dataDir, repoRoot);
    if (!fs.existsSync(cpRoot)) return [];
    const out = [];
    for (const n of fs.readdirSync(cpRoot).sort()) {
        if (!ID_RE.test(n)) continue;
        try {
            const m = readManifest(path.join(cpRoot, n));
            out.push({ id: n, name: m.name, createdAt: m.createdAt, source: m.source, gitHead: m.gitHead,
                postedEvents: m.postedEvents, markers: m.markers, files: m.files.length });
        } catch (_) { /* skip corrupt */ }
    }
    return out;
}

function diffCheckpoint({ dataDir, repoRoot, checkpoint }) {
    const { cpRoot } = layout(dataDir, repoRoot);
    const cpDir = resolveCheckpoint(cpRoot, checkpoint, repoRoot);
    const manifest = readManifest(cpDir);
    verifyCheckpoint(cpDir, manifest);
    return { id: path.basename(cpDir), diff: diffAgainst(dataDir, manifest) };
}

// ---------- restore ----------
function applyCheckpoint(dataDir, cpDir, manifest, now, tagSuffix) {
    const tag = `${stamp(now)}-${process.pid}${tagSuffix || ''}`;
    const stage = path.join(dataDir, `.restore-staging-${tag}`);
    const olds = [];
    try {
        copyOut(path.join(cpDir, 'files'), manifest.files, manifest.items, stage);
        if (!diffAgainst(stage, manifest).identical) throw new CheckpointError('VERIFY_FAILED', 'staged copy does not match manifest');
        for (const it of ITEMS) {
            if (!manifest.items.includes(it.rel)) continue; // items the checkpoint lacks are left alone
            const live = path.join(dataDir, it.rel), staged = path.join(stage, it.rel);
            if (it.type === 'file') {
                fs.renameSync(staged, live); // atomic replace
            } else {
                const old = `${live}.old-${tag}`;
                const had = fs.existsSync(live);
                if (had) fs.renameSync(live, old);
                try { fs.renameSync(staged, live); }
                catch (e) { if (had) fs.renameSync(old, live); throw e; }
                if (had) olds.push(old);
            }
        }
        if (!diffAgainst(dataDir, manifest).identical) throw new CheckpointError('VERIFY_FAILED', 'live data does not match manifest after swap');
        for (const o of olds) fs.rmSync(o, { recursive: true, force: true });
        fs.rmSync(stage, { recursive: true, force: true });
    } catch (e) {
        fs.rmSync(stage, { recursive: true, force: true });
        throw e; // any `.old-*` dirs are kept for recovery
    }
}

function restoreCheckpoint({ dataDir, repoRoot, checkpoint, confirm, dryRun = false, force = false,
    isBotRunning = detectBotProcess, now = new Date() }) {
    const { cpRoot } = layout(dataDir, repoRoot);
    const cpDir = resolveCheckpoint(cpRoot, checkpoint, repoRoot);
    const id = path.basename(cpDir);
    const manifest = readManifest(cpDir);
    verifyCheckpoint(cpDir, manifest);
    leftoverCheck(dataDir);
    const diff = diffAgainst(dataDir, manifest);

    if (dryRun || confirm === undefined || confirm === null) return { applied: false, dryRun: true, id, diff };
    if (confirm !== id) throw new CheckpointError('CONFIRM_MISMATCH', `--confirm must equal the full checkpoint id "${id}" (got "${confirm}")`);
    if (!force) {
        const running = isBotRunning(repoRoot);
        if (running !== false) {
            throw new CheckpointError('BOT_RUNNING', running === true
                ? 'a bot process appears to be running; its debounced cache saves would overwrite the restore. Stop it or pass --force.'
                : 'cannot determine whether the bot is running; pass --force to override.');
        }
    }
    const backup = saveCheckpoint({ dataDir, repoRoot, name: 'auto-pre-restore', now, allowEmpty: true });
    verifyCheckpoint(backup.dir, backup.manifest);
    try {
        applyCheckpoint(dataDir, cpDir, manifest, now, '');
    } catch (e) {
        try {
            cleanupLeftovers(dataDir);
            applyCheckpoint(dataDir, backup.dir, backup.manifest, now, '-rb');
        } catch (rbErr) {
            throw new CheckpointError('ROLLBACK_FAILED', `restore failed (${e.message}) AND rollback failed (${rbErr.message}). ` +
                `Pre-restore state is saved in ${backup.dir}`);
        }
        throw new CheckpointError('RESTORE_FAILED', `restore failed (${e.message}); rolled back to pre-restore state (backup ${backup.id})`);
    }
    return { applied: true, dryRun: false, id, diff, backupId: backup.id };
}

// ---------- CLI ----------
function summarize(diff) {
    const L = [];
    for (const k of ['wouldCreate', 'wouldOverwrite', 'wouldDelete']) {
        L.push(`${k}: ${diff[k].length}`);
        diff[k].slice(0, 15).forEach((p) => L.push('  ' + p));
        if (diff[k].length > 15) L.push(`  ... +${diff[k].length - 15} more`);
    }
    if (diff.itemsMissing.length) L.push(`itemsMissing (will be created): ${diff.itemsMissing.join(', ')}`);
    L.push(`unchanged: ${diff.unchanged}`, `identical: ${diff.identical}`);
    return L.join('\n');
}

function main(argv) {
    const repoRoot = process.env.CHECKPOINT_REPO_ROOT
        ? path.resolve(process.env.CHECKPOINT_REPO_ROOT)
        : path.resolve(__dirname, '..', '..');
    const dataDir = path.join(repoRoot, 'data');
    const pos = [];
    let confirm, force = false, dryRun = false;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--confirm') confirm = argv[++i];
        else if (argv[i] === '--force') force = true;
        else if (argv[i] === '--dry-run') dryRun = true;
        else pos.push(argv[i]);
    }
    const [cmd, a1, a2] = pos;
    const base = { dataDir, repoRoot };
    switch (cmd) {
        case 'save': { const r = saveCheckpoint({ ...base, name: a1 }); console.log(`saved ${r.id} (${r.manifest.files.length} files, postedEvents=${r.manifest.postedEvents}, markers=${r.manifest.markers})`); return 0; }
        case 'list': { const l = listCheckpoints(base); if (!l.length) console.log('(no checkpoints)'); l.forEach((c) => console.log(`${c.id}  ${c.source}  postedEvents=${c.postedEvents} markers=${c.markers} files=${c.files} head=${(c.gitHead || '-').slice(0, 7)}`)); return 0; }
        case 'diff': { const r = diffCheckpoint({ ...base, checkpoint: a1 }); console.log(`live vs ${r.id}\n${summarize(r.diff)}`); return 0; }
        case 'import': { const r = importCheckpoint({ ...base, sourceDir: a1, name: a2 }); console.log(`imported ${r.id} from ${r.manifest.importedFrom} (${r.manifest.files.length} files)`); return 0; }
        case 'restore': {
            const r = restoreCheckpoint({ ...base, checkpoint: a1, confirm, dryRun, force });
            if (r.applied) { console.log(`restored ${r.id}; previous state saved as ${r.backupId}`); return 0; }
            console.log(`DRY RUN - restore of ${r.id} would change:\n${summarize(r.diff)}`);
            if (dryRun) return 0;
            console.log(`\nNothing changed. Re-run with: restore ${r.id} --confirm ${r.id}`);
            return 2;
        }
        default:
            console.error('usage: checkpoint.js <save <name> | list | diff <id> | import <dir> <name> | restore <id> [--confirm <id>] [--dry-run] [--force]>');
            return 1;
    }
}

module.exports = {
    saveCheckpoint, restoreCheckpoint, listCheckpoints, diffCheckpoint, importCheckpoint,
    verifyCheckpoint, detectBotProcess, CheckpointError, ITEMS, stamp,
};

if (require.main === module) {
    try { process.exitCode = main(process.argv.slice(2)); }
    catch (e) { console.error('checkpoint:', e.message); process.exitCode = 1; }
}
