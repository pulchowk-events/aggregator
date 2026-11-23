'use strict';
// Offline tests: job field coercion in websiteSync/engine.js. No network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ENGINE = path.resolve(__dirname, '..', 'src', 'integrations', 'websiteSync', 'engine.js');
const engine = require(ENGINE);
const { toText, jobToWebsiteRow, getJobWebsiteDedupKey } = engine;

const mk = (extra) => Object.assign({
    title: 'Dev', company: 'Acme', url: 'https://example.com/j/1', source: 'x', firstSeenAt: 1700000000000
}, extra);

test('toText coerces every shape without throwing', () => {
    assert.equal(toText('  hi  '), 'hi');
    assert.equal(toText(null), '');
    assert.equal(toText(undefined), '');
    assert.equal(toText(42), '42');
    assert.equal(toText(NaN), '');
    assert.equal(toText(['  a ', '', null, 'b']), 'a\nb');
    assert.equal(toText([]), '');
    assert.equal(toText({ a: 1 }), '');
    assert.equal(toText([['x'], { y: 1 }, 'z']), 'x\nz');
});

test('jobToWebsiteRow survives array responsibilities and requirements', () => {
    const row = jobToWebsiteRow({}, mk({ responsibilities: ['  Build ', 'Ship'], requirements: ['BSc'] }));
    assert.ok(row);
    assert.ok(row.description.includes('Responsibilities:\nBuild\nShip'));
    assert.ok(row.description.includes('Requirements:\nBSc'));
});

test('jobToWebsiteRow survives empty array (the prod crash case)', () => {
    const row = jobToWebsiteRow({}, mk({ responsibilities: [], requirements: [] }));
    assert.ok(row);
    assert.equal(row.description.includes('Responsibilities:'), false);
    assert.equal(row.description.includes('Requirements:'), false);
});

test('jobToWebsiteRow survives null, number and object inputs', () => {
    for (const bad of [null, 7, { a: 1 }, true]) {
        const row = jobToWebsiteRow({}, mk({ description: bad, responsibilities: bad, requirements: bad }));
        assert.ok(row);
        assert.equal(typeof row.description, 'string');
    }
    const r = jobToWebsiteRow({}, mk({ responsibilities: 5 }));
    assert.ok(r.description.includes('Responsibilities:\n5'));
});

test('non-string url, title, company, employmentType, attendanceMode do not throw', () => {
    assert.doesNotThrow(() => getJobWebsiteDedupKey(mk({ url: ['https://a.com/x'] })));
    assert.doesNotThrow(() => getJobWebsiteDedupKey({ title: 5, company: {} }));
    const row = jobToWebsiteRow({}, mk({ employmentType: ['Full time'], attendanceMode: 12, location: ['Kathmandu'], salary: 100 }));
    assert.ok(row);
    assert.equal(row.employment_type, 'Full-time');
    assert.ok(row.attendance_mode === null || typeof row.attendance_mode === 'string');
    assert.equal(row.location, 'Kathmandu');
    assert.equal(row.salary, '100');
    assert.equal(jobToWebsiteRow({}, mk({ url: null, registrationUrl: null })), null);
    assert.equal(jobToWebsiteRow({}, mk({ company: [] })), null);
});

test('syncWebsite guards each job row (structural check)', () => {
    const src = fs.readFileSync(ENGINE, 'utf8');
    assert.ok(src.includes('jobConvertErrors'));
    assert.ok(/try \{ return jobToWebsiteRow\(bot, job\); \}/.test(src));
});
