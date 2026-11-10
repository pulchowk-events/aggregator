// src/scrapers/diagnostics.js
// Per-source health signals.
//
// Purpose: distinguish "0 items because no events today" (expected, do
// nothing) from "0 items because selectors drifted" or "0 items because
// we got blocked" (both actionable). Silent zero-result runs used to look
// identical to legitimate empty runs; they shouldn't.
//
// Two halves:
//   1. detectPageState(page) — inspect the loaded page for captcha /
//      cloudflare / access-denied text. Cheap enough to call once per
//      listing page.
//   2. classifyOutcome({ items, meta }) — turn a source's result + its
//      metadata into a standard verdict that scrapeAll can log and count
//      consistently across every source.
//
// This module is pure (no disk, no Discord). The caller — scrapeAll, once
// it exists — persists streaks and escalates to Discord when the same
// source returns a non-'ok' verdict N runs in a row.

// Regex sources (kept as strings so they survive the JSON serialization
// page.evaluate does when passing args to the browser context).
const BLOCK_PATTERN_SOURCE = 'cloudflare|checking your browser|captcha|are you a robot|access denied|just a moment|attention required';

async function detectPageState(page) {
    return page.evaluate((patternSource) => {
        const text = (document.body && document.body.innerText) || '';
        const looksBlocked = new RegExp(patternSource, 'i').test(text);
        return { looksBlocked, bodySnippet: text.slice(0, 200) };
    }, BLOCK_PATTERN_SOURCE);
}

// Source result shape that classifyOutcome understands:
//   { items: Item[], meta: { ... } }
// meta fields (all optional; omitted = unknown):
//   looksBlocked          bool    — passed back from detectPageState
//   listingHits           number  — anchor/list matches across all listings
//   pagesVisited          number  — total page.goto() calls
//   detailPagesVisited    number  — subset of pages that were detail pages
//   detailParseFailures   number  — detail pages that produced no title
//
// Verdicts:
//   'ok'                — items > 0, all good.
//   'blocked'           — a page looked blocked (captcha / cloudflare).
//   'dom_drift_listing' — no anchor matches in any category listing;
//                         the listing-page selector is stale.
//   'dom_drift_detail'  — anchors were found but EVERY detail page failed
//                         to extract a title; the detail-page selector is
//                         stale.
//   'empty'             — anchors found, some detail pages parsed, but no
//                         items came out (possible legitimate empty run).
//   'parse_failed'      — anchors found but no item passed sanitization.
//   'extractor_not_implemented' — no real extractor file exists (only
//                                 the .example.js stub) — this source
//                                 is configured but not yet wired.
function classifyOutcome({ items = [], meta = {} } = {}) {
    const count = items.length;
    if (count > 0) return { status: 'ok', count };

    if (meta.extractorMissing) return { status: 'extractor_not_implemented' };
    if (meta.looksBlocked) {
        return { status: 'blocked', bodySnippet: meta.bodySnippet || null };
    }
    if (meta.listingHits === 0) {
        return { status: 'dom_drift_listing', pagesVisited: meta.pagesVisited || 0 };
    }
    if (meta.detailPagesVisited > 0 && meta.detailParseFailures === meta.detailPagesVisited) {
        return { status: 'dom_drift_detail', detailPagesVisited: meta.detailPagesVisited };
    }
    if (meta.detailPagesVisited > 0) {
        return { status: 'empty', detailPagesVisited: meta.detailPagesVisited, detailParseFailures: meta.detailParseFailures || 0 };
    }
    return { status: 'parse_failed', listingHits: meta.listingHits || 0 };
}

module.exports = { detectPageState, classifyOutcome };
