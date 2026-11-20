const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'scripts', 'cli.js');

function runCli(...args) {
    return spawnSync(process.execPath, [CLI, ...args], {
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' }
    });
}

test('top-level help lists current commands and clean usage', () => {
    const result = runCli('--help');

    assert.equal(result.status, 0);
    assert.match(result.stdout, /add <url>/);
    assert.match(result.stdout, /placeholders \[options\]/);
    assert.match(result.stdout, /maintenance <task>/);
    assert.match(result.stdout, /test-send \[options\]/);
    assert.match(result.stdout, /help \[command\]/);
    assert.match(result.stdout, /diagnose --help/);
});

test('add help documents the supported flag syntax', () => {
    const result = runCli('add', '--help');

    assert.equal(result.status, 0);
    assert.match(result.stdout, /--type <events\|jobs\|scholarships>/);
    assert.match(result.stdout, /--name <name>/);
    assert.match(result.stdout, /legacy positional form/);
});

test('add reports missing type before starting the wizard', () => {
    const result = runCli('add', 'https://example.com/events');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /URL and --type are required/);
});

test('batch help includes scrape-now and its usage is available', () => {
    const batchHelp = runCli('batch', 'help');
    const commandHelp = runCli('batch', 'scrape-now', '--help');

    assert.equal(batchHelp.status, 0);
    assert.match(batchHelp.stdout, /scrape-now/);
    assert.equal(commandHelp.status, 0);
    assert.match(commandHelp.stdout, /--sources <name1,name2>/);
});

test('maintenance help lists standalone maintenance utilities', () => {
    const result = runCli('maintenance', '--help');
    const taskHelp = runCli('maintenance', 'clean-scholarships', '--help');

    assert.equal(result.status, 0);
    assert.match(result.stdout, /checkpoint\s+Save, inspect/);
    assert.match(result.stdout, /migrate\s+Copy legacy cache/);
    assert.match(result.stdout, /clean-scholarships\s+Remove all scholarship/);
    assert.match(result.stdout, /cleanup-warnings\s+Deduplicate pending-item/);
    assert.equal(taskHelp.status, 0);
    assert.match(taskHelp.stdout, /clean-scholarships --confirm/);
});

test('maintenance refuses unknown tasks and cache writes without confirmation', () => {
    const unknown = runCli('maintenance', 'not-a-task');
    const unconfirmed = runCli('maintenance', 'cleanup-warnings');

    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown task/);
    assert.equal(unconfirmed.status, 1);
    assert.match(unconfirmed.stderr, /pass --confirm/);
});

test('standalone utility help does not launch the underlying script', () => {
    const placeholders = runCli('placeholders', '--help');
    const simulate = runCli('simulate', '--help');
    const testSend = runCli('test-send', '--help');
    const tests = runCli('test', '--help');

    assert.equal(placeholders.status, 0);
    assert.match(placeholders.stdout, /--only <name1,name2>/);
    assert.equal(simulate.status, 0);
    assert.match(simulate.stdout, /--send permits sample messages/);
    assert.equal(testSend.status, 0);
    assert.match(testSend.stdout, /--send permits one message/);
    assert.equal(tests.status, 0);
    assert.match(tests.stdout, /all \*.test.js files under scripts/);
});

test('test runner rejects paths that are not repository test files', () => {
    const result = runCli('test', 'README.md');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a repository test file/);
});

test('test-send defaults to dry and does not send without --send', () => {
    const dry = runCli('test-send');
    const conflict = runCli('test-send', '--send', '--dry');

    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /no send/);
    assert.equal(conflict.status, 1);
    assert.match(conflict.stderr, /choose either --dry or --send/);
});
