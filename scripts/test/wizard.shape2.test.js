'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildPrompt, loadReference } = require('../wizard/prompt');
const { pickDetailUrl } = require('../wizard/detect');

const BASE = 'https://x.test/jobs/';
const WIZ = path.join(__dirname, '..', 'wizard');
const BATCH = path.join(__dirname, '..', 'batch');
const read = (p) => fs.readFileSync(p, 'latin1');

function listing(extra) {
    return Object.assign({ url: BASE, jsonLdTypes: [], anchorGroups: [], cardCandidates: [], detailLinkCandidates: [] }, extra || {});
}
function promptFor(type, evidence) {
    const detected = { type, signals: {}, evidence: evidence || {} };
    return buildPrompt({ name: 'fixture', type: 'jobs', url: BASE, listing: listing(), detail: null, detected });
}

test('1. hub prompt carries hub guidance, not the single-page-cards description', () => {
    const p = promptFor('hub', { cardSelector: 'div.dept', cardCount: 3, labels: ['CONTENT', 'MANAGEMENT'] });
    assert.ok(p.includes('This page is a hub'));
    assert.ok(p.includes('CONTENT / MANAGEMENT'));
    assert.ok(!p.includes('All data lives on the listing cards themselves'));
    assert.ok(!p.includes('No clear pattern detected'));
});

test('1b. single-posting, unknown-shape and jsonld-first render their own guidance', () => {
    const sp = promptFor('single-posting', { jsonLdTypes: ['JobPosting'] });
    assert.ok(sp.includes('Extract exactly ONE item'));
    assert.ok(sp.includes('JSON-LD (JobPosting)'));
    const us = promptFor('unknown-shape', { emptyState: true });
    assert.ok(us.includes('The page shape is unknown'));
    assert.ok(us.includes('empty-state phrase'));
    const jf = promptFor('jsonld-first', { jsonLdType: 'JobPosting', jsonLdKeys: [] });
    assert.ok(jf.includes('well-formed JSON-LD (`JobPosting`)'));
});

test('2. new shapes resolve to explicit jobs references', () => {
    assert.ok(/growbydata\.js$/.test(loadReference('jobs', 'hub').path));
    assert.ok(/lftechnology\.js$/.test(loadReference('jobs', 'single-posting').path));
    assert.ok(/growbydata\.js$/.test(loadReference('jobs', 'unknown-shape').path));
});

test('3. index.js and follow.js pick detail URLs through pickDetailUrl', () => {
    for (const f of [path.join(WIZ, 'index.js'), path.join(BATCH, 'follow.js')]) {
        const src = read(f);
        assert.ok(/pickDetailUrl\(listing/.test(src), f + ' does not call pickDetailUrl');
        assert.ok(!/detailPattern\.samples\[0\]/.test(src), f + ' still reads detailPattern.samples[0]');
    }
});

test('3b. pickDetailUrl uses restored anchorGroup samples as last resort', () => {
    const legacy = { pattern: '/career/<id>', count: 5, samples: [{ href: '/career/7', text: 'x' }] };
    const r = pickDetailUrl(listing({ anchorGroups: [legacy] }), BASE, legacy);
    assert.strictEqual(r.href, 'https://x.test/career/7');
});

test('4. dump.js trimmed anchorGroups keep samples (static check, no browser)', () => {
    const src = read(path.join(WIZ, 'dump.js'));
    assert.ok(/pattern: g\.pattern, count: g\.count,\s*samples:/.test(src));
});
