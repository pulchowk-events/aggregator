'use strict';
// Bug 2: the "Card wrapper" assumption must come from cardCandidates
// (chrome-filtered), never cardGroups (includes script/link/style).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { buildPrompt } = require(path.resolve(__dirname, '..', 'wizard', 'prompt.js'));

// listing-to-detail on purpose: a single-page-cards fixture would put the
// cardGroups selector into the "Detected site type" paragraph via detect.js
// (known, out of scope), which is outside the slice but muddies the intent.
const DETECTED = {
    type: 'listing-to-detail',
    signals: { hasCardWrapper: true },
    evidence: { detailLinkPattern: '/jobs/<slug>', detailLinkCount: 12 }
};

function assumptionsSlice(listing) {
    const out = buildPrompt({
        name: 'fixture', type: 'jobs', url: 'https://example.com/careers',
        listing, detail: null, detected: DETECTED
    });
    const start = out.indexOf('## Before you write code');
    const end = out.indexOf('If ANY assumption above is wrong', start);
    assert.ok(start >= 0 && end > start, 'assumptions section markers not found');
    return out.slice(start, end);
}

const POLLUTED_GROUPS = [{ selector: 'script', count: 24, sampleHtml: '' }];

test('card wrapper comes from cardCandidates, not cardGroups', () => {
    const s = assumptionsSlice({
        cardGroups: POLLUTED_GROUPS,
        cardCandidates: [{ selector: 'li.job', count: 7, jobTitleRatio: 0.8, looksLikeSectionWrapper: false }]
    });
    assert.ok(s.includes('**Card wrapper:** `li.job` (7 instances'), s);
    assert.ok(s.includes('jobTitleRatio 0.8'), s);
    assert.ok(!s.includes('script'), 'cardGroups selector leaked: ' + s);
    assert.ok(!s.includes('section wrapper'), s);
});

test('looksLikeSectionWrapper adds the verify note', () => {
    const s = assumptionsSlice({
        cardGroups: POLLUTED_GROUPS,
        cardCandidates: [{ selector: 'div.jobs', count: 3, jobTitleRatio: 0.2, looksLikeSectionWrapper: true }]
    });
    assert.ok(s.includes('`div.jobs`'), s);
    assert.ok(s.includes('verify, may be a section wrapper'), s);
});

test('empty cardCandidates: no card-wrapper line, no cardGroups fallback', () => {
    const s = assumptionsSlice({ cardGroups: POLLUTED_GROUPS, cardCandidates: [] });
    assert.ok(!s.includes('**Card wrapper:**'), s);
    assert.ok(!s.includes('script'), s);
});

test('missing cardCandidates field does not throw and prints no line', () => {
    const s = assumptionsSlice({ cardGroups: POLLUTED_GROUPS });
    assert.ok(!s.includes('**Card wrapper:**'), s);
});
