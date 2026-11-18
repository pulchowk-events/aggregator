'use strict';
// Bug 5: auditLog must never drop an entry because JSON.stringify threw.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ser-'));
const AUDIT_FILE = path.join(tmpDir, 'audit-log.jsonl');
process.env.AUDIT_FILE = AUDIT_FILE; // must be set before require (read at load)

const { auditLog, AUDIT_LOG_FILE } = require('../../src/core/auditLogger');

beforeEach(() => {
    fs.writeFileSync(AUDIT_FILE, '');
});

function quiet(t) {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'warn', () => {});
}

function readLines() {
    return fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
}

test('harness writes to the temp AUDIT_FILE, not data/', () => {
    assert.equal(AUDIT_LOG_FILE, path.resolve(AUDIT_FILE));
});

test('circular errorRaw: entry is written and errorRaw is preserved', (t) => {
    quiet(t);
    const err = new Error('boom');
    err.code = 50013;
    err.self = err;
    err.nested = { back: err };
    auditLog('discord_api_error', 'send failed', { channelId: '1', errorRaw: err }, 'error');

    const lines = readLines();
    assert.equal(lines.length, 1, 'circular errorRaw: expected exactly 1 audit line, got ' + lines.length);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.category, 'discord_api_error');
    assert.equal(parsed.data.channelId, '1');
    assert.equal(parsed.data.errorRaw.message, 'boom');
    assert.equal(parsed.data.errorRaw.code, 50013);
    assert.equal(parsed.data.errorRaw.self, '[Circular]');
    assert.equal(parsed.data.errorRaw.nested.back, '[Circular]');
});

test('BigInt in payload: entry is written with the value as a string', (t) => {
    quiet(t);
    auditLog('post_outcome', 'bigint payload', { count: 10n, ok: true });

    const lines = readLines();
    assert.equal(lines.length, 1, 'BigInt: expected exactly 1 audit line, got ' + lines.length);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.data.count, '10');
    assert.equal(parsed.data.ok, true);
});

test('throwing getter: degraded line is written with envelope intact', (t) => {
    quiet(t);
    const data = { channelId: '1' };
    Object.defineProperty(data, 'bad', {
        enumerable: true,
        get() { throw new Error('getter exploded'); }
    });
    auditLog('post_outcome', 'getter payload', data, 'error');

    const lines = readLines();
    assert.equal(lines.length, 1, 'throwing getter: expected exactly 1 audit line, got ' + lines.length);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.serializationFailed, true);
    assert.equal(parsed.category, 'post_outcome');
    assert.equal(parsed.message, 'getter payload');
    assert.equal(parsed.level, 'error');
    assert.match(parsed.serializationError, /getter exploded/);
});

test('plain entry: output is byte-identical to JSON.stringify(entry) + newline', (t) => {
    quiet(t);
    const entry = auditLog('post_outcome', 'ok', { a: 1, b: [1, 2], c: { d: 'caf\u00e9' } });
    const raw = fs.readFileSync(AUDIT_FILE, 'utf8');
    assert.equal(raw, JSON.stringify(entry) + '\n');
});
