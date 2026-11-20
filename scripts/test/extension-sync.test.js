const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createExtensionSync, sendGuardedRequest } = require('../batch/lib/extension-sync');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-sync-'));
test.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

test('one in-flight extension request blocks concurrent sends until acknowledged', () => {
    const markerPath = path.join(tmpDir, 'pending.json');
    const first = createExtensionSync({ markerPath });
    const second = createExtensionSync({ markerPath });

    assert.equal(first.assertReady(false), null);
    const request = first.beginRequest({
        name: 'source-one',
        provider: 'chatgpt',
        operation: 'open'
    });

    assert.throws(() => second.assertReady(false), (err) =>
        err.stopBatchRun && /source-one/.test(err.message) && /--resume-after-timeout/.test(err.message));
    assert.throws(() => second.beginRequest({
        name: 'source-two',
        provider: 'chatgpt',
        operation: 'open'
    }), (err) => err.stopBatchRun);
    assert.throws(() => first.completeRequest('wrong-id'), (err) => err.stopBatchRun);
    assert.equal(fs.existsSync(markerPath), true);

    first.completeRequest(request.requestId);
    assert.equal(fs.existsSync(markerPath), false);
    assert.equal(first.assertReady(true), null);
});

test('explicit resume acknowledges and clears a stale request guard', () => {
    const markerPath = path.join(tmpDir, 'stale.json');
    const guard = createExtensionSync({ markerPath });
    const request = guard.beginRequest({
        name: 'source-two',
        provider: 'deepseek',
        operation: 'chat'
    });
    const pending = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    pending.pid = 0;
    fs.writeFileSync(markerPath, JSON.stringify(pending));

    const acknowledged = guard.assertReady(true);
    assert.equal(acknowledged.requestId, request.requestId);
    assert.equal(fs.existsSync(markerPath), false);
    assert.equal(guard.assertReady(false), null);
});

test('resume refuses to clear a request while its originating process is still alive', () => {
    const markerPath = path.join(tmpDir, 'active.json');
    const guard = createExtensionSync({ markerPath });
    guard.beginRequest({
        name: 'source-active',
        provider: 'chatgpt',
        operation: 'chat'
    });

    assert.throws(() => guard.assertReady(true), (err) =>
        err.stopBatchRun && /is still running/.test(err.message));
    assert.equal(fs.existsSync(markerPath), true);
});

test('stale guard locks fail closed without modifying the pending request', () => {
    const markerPath = path.join(tmpDir, 'locked.json');
    const guard = createExtensionSync({ markerPath });
    const pending = {
        requestId: 'stale-request',
        pid: 0,
        name: 'source-locked',
        provider: 'qwen',
        operation: 'open'
    };
    fs.writeFileSync(markerPath, JSON.stringify(pending));
    fs.writeFileSync(`${markerPath}.lock`, JSON.stringify({ pid: 0 }));

    assert.throws(() => guard.assertReady(true), (err) =>
        err.stopBatchRun && /inspect and remove the stale lock/.test(err.message));
    assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), pending);
});

test('successful dispatch clears the guard; a timed-out dispatch leaves it and stops the run', async () => {
    const markerPath = path.join(tmpDir, 'dispatch.json');
    const guard = createExtensionSync({ markerPath });
    const result = await sendGuardedRequest(guard, {
        name: 'source-three',
        provider: 'chatgpt',
        operation: 'open'
    }, async () => ({ mode: 'fresh' }));

    assert.equal(result.mode, 'fresh');
    assert.equal(fs.existsSync(markerPath), false);

    await assert.rejects(() => sendGuardedRequest(guard, {
        name: 'source-four',
        provider: 'chatgpt',
        operation: 'chat'
    }, async () => {
        const err = new Error('client timeout after 30000ms');
        err.code = 'extension_timeout';
        throw err;
    }), (err) => err.stopBatchRun && err.extensionRequestUncertain &&
        /No later source was sent/.test(err.message));

    assert.equal(fs.existsSync(markerPath), true);
    assert.throws(() => guard.assertReady(false), (err) => err.stopBatchRun);
});

test('malformed guard state fails closed without deleting the file', () => {
    const markerPath = path.join(tmpDir, 'malformed.json');
    fs.writeFileSync(markerPath, '{invalid');
    const guard = createExtensionSync({ markerPath });

    assert.throws(() => guard.assertReady(false), (err) =>
        err.stopBatchRun && /Cannot read extension request guard/.test(err.message));
    assert.equal(fs.existsSync(markerPath), true);
});
