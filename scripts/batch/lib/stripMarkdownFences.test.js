'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stripMarkdownFences } = require('../../wizard/interactive');

test('prose + unfenced code -> code only', () => {
    const input = 'Here is the extractor:\n\n// built for X\nmodule.exports = { extract };\n\nLet me know if it works!';
    assert.strictEqual(stripMarkdownFences(input), '// built for X\nmodule.exports = { extract };\n');
});

test('fenced -> unchanged behavior', () => {
    assert.strictEqual(stripMarkdownFences('```js\nmodule.exports = { extract };\n```'), 'module.exports = { extract };\n');
});

test('pure code unchanged', () => {
    assert.strictEqual(stripMarkdownFences('module.exports = { extract };\n'), 'module.exports = { extract };\n');
});

test('no-marker guard: plain text only gets trailing newline', () => {
    assert.strictEqual(stripMarkdownFences('I cannot help with that request.'), 'I cannot help with that request.\n');
});

test('JSON passthrough (filter-rules.js consumer)', () => {
    const input = '{"rules": ["a", "b"], "version": 1}';
    assert.strictEqual(stripMarkdownFences(input), input + '\n');
});
