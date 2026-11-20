'use strict';

const LISTING_HEADER = '## Evidence dump (listing page)';
const DETAIL_HEADER = '## Evidence dump (sample detail page)';
const FIELD_EVIDENCE_HEADER = '## Field evidence from this site';

function readJsonSection(body, header) {
    const section = body.indexOf(header);
    if (section < 0) return null;
    const fence = body.indexOf('```json', section);
    if (fence < 0) return null;
    const start = fence + '```json'.length;
    const end = body.indexOf('\n```', start);
    if (end < 0) return null;
    try {
        return JSON.parse(body.slice(start, end).trim());
    } catch (e) {
        return null;
    }
}

function hasCandidateEvidence(value) {
    return Array.isArray(value) && value.some((candidate) =>
        candidate && (
            (typeof candidate.selector === 'string' && candidate.selector.length > 0) ||
            (typeof candidate.pattern === 'string' && candidate.pattern.length > 0)
        ));
}

function hasHtmlStructure(body) {
    const pattern = /```html\s*([\s\S]*?)```/g;
    let match;
    while ((match = pattern.exec(body)) !== null) {
        if (/<[a-z][\w:-]*(?:\s|>)/i.test(match[1])) return true;
    }
    return false;
}

function hasFieldEvidence(body) {
    const start = body.indexOf(FIELD_EVIDENCE_HEADER);
    if (start < 0) return false;
    const next = body.indexOf('\n## ', start + FIELD_EVIDENCE_HEADER.length);
    const section = body.slice(start, next < 0 ? body.length : next);
    return /### (?:Structured data|OpenGraph meta|DOM elements found)/.test(section);
}

function hasCapturedPromptEvidence(body) {
    if (typeof body !== 'string') return false;
    if (hasHtmlStructure(body) || hasFieldEvidence(body)) return true;

    const listing = readJsonSection(body, LISTING_HEADER);
    if (listing) {
        if (listing.title || listing.bodySnippet || (Array.isArray(listing.jsonLdTypes) && listing.jsonLdTypes.length > 0)) {
            return true;
        }
        if (hasCandidateEvidence(listing.cardCandidates) ||
            hasCandidateEvidence(listing.cardCandidatesWeak) ||
            hasCandidateEvidence(listing.detailLinkCandidates) ||
            (Array.isArray(listing.anchorGroups) && listing.anchorGroups.length > 0)) {
            return true;
        }
    }

    const detail = readJsonSection(body, DETAIL_HEADER);
    return Boolean(detail && (
        detail.title ||
        (Array.isArray(detail.jsonLdSamples) && detail.jsonLdSamples.length > 0) ||
        (Array.isArray(detail.headings) && detail.headings.length > 0) ||
        detail.descriptionSelector
    ));
}

module.exports = { hasCapturedPromptEvidence };
