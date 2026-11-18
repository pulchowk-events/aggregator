'use strict';
// Bug 7: auditLogger must warn once at load when AUDIT_FILE redirects audit writes.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'src', 'core', 'auditLogger.js');
const DEFAULT_PATH = path.resolve(__dirname, '..', '..', 'data', 'audit-log.jsonl');
const MARKER = 'AUDIT_FILE is set';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-warn-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// Spawn a fresh node process that requires the module. auditFile === undefined
// means AUDIT_FILE is removed from the child env entirely.
function runChild(auditFile, extraScript) {
    const env = { ...process.env };
    delete env.AUDIT_FILE;
    if (auditFile !== undefined) env.AUDIT_FILE = auditFile;
    const script = 'const m = require(' + JSON.stringify(MODULE_PATH) + ');' + (extraScript || '');
    return spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
}

function countMarker(stderr) {
    return stderr.split(MARKER).length - 1;
}

test('AUDIT_FILE set: exactly one warning naming resolved and default paths; load writes no file', () => {
    const file = path.join(tmpDir, 'set.jsonl');
    const r = runChild(file);
    assert.equal(r.status, 0, 'child exited ' + r.status + ': ' + r.stderr);
    assert.equal(countMarker(r.stderr), 1, 'expected 1 "' + MARKER + '" warning on stderr, got ' + countMarker(r.stderr) + ' (stderr: ' + JSON.stringify(r.stderr) + ')');
    assert.ok(r.stderr.includes(path.resolve(file)), 'warning must name the resolved AUDIT_FILE');
    assert.ok(r.stderr.includes(DEFAULT_PATH), 'warning must name the default path');
    assert.equal(fs.existsSync(file), false, 'module load must not create the redirected file');
});

test('AUDIT_FILE set: warning fires once at load, not per write', () => {
    const file = path.join(tmpDir, 'perwrite.jsonl');
    const r = runChild(file, "m.auditLog('t', 'one'); m.auditLog('t', 'two'); m.auditLog('t', 'three');");
    assert.equal(r.status, 0, 'child exited ' + r.status + ': ' + r.stderr);
    assert.equal(countMarker(r.stderr), 1, 'expected 1 "' + MARKER + '" warning across 3 writes, got ' + countMarker(r.stderr));
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3, 'expected 3 audit lines in the redirected file, got ' + lines.length);
});

test('AUDIT_FILE unset: no warning', () => {
    const r = runChild(undefined);
    assert.equal(r.status, 0, 'child exited ' + r.status + ': ' + r.stderr);
    assert.equal(countMarker(r.stderr), 0, 'unexpected warning when AUDIT_FILE is unset: ' + r.stderr);
});

test('AUDIT_FILE empty string: no warning', () => {
    const r = runChild('');
    assert.equal(r.status, 0, 'child exited ' + r.status + ': ' + r.stderr);
    assert.equal(countMarker(r.stderr), 0, 'unexpected warning when AUDIT_FILE is empty: ' + r.stderr);
});
