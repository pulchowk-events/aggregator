'use strict';
// src/core/instaLoginRunner.js
// Spawn wrapper around scripts/insta-login.js plus a cookie-file checker.
// No Discord dependency, so it is testable with a mocked child_process.spawn.
// Never logs or returns cookie values.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const COOKIE_FILE = path.join(REPO_ROOT, 'data', 'instagram', 'cookies.json');
const SCRIPT_REL = 'scripts/insta-login.js'; // relative: resolves under both Linux node and Windows node.exe
const WIN_NODE = '/mnt/c/Program Files/nodejs/node.exe';
const REQUIRED = ['sessionid', 'csrftoken', 'ds_user_id'];
const LOGIN_TIMEOUT_S = 300;
const LOGIN_KILL_MS = 330000;
const VERIFY_KILL_MS = 90000;
const DAY_MS = 24 * 3600 * 1000;

let active = null;
const isBusy = () => active !== null;
function killActive() {
    if (active) { try { active.kill(); } catch (e) { /* already gone */ } }
}
// /shutdown calls process.exit(0); 'exit' handlers run synchronously, so the child gets killed.
process.once('exit', killActive);

function resolveNode({ env = process.env, platform = process.platform, exists = fs.existsSync, execPath = process.execPath } = {}) {
    if (env.INSTA_LOGIN_NODE) {
        return { exe: env.INSTA_LOGIN_NODE, via: 'INSTA_LOGIN_NODE', windows: /\.exe$/i.test(env.INSTA_LOGIN_NODE), headedOk: true };
    }
    if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
        if (exists(WIN_NODE)) return { exe: WIN_NODE, via: 'auto: no display in WSL, using Windows node.exe', windows: true, headedOk: true };
        return { exe: execPath, via: 'process.execPath', windows: false, headedOk: false };
    }
    return { exe: execPath, via: 'process.execPath', windows: false, headedOk: true };
}

function runScript(args, opts = {}) {
    const {
        hardKillMs = LOGIN_KILL_MS, onLine = () => {}, spawnImpl = spawn,
        node = resolveNode(), cwd = REPO_ROOT, env = process.env
    } = opts;
    if (active) { const e = new Error('another login run is in progress'); e.code = 'BUSY'; return Promise.reject(e); }

    const childEnv = { ...env };
    if (node.windows && childEnv.PUPPETEER_EXECUTABLE_PATH) {
        // WSL -> Windows process only forwards variables named in WSLENV
        childEnv.WSLENV = childEnv.WSLENV ? `${childEnv.WSLENV}:PUPPETEER_EXECUTABLE_PATH` : 'PUPPETEER_EXECUTABLE_PATH';
    }

    return new Promise((resolve) => {
        const lines = [];
        let timedOut = false;
        let done = false;
        let hardTimer = null;
        let graceTimer = null;

        let child;
        try {
            child = spawnImpl(node.exe, [SCRIPT_REL, ...args], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
        } catch (e) {
            return resolve({ code: -1, signal: null, timedOut: false, lines, error: e.message });
        }
        active = child;

        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(hardTimer);
            clearTimeout(graceTimer);
            active = null;
            resolve({ lines, timedOut, ...result });
        };
        const push = (raw) => {
            const line = String(raw).replace(/\r$/, '');
            if (!line.trim()) return;
            if (lines.length < 200) lines.push(line);
            try { onLine(line); } catch (e) { /* progress sink must not break the run */ }
        };
        const feed = (stream) => {
            if (!stream) return;
            let buf = '';
            if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
            stream.on('data', (d) => {
                buf += d;
                let i;
                while ((i = buf.indexOf('\n')) >= 0) { push(buf.slice(0, i)); buf = buf.slice(i + 1); }
            });
            stream.on('end', () => { if (buf.trim()) push(buf); buf = ''; });
        };
        feed(child.stdout);
        feed(child.stderr);

        child.on('error', (e) => finish({ code: -1, signal: null, error: e.message }));
        child.on('close', (code, signal) => finish({ code, signal }));

        hardTimer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
            graceTimer = setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), 2000);
            if (graceTimer.unref) graceTimer.unref();
        }, hardKillMs);
        if (hardTimer.unref) hardTimer.unref();
    });
}

function describeExit(code, { timedOut = false, error = null, lines = [] } = {}) {
    if (error) return `Could not start the login script: ${error}`;
    if (timedOut) return 'The login script did not exit in time and was killed. Run /insta-login start again.';
    switch (code) {
        case 0: return null;
        case 2: return `Login timed out: nobody logged in within ${LOGIN_TIMEOUT_S}s. Run /insta-login start again.`;
        case 3: return 'The browser window was closed before login finished.';
        case 4: return 'Instagram showed a challenge / verification page. Run /insta-login start, solve it in the window, then /insta-login verify.';
        case 64: return 'The login script rejected its arguments (this is a bug in the command).';
        default: {
            const err = lines.filter((l) => /ERROR/.test(l)).pop();
            const detail = err ? err.replace(/^\[insta-login\]\s*ERROR \(exit \d+\):\s*/, '') : 'no error line captured';
            return `Login script failed (exit ${code}): ${detail}`;
        }
    }
}

function humanizeRemaining(ms) {
    const days = Math.floor(ms / DAY_MS);
    if (days < 1) return 'under a day';
    if (days < 14) return `~${days} days`;
    return `~${Math.round(days / 7)} weeks`;
}

function checkCookies({ file = COOKIE_FILE, now = Date.now(), startedAt = null, requireFresh = false } = {}) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
        return { ok: false, reason: e.code === 'ENOENT' ? 'no cookie file yet (run /insta-login start)' : `cookie file unreadable (${e.code || e.message})` };
    }
    if (!data || !Array.isArray(data.cookies)) return { ok: false, reason: 'cookie file is malformed (run /insta-login start)' };

    const savedMs = Date.parse(data.savedAt);
    if (requireFresh && (!Number.isFinite(savedMs) || savedMs < (startedAt || 0) - 1000)) {
        return { ok: false, reason: 'cookie file was not updated by this run' };
    }

    const nowS = now / 1000;
    const problems = [];
    let sessionExpires = null;
    for (const name of REQUIRED) {
        const present = data.cookies.filter((c) => c && c.name === name && c.value);
        if (!present.length) { problems.push(`${name} missing`); continue; }
        const live = present.filter((c) => !(c.expires > 0 && c.expires < nowS));
        if (!live.length) { problems.push(`${name} expired`); continue; }
        if (name === 'sessionid') sessionExpires = live[0].expires;
    }
    if (problems.length) return { ok: false, reason: problems.join(', ') };

    const sessionOnly = !(sessionExpires > 0);
    const expiresAt = sessionOnly ? null : sessionExpires * 1000;
    return {
        ok: true,
        savedAt: Number.isFinite(savedMs) ? new Date(savedMs).toISOString() : null,
        sessionOnly,
        expiresAt,
        remaining: sessionOnly ? null : humanizeRemaining(expiresAt - now)
    };
}

function cookieValues(file = COOKIE_FILE) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return (data.cookies || []).map((c) => String(c && c.value || '')).filter((v) => v.length >= 6);
    } catch (e) { return []; }
}

function scrub(text, values = []) {
    let out = String(text);
    for (const v of values) if (v) out = out.split(v).join('[redacted]');
    return out;
}

module.exports = {
    COOKIE_FILE, REPO_ROOT, SCRIPT_REL, REQUIRED, LOGIN_TIMEOUT_S, LOGIN_KILL_MS, VERIFY_KILL_MS,
    isBusy, killActive, resolveNode, runScript, describeExit, humanizeRemaining, checkCookies, cookieValues, scrub
};
