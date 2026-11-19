'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildPriorAttemptsSection, formatProblems, MAX_PROBLEMS_SHOWN } = require('../batch/refine');

const base = { verdict: 'ok', items: 4, reason: 'implausible_values' };

test('problems[] shows rule code, item index and evidence', () => {
    const out = buildPriorAttemptsSection([Object.assign({}, base, {
        problems: [{ code: 'junk_title', source_item_index: 2, evidence: 'nav_heading: "Learn more"' }]
    })]);
    assert.ok(out.includes('[junk_title]'));
    assert.ok(out.includes('item #2'));
    assert.ok(out.includes('nav_heading: "Learn more"'));
});

test('null / empty problems[] leaves output identical to today', () => {
    const plain = buildPriorAttemptsSection([Object.assign({}, base)]);
    const withNull = buildPriorAttemptsSection([Object.assign({}, base, { problems: null })]);
    const withEmpty = buildPriorAttemptsSection([Object.assign({}, base, { problems: [] })]);
    assert.equal(withNull, plain);
    assert.equal(withEmpty, plain);
    assert.ok(!plain.includes('Plausibility gate problems'));
    assert.deepEqual(formatProblems(null), []);
});

test('huge problems[] is capped with an "and M more" suffix', () => {
    const problems = [];
    for (let i = 0; i < 25; i++) problems.push({ code: 'junk_title', source_item_index: i, evidence: 'x' + i });
    const out = buildPriorAttemptsSection([Object.assign({}, base, { problems })]);
    assert.equal(out.split('[junk_title]').length - 1, MAX_PROBLEMS_SHOWN);
    assert.ok(out.includes('... and 5 more'));
});

test('existing warn-derived FAILED FIELD path still present', () => {
    const out = buildPriorAttemptsSection([Object.assign({}, base, {
        coverage: { title: '4/4', company: '0/4' },
        decisionField: 'company'
    })]);
    assert.ok(out.includes('FAILED FIELD: company'));
    const src = fs.readFileSync(path.join(__dirname, '..', 'batch', 'refine.js'), 'latin1');
    assert.ok(src.includes('missing on'));
});

test('evidence is truncated and whitespace-collapsed', () => {
    const out = formatProblems([{ code: 'c', source_item_index: 0, evidence: 'a\n\n  b ' + 'z'.repeat(500) }]).join('\n');
    assert.ok(out.includes('a b zzz'));
    assert.ok(!out.includes('z'.repeat(250)));
});
