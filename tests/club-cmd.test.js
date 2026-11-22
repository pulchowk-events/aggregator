'use strict';
const test = require('node:test');
const assert = require('node:assert');
const club = require('../src/discord/commands/club');
const browser = require('../src/scrapers/browser');

test('club fetch uses the same withPage as scrapeAll', () => {
    assert.strictEqual(club.resolveWithPage(), browser.withPage);
});

test('club command definition is named club with 5 subcommands', () => {
    const j = club.definition.toJSON();
    assert.strictEqual(j.name, 'club');
    assert.deepStrictEqual(j.options.map((o) => o.name), ['add', 'remove', 'list', 'fetch', 'refresh']);
});
