const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createExtensionSync, sendGuardedRequest } = require('../batch/lib/extension-sync');
const { sendWithRetry } = require('../batch/paste-extension');

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

test('guard request id is forwarded and confirmed pre-dispatch failures clear the guard', async () => {
    const markerPath = path.join(tmpDir, 'request-id.json');
    const guard = createExtensionSync({ markerPath });
    let sentId;

    await assert.rejects(() => sendGuardedRequest(guard, {
        name: 'source-five',
        provider: 'deepseek',
        operation: 'chat'
    }, async (pending) => {
        sentId = pending.requestId;
        const err = new Error('queue deadline elapsed');
        err.code = 'extension_timeout';
        err.requestId = pending.requestId;
        err.executionState = 'not_dispatched';
        err.retryable = true;
        throw err;
    }), (err) => err.executionState === 'not_dispatched' && err.requestId === sentId);

    assert.match(sentId, /^[a-f0-9]{32}$/);
    assert.equal(fs.existsSync(markerPath), false);
});

test('chat retries only confirmed-not-dispatched requests with a fresh request id', async () => {
    const markerPath = path.join(tmpDir, 'safe-retry.json');
    const guard = createExtensionSync({ markerPath });
    const ids = [];
    let attempts = 0;
    const transport = {
        async chat(request) {
            ids.push(request.requestId);
            attempts++;
            if (attempts === 1) {
                const err = new Error('extension queue expired');
                err.code = 'extension_timeout';
                err.requestId = request.requestId;
                err.executionState = 'not_dispatched';
                err.retryable = true;
                throw err;
            }
            return { content: 'ok', requestId: request.requestId };
        }
    };

    const result = await sendWithRetry(transport, guard, 'source-six', 'deepseek', 'prompt', 1000);
    assert.equal(result.content, 'ok');
    assert.equal(attempts, 2);
    assert.notEqual(ids[0], ids[1]);
    assert.equal(fs.existsSync(markerPath), false);
});

test('chat does not retry an outcome-unknown request and preserves its guard id', async () => {
    const markerPath = path.join(tmpDir, 'unknown-outcome.json');
    const guard = createExtensionSync({ markerPath });
    let attempts = 0;
    const transport = {
        async chat(request) {
            attempts++;
            const err = new Error('client wait timed out');
            err.code = 'extension_timeout';
            err.requestId = request.requestId;
            err.executionState = 'outcome_unknown';
            err.retryable = true;
            throw err;
        }
    };

    await assert.rejects(
        () => sendWithRetry(transport, guard, 'source-seven', 'qwen', 'prompt', 1000),
        (err) => err.stopBatchRun && err.executionState === 'outcome_unknown' &&
            /request [a-f0-9]{32}/.test(err.message)
    );
    assert.equal(attempts, 1);
    const pending = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.match(pending.requestId, /^[a-f0-9]{32}$/);
});

test('malformed guard state fails closed without deleting the file', () => {
    const markerPath = path.join(tmpDir, 'malformed.json');
    fs.writeFileSync(markerPath, '{invalid');
    const guard = createExtensionSync({ markerPath });

    assert.throws(() => guard.assertReady(false), (err) =>
        err.stopBatchRun && /Cannot read extension request guard/.test(err.message));
    assert.equal(fs.existsSync(markerPath), true);
});
