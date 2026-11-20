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
