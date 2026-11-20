// scripts/test/prompt.trimmer.test.js
// The prompt budget must preserve required sections and valid evidence.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const prompt = require('../wizard/prompt');
const { buildPrompt, trimPartsToBudget } = prompt;
const {
    validatePrompt,
    validatePromptFile,
    REQUIRED_SECTIONS
} = require('../batch/lib/prompt-structure');

const BUDGET = 52000;
const FLOOR = 2048;
const LISTING_HEADER = '## Evidence dump (listing page)';
const SAMPLE_HEADER = '## Evidence dump (sample detail page)';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-trimmer-'));
test.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ---- fixtures ------------------------------------------------------------

function promptInputs(blobSize) {
    const hrefs = Array.from({ length: Math.max(1, Math.ceil(blobSize / 40)) }, (_, i) =>
        'https://example.test/jobs/' + i);
    return {
        name: 'fixture-co',
        type: 'jobs',
        url: 'https://example.test/careers',
        listing: {
            cardCandidates: [{ selector: 'div.card', count: 5, jobTitleRatio: 0.9, hrefs }]
        },
        detail: null,
        detected: {
            type: 'single-page-cards',
            signals: {},
            evidence: { cardSelector: 'div.card', cardCount: 5 }
        }
    };
}

// Header element text for a REQUIRED spec. The trimmer matches the listing
// header exactly, so it gets no suffix; other prefix headers get one.
function headerElement(spec) {
    if (spec.text === LISTING_HEADER) return spec.text;
    return spec.match === 'prefix' ? spec.text + ' fixture' : spec.text;
}

// A parts[] array shaped like buildPrompt's: header, blank, body, blank.
function buildParts({ listingDump = 'L'.repeat(1000), sampleDump = null, fill = {} } = {}) {
    const parts = [];
    for (const spec of REQUIRED_SECTIONS) {
        parts.push(headerElement(spec), '');
        if (spec.text === '## The contract') {
            parts.push('```js', 'module.exports = { async extract(page, ctx) { return { items, meta }; } };', '```');
        } else if (spec.text === '## What to output') {
            parts.push('One code block, ready to paste over the existing file.');
        } else if (spec.text === '## Verdict (required)') {
            parts.push('VERDICT: CAREERS_PAGE', 'VERDICT: NOT_CAREERS_PAGE', 'VERDICT: CAREERS_PAGE_REDIRECT');
        } else if (spec.text === LISTING_HEADER) {
            parts.push('```json', listingDump, '```');
        } else {
            parts.push(fill[spec.text] || ('Filler for ' + spec.text));
        }
        parts.push('');
        if (spec.text === LISTING_HEADER && sampleDump) {
            parts.push(SAMPLE_HEADER, '', '```json', sampleDump, '```', '');
        }
    }
    return parts;
}

const fenceCount = (s) => (s.match(/^```/gm) || []).length;

// ---- 1. the bug, through buildPrompt --------------------------------------

test('buildPrompt compacts evidence under 52KB and keeps useful card evidence', () => {
    // Guard: the fixture must be valid on its own, so a failure below is about the trimmer.
    let small;
    try {
        small = buildPrompt(promptInputs(200));
    } catch (e) {
        assert.fail('FIXTURE: buildPrompt rejected minimal inputs: ' + e.message);
    }
    const smallCheck = validatePrompt(small);
    assert.ok(smallCheck.ok, 'FIXTURE: small prompt already invalid: ' + smallCheck.reasons.join('; '));
    assert.ok(!small.includes('prompt trimmed'), 'FIXTURE: small prompt was trimmed');

    const inputs = promptInputs(160000);
    const out = buildPrompt(inputs);

    assert.ok(Buffer.byteLength(out, 'utf8') <= BUDGET,
        'prompt is ' + Buffer.byteLength(out, 'utf8') + ' bytes, over ' + BUDGET);
    assert.ok(out.includes('"selector": "div.card"'));
    assert.ok(out.includes('"hrefsOmittedCount"'));

    const file = path.join(tmpDir, 'over-budget.md');
    fs.writeFileSync(file, out);
    const r = validatePromptFile(file);

    assert.deepStrictEqual(r.missing, [],
        'over-budget prompt lost REQUIRED sections: ' + r.missing.join(' | '));
    assert.ok(r.ok, 'validatePromptFile rejected the trimmed prompt: ' + r.reasons.join('; '));
    assert.ok(Buffer.byteLength(out, 'utf8') <= BUDGET);

    // Listing header is preserved and its JSON stays parseable.
    assert.strictEqual(out.split('\n').filter((l) => l === LISTING_HEADER).length, 1);
    const hdrIdx = out.indexOf('\n' + LISTING_HEADER + '\n');
    const fenceStart = out.indexOf('```json\n', hdrIdx) + '```json\n'.length;
    const fenceEnd = out.indexOf('\n```', fenceStart);
    const body = out.slice(fenceStart, fenceEnd);
    const evidence = JSON.parse(body);
    assert.strictEqual(evidence.cardCandidates[0].selector, 'div.card');
    assert.strictEqual(evidence.cardCandidates[0].hrefs.length, 8);
    assert.ok(evidence.cardCandidates[0].hrefsOmittedCount > 0);

    // The fence around the dump is still closed.
    assert.strictEqual(fenceCount(out) % 2, fenceCount(small) % 2, 'code fences are unbalanced');
});

test('raw DOM excerpts are bounded without losing separate field evidence', () => {
    const inputs = promptInputs(200);
    const html = '<article><h2>Engineer opening</h2><p>' +
        'Role description and qualifications. '.repeat(4000) +
        '</p></article>';
    const fieldEvidence = {
        jsonLd: [],
        ogMeta: {},
        fields: {
            title: [{ selector: 'article h2', tag: 'h2', text: 'Engineer opening' }]
        }
    };
    inputs.listing.rawCardHtml = {
        html,
        originalSize: Buffer.byteLength(html, 'utf8'),
        removed: [],
        label: 'rawCardHtml'
    };
    inputs.listing.fieldEvidence = fieldEvidence;
    inputs.detail = {
        url: 'https://example.test/jobs/1',
        title: 'Engineer opening',
        headings: [{ tag: 'h2', cls: 'title', text: 'Engineer opening' }],
        fieldEvidence,
        rawDetailHtml: {
            html,
            originalSize: Buffer.byteLength(html, 'utf8'),
            removed: [],
            label: 'rawDetailHtml'
        }
    };

    const out = buildPrompt(inputs);
    const cardStart = out.indexOf('## Raw HTML (one representative listing card)');
    const cardFence = out.indexOf('```html\n', cardStart) + '```html\n'.length;
    const cardEnd = out.indexOf('\n```', cardFence);
    const listingStart = out.indexOf('\n## Evidence dump (listing page)');
    const listingFence = out.indexOf('```json\n', listingStart) + '```json\n'.length;
    const listingEnd = out.indexOf('\n```', listingFence);
    const listingEvidence = JSON.parse(out.slice(listingFence, listingEnd));
    const detailStart = out.indexOf('## Raw HTML (detail page role-body region)');
    const detailFence = out.indexOf('```html\n', detailStart) + '```html\n'.length;
    const detailEnd = out.indexOf('\n```', detailFence);

    assert.ok(Buffer.byteLength(out, 'utf8') <= BUDGET);
    assert.ok(Buffer.byteLength(out.slice(cardFence, cardEnd), 'utf8') <= 6000);
    assert.ok(Buffer.byteLength(out.slice(detailFence, detailEnd), 'utf8') <= 6000);
    assert.ok(out.includes('`article h2` <h2>'));
    assert.ok(out.includes('### From the sample detail page (authoritative for per-item fields)'));
    assert.ok(!listingEvidence.rawCardHtml.html);
});

// ---- 2. mild overflow: only the optional section goes ----------------------

test('sample-detail dump is sacrificed before required listing evidence', () => {
    const listingDump = 'L'.repeat(20000);
    const parts = buildParts({ listingDump, sampleDump: 'S'.repeat(110000) });
    assert.ok(parts.join('\n').length > BUDGET);

    const out = trimPartsToBudget(parts, {
        max: BUDGET,
        minEvidence: FLOOR,
        warn: () => { throw new Error('unexpected warn'); }
    });

    assert.ok(Buffer.byteLength(out, 'utf8') <= BUDGET);
    assert.ok(!out.split('\n').includes(SAMPLE_HEADER), 'sample-detail section should be dropped');
    assert.ok(out.includes(listingDump), 'listing dump must be byte-identical');
    assert.ok(!out.includes('\u2026truncated'), 'nothing should be truncated');
    assert.ok(out.includes('<!-- prompt trimmed: dropped [' + SAMPLE_HEADER + '] to fit 52000B budget (was '));
    assert.ok(!out.includes('truncated ['));
    const r = validatePrompt(out);
    assert.ok(r.ok, r.reasons.join('; '));
});

test('oversized valid listing evidence is compacted without breaking JSON', () => {
    const listing = {
        url: 'https://example.test/jobs',
        cardCandidates: Array.from({ length: 100 }, (_, i) => ({
            selector: 'article.job-' + i,
            count: 100 - i,
            sample: 'x'.repeat(1000),
            hrefs: Array.from({ length: 20 }, (__, n) => '/jobs/' + i + '/' + n)
        }))
    };
    const parts = buildParts({
        listingDump: JSON.stringify(listing, null, 2),
        sampleDump: 'S'.repeat(50000)
    });
    const out = trimPartsToBudget(parts, { max: BUDGET, minEvidence: FLOOR });
    const hdrIdx = out.indexOf('\n' + LISTING_HEADER + '\n');
    const fenceStart = out.indexOf('```json\n', hdrIdx) + '```json\n'.length;
    const fenceEnd = out.indexOf('\n```', fenceStart);
    const evidence = JSON.parse(out.slice(fenceStart, fenceEnd));

    assert.ok(Buffer.byteLength(out, 'utf8') <= BUDGET);
    assert.ok(evidence.cardCandidates.length < listing.cardCandidates.length);
    assert.ok(evidence.cardCandidates[0].selector);
});

// ---- 3. under budget: untouched --------------------------------------------

test('under budget: output identical, parts untouched, no marker', () => {
    const parts = buildParts({ listingDump: 'L'.repeat(30000), sampleDump: 'S'.repeat(20000) });
    const snapshot = parts.slice();
    const expected = parts.join('\n');
    assert.ok(expected.length < BUDGET);

    const out = trimPartsToBudget(parts, { max: BUDGET, minEvidence: FLOOR });
    assert.strictEqual(out, expected);
    assert.deepStrictEqual(parts, snapshot);
    assert.ok(!out.includes('prompt trimmed'));

    const small = buildPrompt(promptInputs(200));
    assert.ok(!small.includes('prompt trimmed'));
});

// ---- 4. unfittable: warn, return over budget, keep every header -----------

test('extreme evidence is reduced to the hard budget while keeping every REQUIRED header', () => {
    const fill = {};
    for (const h of [
        '## Before you write code',
        '## Available helpers',
        '## Item shape',
        '## Field requirements',
        '## Reference example',
        '## Edge cases to handle'
    ]) {
        fill[h] = 'F'.repeat(29000); // each under the 30000 block cap, so no rung can shrink them
    }
    const parts = buildParts({ listingDump: 'L'.repeat(10000), fill });
    const warns = [];

    const out = trimPartsToBudget(parts, {
        max: BUDGET,
        minEvidence: FLOOR,
        warn: (msg) => warns.push(msg)
    });

    assert.strictEqual(warns.length, 0);
    assert.ok(Buffer.byteLength(out, 'utf8') <= BUDGET);
    assert.ok(!out.includes('STILL OVER BUDGET'));
    const r = validatePrompt(out);
    assert.deepStrictEqual(r.missing, []);
    assert.ok(r.ok, r.reasons.join('; '));
    assert.ok(out.split('\n').includes(LISTING_HEADER));
});
