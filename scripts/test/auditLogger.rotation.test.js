'use strict';
// Bug 6: concurrent appenders must not lose lines when the log rotates.
// The live file is pre-seeded just past the real 5 MB cap so rotation fires
// on the first write; N forked children then append M uniquely numbered lines.
// This file re-runs itself as the child when AUDIT_ROT_CHILD is set.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('node:child_process');

const N = 8;
const M = 50;
const MODULE_PATH = path.resolve(__dirname, '..', '..', 'src', 'core', 'auditLogger.js');

if (process.env.AUDIT_ROT_CHILD) {
    const { auditLog } = require(MODULE_PATH);
    const k = Number(process.env.AUDIT_ROT_CHILD) - 1;
    for (let i = 1; i <= M; i++) {
        auditLog('rot_test', 'append', { id: k * M + i, pad: 'p'.repeat(120) });
    }
    process.exit(0);
}

const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rot-'));
const LIVE = path.join(tmpDir, 'audit-log.jsonl');
let runPromise = null;

// ~5.6 MB of valid lines: just over the 5 MB cap, under the 5000-line cap.
function seedLive() {
    const lines = [];
    for (let i = 0; i < 1400; i++) {
        lines.push(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', category: 'rot_seed', message: 'seed', data: { seed: i, pad: 's'.repeat(3900) } }));
    }
    fs.writeFileSync(LIVE, lines.join('\n') + '\n');
}

function runChild(k) {
    return new Promise((resolve, reject) => {
        const env = { ...process.env, AUDIT_FILE: LIVE, AUDIT_ROT_CHILD: String(k + 1) };
        delete env.NODE_TEST_CONTEXT;
        const c = fork(__filename, [], { env, execArgv: [], silent: true });
        let err = '';
        c.stdout.resume();
        c.stderr.on('data', (d) => { err += d; });
        c.on('error', reject);
        c.on('exit', (code) => resolve({ k, code, err }));
    });
}

function runAll() {
    if (!runPromise) {
        seedLive();
        runPromise = Promise.all(Array.from({ length: N }, (_, k) => runChild(k)));
    }
    return runPromise;
}

// Live file plus any rotated sibling (audit-log.<something>.jsonl).
function auditFiles() {
    return fs.readdirSync(tmpDir)
        .filter((f) => f.startsWith('audit-log') && f.endsWith('.jsonl'))
        .map((f) => path.join(tmpDir, f));
}

function scan() {
    const bad = [];
    const objs = [];
    for (const f of auditFiles()) {
        for (const line of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
            try { objs.push(JSON.parse(line)); } catch (e) { bad.push(path.basename(f) + ': ' + line.slice(0, 60)); }
        }
    }
    return { bad, objs };
}

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('all children exit cleanly', { timeout: 120000 }, async () => {
    const results = await runAll();
    for (const r of results) assert.equal(r.code, 0, 'child ' + r.k + ' exited ' + r.code + ': ' + r.err);
});

test('every line in the live file and every rotated sibling parses', { timeout: 120000 }, async () => {
    await runAll();
    const { bad } = scan();
    assert.equal(bad.length, 0, bad.length + ' unparsable line(s), first: ' + bad[0]);
});

test('every id 1..N*M appears exactly once across all files', { timeout: 120000 }, async () => {
    await runAll();
    const seen = new Map();
    for (const o of scan().objs) {
        if (o.category === 'rot_test' && o.data) seen.set(o.data.id, (seen.get(o.data.id) || 0) + 1);
    }
    const total = N * M;
    const missing = [];
    const dupes = [];
    for (let id = 1; id <= total; id++) {
        const c = seen.get(id) || 0;
        if (c === 0) missing.push(id);
        if (c > 1) dupes.push(id);
    }
    assert.equal(missing.length, 0, 'lost ' + missing.length + ' of ' + total + ' lines, first missing ids: ' + missing.slice(0, 5).join(','));
    assert.equal(dupes.length, 0, dupes.length + ' duplicated id(s), first: ' + dupes.slice(0, 5).join(','));
});
