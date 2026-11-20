const assert = require('node:assert/strict');
const test = require('node:test');

const { parseArgs: parseRunArgs } = require('../batch/run');
const { parseArgs: parseAutoArgs } = require('../batch/auto');
const { parseArgs: parsePasteArgs } = require('../batch/paste');

test('batch run passes provider and explicit paste transport to its phases', () => {
    const args = parseRunArgs([
        'urls.txt',
        '--provider', 'chatgpt',
        '--extension'
    ]);

    assert.equal(args.urlsFile, 'urls.txt');
    assert.equal(args.provider, 'chatgpt');
    assert.equal(args.pasteMode, 'extension');
});

test('batch auto accepts the same provider and transport options', () => {
    const args = parseAutoArgs([
        '--provider', 'chatgpt',
        '--manual'
    ]);

    assert.equal(args.provider, 'chatgpt');
    assert.equal(args.pasteMode, 'manual');
});

test('provider flags require a value', () => {
    assert.throws(() => parseRunArgs(['--provider']), /--provider needs a value/);
    assert.throws(() => parseAutoArgs(['--provider', '--manual']), /--provider needs a value/);
});

test('resume-after-timeout is accepted by paste, auto, and run', () => {
    assert.equal(parseRunArgs(['--resume-after-timeout']).resumeAfterTimeout, true);
    assert.equal(parseAutoArgs(['--resume-after-timeout']).resumeAfterTimeout, true);

    const previous = process.env.EXTENSION_TOKEN;
    try {
        process.env.EXTENSION_TOKEN = 'test-token';
        assert.equal(parsePasteArgs(['--resume-after-timeout']).resumeAfterTimeout, true);
    } finally {
        if (previous === undefined) delete process.env.EXTENSION_TOKEN;
        else process.env.EXTENSION_TOKEN = previous;
    }
});

test('EXTENSION_TOKEN selects transport mode, not the LLM provider', () => {
    const previous = process.env.EXTENSION_TOKEN;
    try {
        process.env.EXTENSION_TOKEN = 'test-token';
        const args = parsePasteArgs([]);
        assert.equal(args.mode, 'extension');
        assert.equal(args.provider, null);
    } finally {
        if (previous === undefined) delete process.env.EXTENSION_TOKEN;
        else process.env.EXTENSION_TOKEN = previous;
    }
});
