'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detectSiteType, pickDetailUrl } = require('../wizard/detect');

const BASE = 'https://x.test/career';

function jobCards() {
    return {
        url: BASE,
        jsonLdTypes: [],
        cardCandidates: [{
            selector: 'div.job-card', count: 6, looksLikeSectionWrapper: false,
            childSamples: ['Frontend Developer', 'Backend Developer', 'QA Engineer'],
            hrefs: ['/career/101', '/career/102', '/career/103', '/career/104', '/career/105', '/career/106']
        }],
        detailLinkCandidates: [{
            pattern: '/career/<id>', count: 6, appearsInCards: true,
            samples: [{ href: 'https://x.test/career/101', text: 'Frontend Developer' }]
        }]
    };
}

test('1. jobs listing with distinct card links -> listing-to-detail', () => {
    const v = detectSiteType(jobCards());
    assert.strictEqual(v.type, 'listing-to-detail');
    assert.ok(v.evidence.sampleHrefs.length > 0);
    assert.strictEqual(v.evidence.detailLinkPattern, '/career/<id>');
});

test('2. single posting (no card list, JobPosting JSON-LD) -> single-posting', () => {
    const v = detectSiteType({ url: BASE, jsonLdTypes: ['JobPosting'], cardCandidates: [] });
    assert.strictEqual(v.type, 'single-posting');
});

test('3. hub (cards are category labels) -> hub', () => {
    const v = detectSiteType({
        url: 'https://x.test/jobs/', jsonLdTypes: [],
        cardCandidates: [{
            selector: 'div.dept', count: 3, looksLikeSectionWrapper: false,
            childSamples: ['CONTENT', 'MANAGEMENT', 'FINANCE'],
            hrefs: ['/jobs/content/', '/jobs/management/', '/jobs/finance/']
        }]
    });
    assert.strictEqual(v.type, 'hub');
});

test('3b. nav-only anchorGroups with no cards never yields listing-to-detail', () => {
    const v = detectSiteType({
        url: BASE, jsonLdTypes: [], cardCandidates: [],
        anchorGroups: [{ pattern: '/career', count: 9 }],
        cardGroups: [{ selector: 'div', count: 5 }]
    });
    assert.strictEqual(v.type, 'unknown-shape');
});

test('3c. cards without distinct links -> single-page-cards', () => {
    const v = detectSiteType({
        url: BASE, jsonLdTypes: [],
        cardCandidates: [{ selector: 'div.ev', count: 5, looksLikeSectionWrapper: false, childSamples: ['Hack Night', 'Demo Day'], hrefs: [] }]
    });
    assert.strictEqual(v.type, 'single-page-cards');
});

test('4. pickDetailUrl returns a non-empty absolute sample', () => {
    const fromCand = pickDetailUrl(jobCards(), BASE);
    assert.strictEqual(fromCand.href, 'https://x.test/career/101');
    const l = jobCards();
    l.detailLinkCandidates = [];
    const fromCards = pickDetailUrl(l, BASE);
    assert.strictEqual(fromCards.href, 'https://x.test/career/101');
    // dump.js-stripped anchorGroups ({pattern,count}, no samples) alone give nothing
    assert.strictEqual(pickDetailUrl({ anchorGroups: [{ pattern: '/career/<id>', count: 9 }] }, BASE, { pattern: '/career/<id>', count: 9 }), null);
});

test('5. pickDetailUrl with no candidates returns null, no crash', () => {
    assert.strictEqual(pickDetailUrl({}, BASE), null);
    assert.strictEqual(pickDetailUrl(null, BASE), null);
    assert.strictEqual(pickDetailUrl({ detailLinkCandidates: [], cardCandidates: [] }, BASE), null);
});
