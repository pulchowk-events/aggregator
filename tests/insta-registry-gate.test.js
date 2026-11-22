'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('social type is registered but gated by IG_SOCIAL_ENABLED; existing types untouched', () => {
    delete process.env.IG_SOCIAL_ENABLED;
    const reg = require('../src/scrapers/registry');
    assert.ok(reg.SOURCE_TYPES.includes('social'));
    for (const t of ['events', 'jobs', 'scholarships']) assert.ok(reg.SOURCE_TYPES.includes(t));
    assert.deepEqual(reg.getLoadErrors().filter((e) => /social/.test(e.file)), [], 'social plugin must load cleanly');

    const base = reg.getAllSources().length;
    assert.ok(base > 0, 'existing plugins still load');
    assert.equal(reg.getAllSources().some((p) => p.type === 'social'), false);
    assert.deepEqual(reg.listSources('social'), []);
    assert.equal(reg.getSource('social', 'instagram'), null);

    process.env.IG_SOCIAL_ENABLED = 'true';
    try {
        assert.equal(reg.getAllSources().length, base + 1);
        assert.deepEqual(reg.listSources('social'), ['instagram']);
        assert.equal(reg.getSource('social', 'instagram').type, 'social');
    } finally {
        delete process.env.IG_SOCIAL_ENABLED;
    }
    assert.equal(reg.getAllSources().length, base);
});
