// scripts/test/prompt.trimmer.test.js
// Bug 3a: the 118KB trimmer must never delete a REQUIRED section.
// Test 1 goes through buildPrompt and proves the bug on unpatched code.
// Tests 2-4 exercise trimPartsToBudget (skipped until it is exported).
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

const BUDGET = 118000;
const FLOOR = 4096;
const LISTING_HEADER = '## Evidence dump (listing page)';
const SAMPLE_HEADER = '## Evidence dump (sample detail page)';
const NOTE_RE = /\n\u2026truncated (\d+) bytes/;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-trimmer-'));
test.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const needsExport = typeof trimPartsToBudget === 'function'
    ? {}
    : { skip: 'RED: trimPartsToBudget is not exported yet' };

// ---- fixtures ------------------------------------------------------------

function promptInputs(blobSize) {
    return {
        name: 'fixture-co',
        type: 'jobs',
        url: 'https://example.test/careers',
        listing: {
            cardCandidates: [{ selector: 'div.card', count: 5, jobTitleRatio: 0.9 }],
            blob: 'x'.repeat(blobSize)
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

test('over-budget buildPrompt keeps every REQUIRED section', () => {
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

    const wasMatch = /\(was (\d+)B\)/.exec(out);
    assert.ok(out.includes('prompt trimmed') && wasMatch && Number(wasMatch[1]) > BUDGET,
        'FIXTURE: the over-budget input did not exceed 118000 before trimming');

    const file = path.join(tmpDir, 'over-budget.md');
    fs.writeFileSync(file, out);
    const r = validatePromptFile(file);

    // This is the assertion that fails on unpatched code.
    assert.deepStrictEqual(r.missing, [],
        'over-budget prompt lost REQUIRED sections: ' + r.missing.join(' | '));
    assert.ok(r.ok, 'validatePromptFile rejected the trimmed prompt: ' + r.reasons.join('; '));
    assert.ok(out.length <= BUDGET, 'output is ' + out.length + ' chars, over ' + BUDGET);

    // Listing header present exactly once, body kept at least FLOOR, marker accurate.
    assert.strictEqual(out.split('\n').filter((l) => l === LISTING_HEADER).length, 1);
    const hdrIdx = out.indexOf('\n' + LISTING_HEADER + '\n');
    const fenceStart = out.indexOf('```json\n', hdrIdx) + '```json\n'.length;
    const m = NOTE_RE.exec(out.slice(fenceStart));
    assert.ok(m, 'truncation marker missing from the listing dump');
    const body = out.slice(fenceStart, fenceStart + m.index);
    assert.ok(body.length >= FLOOR, 'listing dump kept only ' + body.length + ' chars');
    const orig = JSON.stringify(inputs.listing, null, 2);
    assert.strictEqual(orig.slice(0, body.length), body);
    assert.strictEqual(Number(m[1]), orig.length - body.length);

    // The fence around the dump is still closed.
    assert.strictEqual(fenceCount(out) % 2, fenceCount(small) % 2, 'code fences are unbalanced');
});

// ---- 2. mild overflow: only the optional section goes ----------------------

test('sample-detail drop alone is enough; listing dump untouched', needsExport, () => {
    const listingDump = 'L'.repeat(20000);
    const parts = buildParts({ listingDump, sampleDump: 'S'.repeat(110000) });
    assert.ok(parts.join('\n').length > BUDGET);

    const out = trimPartsToBudget(parts, {
        max: BUDGET,
        minEvidence: FLOOR,
        warn: () => { throw new Error('unexpected warn'); }
    });

    assert.ok(out.length <= BUDGET);
    assert.ok(!out.split('\n').includes(SAMPLE_HEADER), 'sample-detail section should be dropped');
    assert.ok(out.includes(listingDump), 'listing dump must be byte-identical');
    assert.ok(!out.includes('\u2026truncated'), 'nothing should be truncated');
    assert.ok(out.includes('<!-- prompt trimmed: dropped [' + SAMPLE_HEADER + '] to fit 118000B budget (was '));
    assert.ok(!out.includes('truncated ['));
    const r = validatePrompt(out);
    assert.ok(r.ok, r.reasons.join('; '));
});

// ---- 3. under budget: untouched --------------------------------------------

test('under budget: output identical, parts untouched, no marker', needsExport, () => {
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

test('unfittable: warns, returns over budget, keeps every REQUIRED header', needsExport, () => {
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

    assert.strictEqual(warns.length, 1);
    assert.ok(out.length > BUDGET);
    assert.ok(out.includes('STILL OVER BUDGET'));
    const r = validatePrompt(out);
    assert.deepStrictEqual(r.missing, []);
    assert.ok(r.ok, r.reasons.join('; '));
    assert.ok(out.includes('L'.repeat(FLOOR)), 'listing dump should keep at least the floor');
});
