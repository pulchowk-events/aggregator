'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { BATCH_ROOT } = require('./paths');

const PENDING_REQUEST_PATH = path.join(BATCH_ROOT, '.extension-request-pending.json');

function createExtensionSync(opts = {}) {
    const markerPath = opts.markerPath || PENDING_REQUEST_PATH;
    const lockPath = `${markerPath}.lock`;

    function blockedError(message, cause) {
        const err = new Error(message);
        err.code = 'extension_request_pending';
        err.stopBatchRun = true;
        if (cause) err.cause = cause;
        return err;
    }

    function readPending() {
        if (!fs.existsSync(markerPath)) return null;
        let pending;
        try {
            pending = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        } catch (err) {
            throw blockedError(`Cannot read extension request guard at ${markerPath}; inspect it before sending more requests.`, err);
        }
        if (!pending || typeof pending !== 'object' ||
            typeof pending.requestId !== 'string' ||
            typeof pending.name !== 'string' ||
            typeof pending.operation !== 'string') {
            throw blockedError(`Extension request guard at ${markerPath} is malformed; inspect it before sending more requests.`);
        }
        return pending;
    }

    function withLock(action) {
        let fd;
        let created = false;
        try {
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            fd = fs.openSync(lockPath, 'wx');
            created = true;
            fs.writeFileSync(fd, JSON.stringify({
                pid: process.pid,
                startedAt: new Date().toISOString()
            }, null, 2));
            fs.closeSync(fd);
            fd = undefined;
        } catch (err) {
            if (fd !== undefined) {
                try { fs.closeSync(fd); } catch (closeError) { /* preserve original failure */ }
            }
            if (created && fs.existsSync(lockPath)) {
                try { fs.unlinkSync(lockPath); } catch (cleanupError) {
                    throw blockedError(`Could not persist or clean up the extension guard lock at ${lockPath}.`, cleanupError);
                }
            }
            if (err.code === 'EEXIST') {
                throw blockedError(`Another process is updating the extension request guard. If no batch process is active, inspect and remove the stale lock at ${lockPath}.`, err);
            }
            throw blockedError(`Could not acquire the extension request guard lock at ${lockPath}.`, err);
        }

        try {
            return action();
        } finally {
            fs.unlinkSync(lockPath);
        }
    }

    function describePending(pending) {
        return `Extension ${pending.operation} for "${pending.name}"` +
            `${pending.provider ? ' via ' + pending.provider : ''} may still be queued` +
            `${pending.startedAt ? ' (started ' + pending.startedAt + ')' : ''}. ` +
            'Wait until the extension queue is idle, then rerun with --resume-after-timeout to acknowledge and clear the guard. No later source was sent.';
    }

    function assertReady(resumeAfterTimeout) {
        return withLock(() => {
            const pending = readPending();
            if (!pending) return null;
            if (!resumeAfterTimeout) throw blockedError(describePending(pending));
            if (Number.isInteger(pending.pid) && pending.pid > 0) {
                try {
                    process.kill(pending.pid, 0);
                    throw blockedError(`The batch process that dispatched the pending request (PID ${pending.pid}) is still running; wait for it to exit before acknowledging the queue.`);
                } catch (err) {
                    if (err.code !== 'ESRCH' && err.code !== 'EPERM') throw err;
                    if (err.code === 'EPERM') {
                        throw blockedError(`The batch process that dispatched the pending request (PID ${pending.pid}) may still be running; verify it has exited before acknowledging the queue.`, err);
                    }
                }
            }
            try {
                fs.unlinkSync(markerPath);
            } catch (err) {
                throw blockedError(`Could not clear the extension request guard at ${markerPath}.`, err);
            }
            return pending;
        });
    }

    function beginRequest({ name, provider, operation }) {
        return withLock(() => {
            const existing = readPending();
            if (existing) throw blockedError(describePending(existing));
            const pending = {
                requestId: crypto.randomBytes(16).toString('hex'),
                pid: process.pid,
                name,
                provider,
                operation,
                startedAt: new Date().toISOString()
            };
            let fd;
            let created = false;
            try {
                fd = fs.openSync(markerPath, 'wx');
                created = true;
                fs.writeFileSync(fd, JSON.stringify(pending, null, 2));
                fs.closeSync(fd);
                return pending;
            } catch (err) {
                if (fd !== undefined) {
                    try { fs.closeSync(fd); } catch (closeError) { /* preserve original failure */ }
                }
                if (created && fs.existsSync(markerPath)) {
                    try { fs.unlinkSync(markerPath); } catch (cleanupError) {
                        throw blockedError(`Could not persist or clean up the extension request guard at ${markerPath}.`, cleanupError);
                    }
                }
                throw blockedError(`Could not persist extension request guard at ${markerPath}.`, err);
            }
        });
    }

    function completeRequest(requestId) {
        return withLock(() => {
            const pending = readPending();
            if (!pending || pending.requestId !== requestId) {
                throw blockedError('Extension request guard changed before its response was acknowledged; refusing to send another request.');
            }
            fs.unlinkSync(markerPath);
        });
    }

    return { assertReady, beginRequest, completeRequest, markerPath };
}

async function sendGuardedRequest(sync, request, send) {
    const pending = sync.beginRequest(request);
    try {
        const result = await send();
        sync.completeRequest(pending.requestId);
        return result;
    } catch (err) {
        const reason = err && (err.message || err.code) ? (err.message || err.code) : String(err);
        const failure = new Error(
            `extension ${request.operation} for "${request.name}" via ${request.provider} failed after dispatch: ` +
            `${reason}. It may still be queued. No later source was sent; confirm the extension queue is idle, ` +
            'then rerun with --resume-after-timeout to acknowledge the pending request.'
        );
        failure.code = err && err.code ? err.code : 'extension_request_uncertain';
        failure.stopBatchRun = true;
        failure.extensionRequestUncertain = true;
        failure.cause = err;
        throw failure;
    }
}

module.exports = { createExtensionSync, sendGuardedRequest, PENDING_REQUEST_PATH };
