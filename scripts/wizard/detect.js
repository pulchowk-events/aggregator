'use strict';
// scripts/wizard/detect.js
// Site-shape classification from dump output. Pure function: takes what
// dump.js produced, returns a structured verdict the prompt generator
// turns into natural language.
//
// Types:
//   'jsonld-first'       detail pages carry Event/EducationEvent/JobPosting JSON-LD
//   'listing-to-detail'  top card group has distinct per-card links (real detail pages)
//   'single-page-cards'  card group exists, cards do not link to distinct pages
//   'single-posting'     no card list, listing-level JSON-LD says it is one posting/event
//   'hub'                card group is a set of category/CTA labels, not items
//   'unknown-shape'      nothing clearly points one way (never defaults to listing-to-detail)
//
// Signals (booleans on the verdict): isPaginated, isVirtualized, hasCategories,
// hasJsonLd, hasDetailJsonLd, hasCardWrapper, emptyState.

const JSONLD_DETAIL = /Event|EducationEvent|JobPosting/;
const EMPTY_STATE = /\b(no (open |current )?(jobs|positions|openings|vacancies)|no positions? available)\b/i;
const CTA_LABEL = /^(learn more|read more|view (all|more)|see more|know more|explore|details?|apply( now)?)$/i;

function absUrl(h, base) {
    try { return new URL(h, base).href; } catch (e) { return null; }
}

function isCategoryLabel(s) {
    const t = String(s || '').trim();
    if (!t) return false;
    if (CTA_LABEL.test(t)) return true;
    const words = t.split(/\s+/);
    return words.length <= 2 && t.length <= 24 && /[A-Z]/.test(t) && t === t.toUpperCase();
}

function usableCards(listing) {
    const cc = Array.isArray(listing.cardCandidates) ? listing.cardCandidates : [];
    return cc.filter((c) => c && c.count >= 3 && !c.looksLikeSectionWrapper);
}

function patternOf(href) {
    let u;
    try { u = new URL(href, 'http://x.invalid'); } catch (e) { return null; }
    return '/' + u.pathname.split('/').filter(Boolean).map((seg) => {
        if (/^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg) || /^[0-9a-f-]{20,}$/i.test(seg)) return '<id>';
        return seg;
    }).join('/');
}

// Pick one real detail URL to sample. dump.js strips anchorGroups samples,
// so prefer detailLinkCandidates and card hrefs; legacy anchorGroup last.
function pickDetailUrl(listing, baseUrl, legacyPattern) {
    const l = listing || {};
    const base = baseUrl || l.url;
    const abs = (h) => absUrl(h, base);
    const cand = (l.detailLinkCandidates || []).find((c) => c && Array.isArray(c.samples) && c.samples[0] && c.samples[0].href);
    if (cand) {
        const href = abs(cand.samples[0].href);
        if (href) return { href, label: 'detailLinkCandidates ' + cand.pattern + ' (' + cand.count + ' matches)' };
    }
    for (const c of usableCards(l)) {
        const href = (c.hrefs || []).map(abs).find((h) => h && h !== base);
        if (href) return { href, label: 'card hrefs ' + c.selector + ' (' + c.hrefs.length + ' distinct)' };
    }
    if (legacyPattern && Array.isArray(legacyPattern.samples) && legacyPattern.samples[0] && legacyPattern.samples[0].href) {
        const href = abs(legacyPattern.samples[0].href);
        if (href) return { href, label: 'anchorGroup ' + legacyPattern.pattern + ' (' + legacyPattern.count + ' matches)' };
    }
    return null;
}

function detectSiteType(listing, detail = null) {
    const l = listing || {};
    const cards = usableCards(l);
    const top = cards[0] || null;
    const jsonLdTypes = Array.isArray(l.jsonLdTypes) ? l.jsonLdTypes : [];
    const signals = {
        isPaginated: Boolean(l.pagination && (l.pagination.hasNextRel || l.pagination.pageParamCount > 0)),
        isVirtualized: Boolean(l.pagination && l.pagination.hasLoadMore),
        hasCategories: Boolean(l.categoryChips && l.categoryChips.length > 0),
        hasJsonLd: jsonLdTypes.length > 0,
        hasDetailJsonLd: Boolean(detail && detail.jsonLdSamples && detail.jsonLdSamples.length > 0),
        hasCardWrapper: Boolean(top),
        emptyState: EMPTY_STATE.test(l.bodySnippet || '')
    };

    // 1. Detail JSON-LD wins.
    if (signals.hasDetailJsonLd) {
        const ld = detail.jsonLdSamples.find((s) => JSONLD_DETAIL.test(String(s.type)));
        if (ld) {
            return { type: 'jsonld-first', signals, evidence: { jsonLdType: ld.type, jsonLdKeys: ld.keys } };
        }
    }

    if (top) {
        // 2. Hub: cards are category labels / CTAs, not items.
        const labels = (top.childSamples || []).filter(Boolean);
        if (labels.length >= 2 && labels.filter(isCategoryLabel).length >= Math.ceil(labels.length * 0.6)) {
            return { type: 'hub', signals, evidence: { cardSelector: top.selector, cardCount: top.count, labels: labels.slice(0, 4) } };
        }
        // 3. Distinct per-card links -> listing-to-detail.
        const hrefs = Array.from(new Set((top.hrefs || []).filter(Boolean)));
        if (hrefs.length >= 3 && hrefs.length >= top.count * 0.6) {
            const dl = (l.detailLinkCandidates || []).find((c) => c && c.appearsInCards);
            return {
                type: 'listing-to-detail',
                signals,
                evidence: {
                    cardSelector: top.selector,
                    detailLinkPattern: (dl && dl.pattern) || patternOf(hrefs[0]),
                    detailLinkCount: hrefs.length,
                    sampleHrefs: hrefs.slice(0, 3).map((h) => absUrl(h, l.url)).filter(Boolean)
                }
            };
        }
        // 4. Cards without distinct links.
        return { type: 'single-page-cards', signals, evidence: { cardSelector: top.selector, cardCount: top.count } };
    }

    // 5. No card list, but listing-level JSON-LD describes one posting/event.
    if (jsonLdTypes.some((t) => JSONLD_DETAIL.test(String(t)))) {
        return { type: 'single-posting', signals, evidence: { jsonLdTypes } };
    }

    // 6. Nothing to go on. Never default to listing-to-detail.
    return { type: 'unknown-shape', signals, evidence: { emptyState: signals.emptyState } };
}

module.exports = { detectSiteType, pickDetailUrl };
