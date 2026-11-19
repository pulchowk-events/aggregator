'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const cp = require('../maintenance/checkpoint');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

function snapshot(root) {
    const out = {};
    (function walk(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p); else out[posix(path.relative(root, p))] = sha(p);
        }
    })(root);
    return out;
}
const itemSnap = (dataDir) => Object.fromEntries(Object.entries(snapshot(dataDir)).filter(([k]) =>
    k === 'cache.json' || k === 'og-image-cache.json' || k.startsWith('posted-channel-markers/') || k.startsWith('placeholder-images/')));

function mkRepo(t) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const repoRoot = path.join(tmp, 'repo');
    const dataDir = path.join(repoRoot, 'data');
    for (const d of ['posted-channel-markers', 'placeholder-images', 'batch']) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'cache.json'), JSON.stringify({ postedEvents: ['a', 'b', 'c'], settings: { x: 1 } }));
    fs.writeFileSync(path.join(dataDir, 'og-image-cache.json'), '{"k":"v"}');
    for (const m of ['a', 'b', 'c']) fs.writeFileSync(path.join(dataDir, 'posted-channel-markers', `${m}.json`), `{"m":"${m}"}`);
    fs.writeFileSync(path.join(dataDir, 'placeholder-images', 'x.png'), Buffer.from([0, 255, 1, 254, 2, 253]));
    fs.writeFileSync(path.join(dataDir, 'audit-log.jsonl'), '{"e":1}\n');
    fs.writeFileSync(path.join(dataDir, 'batch', 'z.txt'), 'batch');
    return { tmp, repoRoot, dataDir };
}
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 10, 19, 6, 0, 0) + (tick++) * 1000);
const base = (r) => ({ dataDir: r.dataDir, repoRoot: r.repoRoot, isBotRunning: () => false });
function mutate(r) {
    fs.writeFileSync(path.join(r.dataDir, 'cache.json'), JSON.stringify({ postedEvents: ['a'], settings: { x: 2 } }));
    fs.rmSync(path.join(r.dataDir, 'posted-channel-markers', 'a.json'));
    fs.writeFileSync(path.join(r.dataDir, 'posted-channel-markers', 'd.json'), '{"m":"d"}');
    fs.rmSync(path.join(r.dataDir, 'placeholder-images', 'x.png'));
    fs.appendFileSync(path.join(r.dataDir, 'audit-log.jsonl'), '{"e":2}\n');
}

test('1. save + list shows the new checkpoint with manifest', (t) => {
    const r = mkRepo(t);
    const s = cp.saveCheckpoint({ ...base(r), name: 'base', now: clock() });
    assert.match(s.id, /^\d{8}T\d{6}Z-base$/);
    const m = JSON.parse(fs.readFileSync(path.join(s.dir, 'manifest.json'), 'utf8'));
    assert.equal(m.postedEvents, 3);
    assert.equal(m.markers, 3);
    const paths = m.files.map((f) => f.path);
    assert.ok(paths.includes('cache.json') && paths.includes('og-image-cache.json'));
    assert.ok(paths.includes('placeholder-images/x.png'));
    assert.ok(!paths.some((p) => p.startsWith('batch') || p.includes('audit-log')), 'audit-log and batch must not be saved');
    for (const f of m.files) assert.equal(sha(path.join(s.dir, 'files', f.path)), f.sha256);
    const l = cp.listCheckpoints(base(r));
    assert.equal(l.length, 1);
    assert.equal(l[0].id, s.id);
    assert.equal(l[0].markers, 3);
});

test('2. restore to saved checkpoint is byte-identical (sha256) and leaves audit-log/batch alone', (t) => {
    const r = mkRepo(t);
    const pre = itemSnap(r.dataDir);
    const s = cp.saveCheckpoint({ ...base(r), name: 'base', now: clock() });
    mutate(r);
    assert.notDeepEqual(itemSnap(r.dataDir), pre);
    const auditMutated = fs.readFileSync(path.join(r.dataDir, 'audit-log.jsonl'), 'utf8');
    const res = cp.restoreCheckpoint({ ...base(r), checkpoint: s.id, confirm: s.id, now: clock() });
    assert.equal(res.applied, true);
    assert.deepEqual(itemSnap(r.dataDir), pre);
    assert.equal(fs.readFileSync(path.join(r.dataDir, 'audit-log.jsonl'), 'utf8'), auditMutated, 'audit log is never rolled back');
    assert.ok(fs.existsSync(path.join(r.dataDir, 'batch', 'z.txt')));
    assert.deepEqual(fs.readdirSync(r.dataDir).filter((n) => /\.old-|restore-staging/.test(n)), []);
});

test('3. restore with default invocation (no --confirm) is a dry-run: mutates nothing', (t) => {
    const r = mkRepo(t);
    const s = cp.saveCheckpoint({ ...base(r), name: 'base', now: clock() });
    mutate(r);
    const before = snapshot(r.dataDir);
    const res = cp.restoreCheckpoint({ ...base(r), checkpoint: s.id, now: clock() });
    assert.equal(res.applied, false);
    assert.equal(res.dryRun, true);
    assert.ok(res.diff.wouldOverwrite.includes('cache.json'));
    assert.ok(res.diff.wouldCreate.includes('posted-channel-markers/a.json'));
    assert.ok(res.diff.wouldDelete.includes('posted-channel-markers/d.json'));
    assert.deepEqual(snapshot(r.dataDir), before);
    const res2 = cp.restoreCheckpoint({ ...base(r), checkpoint: s.id, confirm: s.id, dryRun: true, now: clock() });
    assert.equal(res2.applied, false);
    assert.deepEqual(snapshot(r.dataDir), before);
});

test('4. restore without or with wrong --confirm refuses (nonzero exit via CLI) and mutates nothing', (t) => {
    const r = mkRepo(t);
    const s = cp.saveCheckpoint({ ...base(r), name: 'base', now: clock() });
    mutate(r);
    const before = snapshot(r.dataDir);
    assert.throws(() => cp.restoreCheckpoint({ ...base(r), checkpoint: s.id, confirm: 'base', now: clock() }), (e) => e.code === 'CONFIRM_MISMATCH');
    assert.deepEqual(snapshot(r.dataDir), before);
    const script = path.join(__dirname, '..', 'maintenance', 'checkpoint.js');
    const env = { ...process.env, CHECKPOINT_REPO_ROOT: r.repoRoot };
    const noConfirm = spawnSync(process.execPath, [script, 'restore', s.id], { env, encoding: 'utf8' });
    assert.equal(noConfirm.status, 2);
    assert.match(noConfirm.stdout, /Nothing changed/);
    const wrong = spawnSync(process.execPath, [script, 'restore', s.id, '--confirm', 'nope'], { env, encoding: 'utf8' });
    assert.equal(wrong.status, 1);
    assert.deepEqual(snapshot(r.dataDir), before);
});

test('5. auto-pre-restore backup is created and matches the pre-restore state', (t) => {
    const r = mkRepo(t);
    const s = cp.saveCheckpoint({ ...base(r), name: 'base', now: clock() });
    mutate(r);
    const preRestore = itemSnap(r.dataDir);
    const res = cp.restoreCheckpoint({ ...base(r), checkpoint: s.id, confirm: s.id, now: clock() });
    const cpRoot = path.join(r.dataDir, 'checkpoints');
    const dirName = fs.readdirSync(cpRoot).find((n) => n.endsWith('-auto-pre-restore'));
    assert.ok(dirName, 'auto-pre-restore dir must exist');
    assert.equal(res.backupId, dirName);
    const dir = path.join(cpRoot, dirName);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.fromEntries(m.files.map((f) => [f.path, f.sha256])), preRestore);
    assert.doesNotThrow(() => cp.verifyCheckpoint(dir, m));
});

test('6. import from a foreign dir lands all files in a checkpoint, leaves source and live data unchanged', (t) => {
    const r = mkRepo(t);
    const foreign = path.join(r.tmp, 'foreign');
    fs.mkdirSync(path.join(foreign, 'posted-channel-markers'), { recursive: true });
    fs.writeFileSync(path.join(foreign, 'cache.json'), JSON.stringify({ postedEvents: ['z1', 'z2'] }));
    fs.writeFileSync(path.join(foreign, 'posted-channel-markers', 'm1.json'), '{"m":1}');
    fs.writeFileSync(path.join(foreign, 'posted-channel-markers', 'm2.json'), '{"m":2}');
    const old = new Date('2020-01-01T00:00:00Z');
    for (const f of ['cache.json', 'posted-channel-markers/m1.json', 'posted-channel-markers/m2.json']) fs.utimesSync(path.join(foreign, f), old, old);
    const srcBefore = snapshot(foreign);
    const mtimes = Object.fromEntries(Object.keys(srcBefore).map((k) => [k, fs.statSync(path.join(foreign, k)).mtimeMs]));
    const liveBefore = snapshot(r.dataDir);

    const imp = cp.importCheckpoint({ ...base(r), sourceDir: foreign, name: 'foreign', now: clock() });
    assert.equal(imp.manifest.files.length, 3);
    assert.equal(imp.manifest.source, 'import');
    assert.equal(imp.manifest.postedEvents, 2);
    assert.equal(imp.manifest.markers, 2);
    for (const f of imp.manifest.files) assert.equal(sha(path.join(imp.dir, 'files', f.path)), srcBefore[f.path]);
    assert.deepEqual(snapshot(foreign), srcBefore);
    for (const [k, v] of Object.entries(mtimes)) assert.equal(fs.statSync(path.join(foreign, k)).mtimeMs, v);
    const liveAfter = snapshot(r.dataDir);
    for (const k of Object.keys(liveBefore)) assert.equal(liveAfter[k], liveBefore[k], `${k} (live) must be unchanged`);
    assert.throws(() => cp.importCheckpoint({ ...base(r), sourceDir: r.dataDir, name: 'self', now: clock() }), (e) => e.code === 'DENIED');
});

test('7. deny-list blocks restore from outside repo data/checkpoints', (t) => {
    const r = mkRepo(t);
    const s = cp.saveCheckpoint({ ...base(r), name: 'base', now: clock() });
    mutate(r);
    const before = snapshot(r.dataDir);
    for (const bad of [
        '/mnt/d/Development/pulchowk-events-bot-win/data',
        '/mnt/d/Development/data',
        '/mnt/d/Development/events-bot',
        s.dir.replace(`${path.sep}checkpoints${path.sep}`, `${path.sep}elsewhere${path.sep}`),
        r.dataDir,
    ]) {
        assert.throws(() => cp.restoreCheckpoint({ ...base(r), checkpoint: bad, confirm: 'x', now: clock() }), (e) => e.code === 'DENIED' || e.code === 'NOT_FOUND', bad);
    }
    const copyOutside = path.join(r.tmp, 'outside-cp');
    fs.cpSync(s.dir, copyOutside, { recursive: true });
    assert.throws(() => cp.restoreCheckpoint({ ...base(r), checkpoint: copyOutside, confirm: s.id, now: clock() }), (e) => e.code === 'DENIED');
    assert.throws(() => cp.saveCheckpoint({ dataDir: path.join(r.tmp, 'other', 'data'), repoRoot: r.repoRoot, name: 'x' }), (e) => e.code === 'DENIED');
    assert.deepEqual(snapshot(r.dataDir), before);
});

test('8. restore from a checkpoint of a different repo state still works (no HEAD gate)', (t) => {
    const r = mkRepo(t);
    const pre = itemSnap(r.dataDir);
    const s = cp.saveCheckpoint({ ...base(r), name: 'base', now: clock() });
    const mf = path.join(s.dir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    m.gitHead = 'f'.repeat(40);
    fs.writeFileSync(mf, JSON.stringify(m, null, 2));
    mutate(r);
    const res = cp.restoreCheckpoint({ ...base(r), checkpoint: s.id, confirm: s.id, now: clock() });
    assert.equal(res.applied, true);
    assert.deepEqual(itemSnap(r.dataDir), pre);
});
