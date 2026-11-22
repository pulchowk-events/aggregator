'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const runner = require('../src/core/instaLoginRunner');
const cmd = require('../src/discord/commands/insta-login');

const VALUES = { sessionid: 'sess-AAAA1111BBBB', csrftoken: 'csrf-CCCC2222', ds_user_id: '123456789' };

function writeCookies(opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-test-'));
    const file = path.join(dir, 'cookies.json');
    const now = Date.now();
    const cookies = Object.entries(VALUES)
        .filter(([name]) => !(opts.omit || []).includes(name))
        .map(([name, value]) => ({
            name, value, domain: '.instagram.com', path: '/',
            expires: name === 'sessionid' && 'sessionExpires' in opts ? opts.sessionExpires : Math.floor(now / 1000) + 28 * 86400
        }));
    fs.writeFileSync(file, JSON.stringify({ savedAt: opts.savedAt || new Date(now + 60000).toISOString(), cookies }));
    return file;
}

function fakeSpawn(script) {
    const calls = [];
    const impl = (exe, args, opts) => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.killed = false;
        child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGKILL')); };
        calls.push({ exe, args, opts });
        setImmediate(() => script && script(child));
        return child;
    };
    impl.calls = calls;
    return impl;
}
const exitWith = (child, code, out = '', err = '') => {
    if (out) child.stdout.write(out);
    if (err) child.stderr.write(err);
    child.stdout.end(); child.stderr.end();
    setTimeout(() => child.emit('close', code, null), 10);
};
const NODE = { exe: '/fake/node', windows: false, headedOk: true, via: 'test' };

// ---- runScript -------------------------------------------------------------
test('runScript spawns the node binary with the script, args and cwd, and collects lines', async () => {
    const spawnImpl = fakeSpawn((c) => exitWith(c, 0, '[insta-login] mode: login\n[insta-login] done, closing browser\n'));
    const seen = [];
    const res = await runner.runScript(['--timeout', '300', '--relogin'], { spawnImpl, node: NODE, cwd: '/repo', onLine: (l) => seen.push(l) });
    assert.strictEqual(res.code, 0);
    assert.deepStrictEqual(spawnImpl.calls[0].args, ['scripts/insta-login.js', '--timeout', '300', '--relogin']);
    assert.strictEqual(spawnImpl.calls[0].exe, '/fake/node');
    assert.strictEqual(spawnImpl.calls[0].opts.cwd, '/repo');
    assert.strictEqual(spawnImpl.calls[0].opts.windowsHide, false);
    assert.strictEqual(seen.length, 2);
    assert.match(seen[0], /mode: login/);
    assert.strictEqual(runner.isBusy(), false);
});

test('runScript forwards PUPPETEER_EXECUTABLE_PATH via WSLENV for Windows node', async () => {
    const spawnImpl = fakeSpawn((c) => exitWith(c, 0));
    await runner.runScript([], { spawnImpl, node: { ...NODE, windows: true }, env: { PUPPETEER_EXECUTABLE_PATH: 'C:\\edge.exe', WSLENV: 'FOO' } });
    assert.strictEqual(spawnImpl.calls[0].opts.env.WSLENV, 'FOO:PUPPETEER_EXECUTABLE_PATH');
});

test('exit 2 maps to a timeout message', async () => {
    const spawnImpl = fakeSpawn((c) => exitWith(c, 2, '', '[insta-login] ERROR (exit 2): timed out after 300s\n'));
    const res = await runner.runScript([], { spawnImpl, node: NODE });
    assert.strictEqual(res.code, 2);
    assert.match(runner.describeExit(res.code, res), /timed out/i);
});

test('exit 4 maps to a challenge message', async () => {
    const spawnImpl = fakeSpawn((c) => exitWith(c, 4));
    const res = await runner.runScript(['--verify'], { spawnImpl, node: NODE });
    assert.match(runner.describeExit(res.code, res), /challenge/i);
});

test('exit 1 surfaces the script error line', async () => {
    const spawnImpl = fakeSpawn((c) => exitWith(c, 1, '', '[insta-login] ERROR (exit 1): could not launch browser: boom\n'));
    const res = await runner.runScript([], { spawnImpl, node: NODE });
    assert.match(runner.describeExit(res.code, res), /could not launch browser: boom/);
});

test('hard timeout kills the child and reports timedOut', async () => {
    const spawnImpl = fakeSpawn(() => { /* never exits */ });
    const res = await runner.runScript([], { spawnImpl, node: NODE, hardKillMs: 30 });
    assert.strictEqual(res.timedOut, true);
    assert.match(runner.describeExit(res.code, res), /killed/i);
    assert.strictEqual(runner.isBusy(), false);
});

test('spawn error event resolves with an error message', async () => {
    const spawnImpl = fakeSpawn((c) => c.emit('error', new Error('ENOENT')));
    const res = await runner.runScript([], { spawnImpl, node: NODE });
    assert.match(runner.describeExit(res.code, res), /Could not start.*ENOENT/);
});

test('a second concurrent run is rejected with BUSY', async () => {
    const spawnImpl = fakeSpawn((c) => setTimeout(() => exitWith(c, 0), 40));
    const first = runner.runScript([], { spawnImpl, node: NODE });
    await assert.rejects(runner.runScript([], { spawnImpl, node: NODE }), (e) => e.code === 'BUSY');
    await first;
});

test('resolveNode: env override, WSL without display falls back to node.exe, display uses execPath', () => {
    assert.strictEqual(runner.resolveNode({ env: { INSTA_LOGIN_NODE: '/x/node' }, platform: 'linux' }).exe, '/x/node');
    const wsl = runner.resolveNode({ env: {}, platform: 'linux', exists: () => true });
    assert.match(wsl.exe, /node\.exe$/); assert.strictEqual(wsl.windows, true);
    const none = runner.resolveNode({ env: {}, platform: 'linux', exists: () => false, execPath: '/n' });
    assert.strictEqual(none.headedOk, false);
    const disp = runner.resolveNode({ env: { DISPLAY: ':0' }, platform: 'linux', execPath: '/n' });
    assert.strictEqual(disp.exe, '/n'); assert.strictEqual(disp.headedOk, true);
});

// ---- checkCookies ----------------------------------------------------------
test('checkCookies ok: all required present, reports remaining time', () => {
    const chk = runner.checkCookies({ file: writeCookies() });
    assert.strictEqual(chk.ok, true);
    assert.match(chk.remaining, /weeks|days/);
});

test('checkCookies: missing file, malformed file', () => {
    assert.match(runner.checkCookies({ file: '/nonexistent/cookies.json' }).reason, /no cookie file/);
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ig-test-')), 'c.json');
    fs.writeFileSync(f, '{"cookies": 5}');
    assert.match(runner.checkCookies({ file: f }).reason, /malformed/);
});

test('checkCookies: missing required cookies are named', () => {
    const chk = runner.checkCookies({ file: writeCookies({ omit: ['csrftoken', 'ds_user_id'] }) });
    assert.strictEqual(chk.ok, false);
    assert.match(chk.reason, /csrftoken missing/);
    assert.match(chk.reason, /ds_user_id missing/);
});

test('checkCookies: expired sessionid fails', () => {
    const chk = runner.checkCookies({ file: writeCookies({ sessionExpires: Math.floor(Date.now() / 1000) - 3600 }) });
    assert.strictEqual(chk.ok, false);
    assert.match(chk.reason, /sessionid expired/);
});

test('checkCookies: session cookie (expires -1) is accepted as sessionOnly', () => {
    const chk = runner.checkCookies({ file: writeCookies({ sessionExpires: -1 }) });
    assert.strictEqual(chk.ok, true);
    assert.strictEqual(chk.sessionOnly, true);
});

test('checkCookies requireFresh rejects a file older than the run start', () => {
    const file = writeCookies({ savedAt: new Date(Date.now() - 3600000).toISOString() });
    const chk = runner.checkCookies({ file, startedAt: Date.now(), requireFresh: true });
    assert.strictEqual(chk.ok, false);
    assert.match(chk.reason, /not updated by this run/);
    assert.strictEqual(runner.checkCookies({ file }).ok, true); // not required fresh -> fine
});

test('scrub redacts cookie values', () => {
    const out = runner.scrub(`got ${VALUES.sessionid} and ${VALUES.csrftoken}`, Object.values(VALUES));
    assert.ok(!out.includes(VALUES.sessionid) && !out.includes(VALUES.csrftoken));
    assert.match(out, /\[redacted\]/);
});

// ---- handler ---------------------------------------------------------------
function fakeInteraction(sub, { userId = '42', relogin = null } = {}) {
    const payloads = [];
    return {
        payloads,
        user: { id: userId, tag: 'admin#0001' },
        options: { getSubcommand: () => sub, getBoolean: () => relogin },
        reply: async (p) => { payloads.push(p); },
        deferReply: async (p) => { payloads.push(p); },
        editReply: async (p) => { payloads.push(p); }
    };
}
const leaks = (payloads) => Object.values(VALUES).filter((v) => JSON.stringify(payloads).includes(v));

test('handler denies non-admins and fails closed without ADMIN_USER_IDS', async () => {
    let ran = false;
    const deps = { runner: { runScript: async () => { ran = true; return { code: 0, lines: [] }; } } };
    const a = fakeInteraction('start', { userId: '7' });
    await cmd.handle({}, a, { ...deps, env: { ADMIN_USER_IDS: '42' } });
    assert.match(a.payloads[0].content, /restricted/);
    const b = fakeInteraction('start');
    await cmd.handle({}, b, { ...deps, env: {} });
    assert.match(b.payloads[0].content, /not set/);
    assert.strictEqual(ran, false);
});

test('status reply never contains cookie values', async () => {
    const file = writeCookies();
    const i = fakeInteraction('status');
    await cmd.handle({}, i, { env: { ADMIN_USER_IDS: '42' }, cookieFile: file });
    assert.match(i.payloads[0].content, /✅/);
    assert.deepStrictEqual(leaks(i.payloads), []);
});

test('start success path: login then verify, replies ephemeral, no cookie values in any payload', async () => {
    const file = writeCookies();
    const calls = [];
    const deps = {
        env: { ADMIN_USER_IDS: '42' }, cookieFile: file, progressMs: 5,
        runner: {
            resolveNode: () => NODE,
            runScript: async (args, o) => {
                calls.push(args);
                o.onLine(`[insta-login] leaked ${VALUES.sessionid} oops`);
                await new Promise((r) => setTimeout(r, 40));
                return { code: 0, lines: [] };
            }
        }
    };
    const i = fakeInteraction('start', { relogin: true });
    await cmd.handle({}, i, deps);
    assert.deepStrictEqual(calls[0], ['--timeout', '300', '--relogin']);
    assert.deepStrictEqual(calls[1], ['--verify', '--headless']);
    assert.match(i.payloads[i.payloads.length - 1].content, /✅ Logged in and verified/);
    assert.deepStrictEqual(leaks(i.payloads), []);
});

test('start failure paths: exit 2 and stale cookie file', async () => {
    const file = writeCookies();
    const mk = (res) => ({ env: { ADMIN_USER_IDS: '42' }, cookieFile: file, progressMs: 5, runner: { resolveNode: () => NODE, runScript: async () => res } });
    const a = fakeInteraction('start', { relogin: true });
    await cmd.handle({}, a, mk({ code: 2, lines: [] }));
    assert.match(a.payloads[a.payloads.length - 1].content, /❌.*timed out/i);

    const stale = writeCookies({ savedAt: new Date(Date.now() - 3600000).toISOString() });
    const b = fakeInteraction('start', { relogin: true });
    await cmd.handle({}, b, { ...mk({ code: 0, lines: [] }), cookieFile: stale });
    assert.match(b.payloads[b.payloads.length - 1].content, /not updated by this run/);
    assert.deepStrictEqual(leaks([...a.payloads, ...b.payloads]), []);
});

test('verify with expired sessionid short-circuits without spawning; challenge exit is reported', async () => {
    let spawned = 0;
    const expired = writeCookies({ sessionExpires: Math.floor(Date.now() / 1000) - 60 });
    const a = fakeInteraction('verify');
    await cmd.handle({}, a, { env: { ADMIN_USER_IDS: '42' }, cookieFile: expired, runner: { runScript: async () => { spawned++; return { code: 0, lines: [] }; } } });
    assert.match(a.payloads[0].content, /sessionid expired/);
    assert.strictEqual(spawned, 0);

    const ok = writeCookies();
    const b = fakeInteraction('verify');
    await cmd.handle({}, b, { env: { ADMIN_USER_IDS: '42' }, cookieFile: ok, progressMs: 5, runner: { resolveNode: () => NODE, runScript: async () => ({ code: 4, lines: [] }) } });
    assert.match(b.payloads[b.payloads.length - 1].content, /challenge/i);
});

test('start is refused when no display and no Windows node', async () => {
    const i = fakeInteraction('start');
    await cmd.handle({}, i, { env: { ADMIN_USER_IDS: '42' }, runner: { resolveNode: () => ({ ...NODE, headedOk: false }) } });
    assert.match(i.payloads[0].content, /No display/);
});
