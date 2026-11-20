const test = require('node:test');
const assert = require('node:assert/strict');

const { hasCapturedPromptEvidence } = require('../batch/lib/prompt-evidence');

function listingSection(evidence) {
    return '## Evidence dump (listing page)\n\n```json\n' +
        JSON.stringify(evidence) + '\n```\n';
}

test('compact prompts with selector evidence are not rejected by total size', () => {
    const body = listingSection({
        title: 'Careers',
        cardCandidates: [{ selector: 'article.job-card', count: 4 }]
    });

    assert.ok(Buffer.byteLength(body, 'utf8') < 40000);
    assert.equal(hasCapturedPromptEvidence(body), true);
});

test('raw HTML and field evidence count as usable evidence', () => {
    const rawHtml = '## Raw HTML\n\n```html\n<article><h2>Engineer</h2></article>\n```\n';
    const fields = '## Field evidence from this site\n\n### DOM elements found by field\n- title\n';

    assert.equal(hasCapturedPromptEvidence(rawHtml), true);
    assert.equal(hasCapturedPromptEvidence(fields), true);
});

test('empty dumps and omission markers alone remain force-includable', () => {
    const body = listingSection({}) +
        '## Raw HTML\n\n```html\n<!-- remaining DOM omitted -->\n```\n' +
        '## Field evidence from this site\nNo field evidence captured.\n';

    assert.equal(hasCapturedPromptEvidence(body), false);
});
