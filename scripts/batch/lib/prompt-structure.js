// scripts/batch/lib/prompt-structure.js
// Structural validator for wizard-generated prompts.
//
// The wizard's prompt.js uses one fixed template for every site. If that
// template drifts -- a section dropped, reordered, or the output-instruction
// reworded -- future prompts would produce different LLM answers for what
// should be identical inputs. This module is the guard.
//
// A prompt passes when:
//   1. Every REQUIRED_SECTIONS entry appears exactly once
//   2. Required sections appear in the same relative order as REQUIRED_SECTIONS
//   3. The "## What to output" section contains the canonical output-
//      instruction phrase verbatim (so LLMs reliably reply with one code
//      block, no prose).
//   4. The "## The contract" section contains the canonical contract
//      skeleton markers (module.exports, async extract, return { items, meta })
//   5. The "## Verdict (required)" section contains all three example
//      verdict lines verbatim, so LLMs reliably emit the VERDICT prefix
//      that batch/lib/llm-header.js parses.
//
// OPTIONAL_SECTIONS are checked only for "at most one occurrence" (never
// required, but if present they must be unique).
//
// Match semantics: 'exact' means the line matches byte-for-byte. 'prefix'
// means the line starts with the given text (used for sections whose
// header varies by site type -- "## Reference example -- a working
// listing-to-detail extractor" has a variable suffix). No regex; no
// false positives from escaping.
//
// Pure function. No I/O beyond the file-read helper. Never throws on a
// well-formed string; on malformed input returns a structured failure.

const fs = require('fs');

// Canonical output-instruction phrase. If this changes, edit here AND in
// scripts/wizard/prompt.js, in the same commit. The whole point of a
// byte-identical check is that both must agree.
const REQUIRED_OUTPUT_PHRASE = 'One code block, ready to paste over';

// Canonical contract markers. Each must appear inside "## The contract".
// These are the three load-bearing elements of the extractor API -- if any
// disappear, the LLM's answer might not be a valid extractor.
const REQUIRED_CONTRACT_MARKERS = [
    'module.exports',
    'async extract(page',
    'return { items, meta }'
];

// Verdict-section markers. Every prompt must show the LLM these three
// example verdict lines verbatim; batch/lib/llm-header.js parses them
// from the reply. If prompt.js drifts and one disappears, LLMs will
// silently produce extractors that don't emit verdicts -- wrong-URL
// sites then fail verify as generic drift instead of LLM-NOT-CAREERS.
// Same coupling as REQUIRED_OUTPUT_PHRASE: edit here AND prompt.js
// together, one commit.
const REQUIRED_VERDICT_MARKERS = [
    'VERDICT: CAREERS_PAGE',
    'VERDICT: NOT_CAREERS_PAGE',
    'VERDICT: CAREERS_PAGE_REDIRECT'
];

// Required sections, in required order. The header text matches on prefix
// for variable-suffix sections, exact otherwise.
const REQUIRED_SECTIONS = [
    { match: 'prefix', text: '# Extractor task:' },
    { match: 'exact',  text: '## Target' },
    { match: 'prefix', text: '## Detected site type:' },
    { match: 'prefix', text: '## Before you write code' },
    { match: 'exact',  text: '## The contract' },
    { match: 'exact',  text: '## Available helpers' },
    { match: 'prefix', text: '## Item shape' },
    { match: 'prefix', text: '## Reference example' },
    { match: 'prefix', text: '## Evidence dump (listing page)' },
    { match: 'exact',  text: '## Verdict (required)' },
    { match: 'exact',  text: '## What to output' },
    { match: 'exact',  text: '## Edge cases to handle' }
];

// Optional sections. Must be unique if present.
const OPTIONAL_SECTIONS = [
    { match: 'prefix', text: '## Evidence dump (sample detail page)' }
];

function lineMatches(line, spec) {
    if (spec.match === 'exact') return line === spec.text;
    if (spec.match === 'prefix') return line.startsWith(spec.text);
    throw new Error(`unknown match spec: ${spec.match}`);
}

// Find the line index of a section header in a lines array. Returns -1 if
// not found, -2 if found more than once (duplicated).
function findSection(lines, spec) {
    let idx = -1;
    let count = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lineMatches(lines[i], spec)) {
            count++;
            if (idx === -1) idx = i;
        }
    }
    if (count === 0) return -1;
    if (count > 1) return -2;
    return idx;
}

// Extract the body text between a section header and the next ##-prefixed
// header. Used to inspect the "## What to output" and "## The contract"
// sections for canonical content.
function sectionBody(lines, startIdx) {
    if (startIdx < 0) return '';
    let end = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
        if (/^## /.test(lines[i])) { end = i; break; }
    }
    return lines.slice(startIdx + 1, end).join('\n');
}

// Main validator. Returns:
//   {
//     ok: boolean,
//     sections: { header, found, line },  // per required section
//     missing: [],
//     duplicated: [],
//     outOfOrder: [],
//     outputPhraseOk: boolean,
//     contractMarkersOk: boolean,
//     reasons: [ '...' ]  // human-readable one-liners on failure
//   }
function validatePrompt(text) {
    const reasons = [];
    if (typeof text !== 'string' || !text.trim()) {
        return {
            ok: false,
            sections: {},
            missing: REQUIRED_SECTIONS.map((s) => s.text),
            duplicated: [],
            outOfOrder: [],
            outputPhraseOk: false,
            contractMarkersOk: false,
            reasons: ['empty or non-string prompt']
        };
    }

    const lines = text.split('\n');
    const sections = {};
    const missing = [];
    const duplicated = [];
    const foundIndices = {};

    for (const spec of REQUIRED_SECTIONS) {
        const idx = findSection(lines, spec);
        if (idx === -1) {
            missing.push(spec.text);
            sections[spec.text] = { found: false, line: -1 };
        } else if (idx === -2) {
            duplicated.push(spec.text);
            sections[spec.text] = { found: true, line: -1, duplicated: true };
        } else {
            sections[spec.text] = { found: true, line: idx };
            foundIndices[spec.text] = idx;
        }
    }

    // Order check: the found required sections' line indices must be
    // strictly increasing in the REQUIRED_SECTIONS order.
    const outOfOrder = [];
    let lastLine = -1;
    for (const spec of REQUIRED_SECTIONS) {
        const idx = foundIndices[spec.text];
        if (idx === undefined) continue;
        if (idx < lastLine) outOfOrder.push(spec.text);
        lastLine = idx;
    }

    // Optional sections: uniqueness only.
    for (const spec of OPTIONAL_SECTIONS) {
        const idx = findSection(lines, spec);
        if (idx === -2) duplicated.push(spec.text);
    }

    // Output-instruction phrase.
    const whatToOutputIdx = foundIndices['## What to output'];
    const outputBody = whatToOutputIdx !== undefined ? sectionBody(lines, whatToOutputIdx) : '';
    const outputPhraseOk = outputBody.includes(REQUIRED_OUTPUT_PHRASE);

    // Contract markers.
    const contractIdx = foundIndices['## The contract'];
    const contractBody = contractIdx !== undefined ? sectionBody(lines, contractIdx) : '';
    const contractMarkersOk = REQUIRED_CONTRACT_MARKERS.every((m) => contractBody.includes(m));

    // Verdict markers.
    const verdictIdx = foundIndices['## Verdict (required)'];
    const verdictBody = verdictIdx !== undefined ? sectionBody(lines, verdictIdx) : '';
    const verdictMarkersOk = REQUIRED_VERDICT_MARKERS.every((m) => verdictBody.includes(m));

    if (missing.length) reasons.push(`missing sections: ${missing.join(', ')}`);
    if (duplicated.length) reasons.push(`duplicated sections: ${duplicated.join(', ')}`);
    if (outOfOrder.length) reasons.push(`out-of-order sections: ${outOfOrder.join(', ')}`);
    if (!outputPhraseOk && whatToOutputIdx !== undefined) {
        reasons.push(`"## What to output" missing canonical phrase: "${REQUIRED_OUTPUT_PHRASE}"`);
    }
    if (!contractMarkersOk && contractIdx !== undefined) {
        reasons.push(`"## The contract" missing one of: ${REQUIRED_CONTRACT_MARKERS.join(' | ')}`);
    }
    if (!verdictMarkersOk && verdictIdx !== undefined) {
        reasons.push(`"## Verdict (required)" missing one of: ${REQUIRED_VERDICT_MARKERS.join(' | ')}`);
    }

    return {
        ok: reasons.length === 0,
        sections,
        missing,
        duplicated,
        outOfOrder,
        outputPhraseOk,
        contractMarkersOk,
        verdictMarkersOk,
        reasons
    };
}

// Read + validate a prompt file. Returns the same shape plus `path`.
function validatePromptFile(promptPath) {
    const text = fs.readFileSync(promptPath, 'utf8');
    const result = validatePrompt(text);
    return { ...result, path: promptPath, bytes: text.length };
}

module.exports = {
    validatePrompt,
    validatePromptFile,
    REQUIRED_SECTIONS,
    OPTIONAL_SECTIONS,
    REQUIRED_OUTPUT_PHRASE,
    REQUIRED_CONTRACT_MARKERS,
    REQUIRED_VERDICT_MARKERS
};
