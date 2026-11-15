// src/scrapers/universalNormalize.js
//
// Universal post-extraction normalization. Runs in _orchestrate.js after
// itemFilter, before geo. Applies to every job source uniformly; base-4
// sources short-circuit entirely.
//
// Responsibilities:
//   1. Deadline parse: applicationEndsRaw (text) -> applicationEndsDate (ISO)
//      + daysLeftAtListTime (int)
//   2. Expiry drop: applicationEndsDate < now -> drop item
//   3. Nav-dump description: 2+ known nav/footer phrases -> clear description
//   4. Qual-leak location: string looks like qualification, not place -> clear
//
// Extractors are dumb: they extract raw text. All validation lives here.
// Base-4 sources produce clean output and skip all four checks -- their
// extractors already do the equivalent work and any change is regression.

const { BASE_4 } = require('../core/geo');

const NAV_MARKERS = [
    'skip to content',
    'all rights reserved',
    'privacy policy',
    'terms of service',
    'powered by',
    'subscribe to our newsletter',
    'cookie policy',
    'accept cookies'
];

const QUAL_LEAK_START = /^(bachelor|master|b\.?sc|b\.?a|b\.?b\.?a|m\.?sc|m\.?b\.?a|mba|bba|bim|bbs|degree|diploma|high school|secondary)/i;
const QUAL_LEAK_CONTAINS = /\b(years? of experience|years? experience|computer science|information technology|business administration|software engineering)\b/i;

function parseRawDate(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const cleaned = raw.trim().replace(/^(apply\s*before|apply\s*by|deadline)\s*[:\-]?\s*/i, '').trim();
    const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    const d = new Date(cleaned);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return null;
}

function daysLeft(isoDate) {
    if (!isoDate) return null;
    const target = new Date(isoDate + 'T23:59:59Z').getTime();
    if (!Number.isFinite(target)) return null;
    return Math.floor((target - Date.now()) / 86400000);
}

function isNavDump(desc) {
    if (!desc || typeof desc !== 'string' || desc.length < 100) return false;
    const lower = desc.toLowerCase();
    let hits = 0;
    for (const marker of NAV_MARKERS) {
        if (lower.includes(marker) && ++hits >= 2) return true;
    }
    return false;
}

function isQualLeak(loc) {
    if (!loc || typeof loc !== 'string') return false;
    const s = loc.trim();
    if (s.length === 0 || s.length > 120) return false;
    if (QUAL_LEAK_START.test(s)) return true;
    if (QUAL_LEAK_CONTAINS.test(s)) return true;
    return false;
}

function applyUniversalNormalize(item, source) {
    if (!item) return { item, dropped: false, reasons: [] };
    if (BASE_4.has(source)) return { item, dropped: false, reasons: [] };

    const reasons = [];

    // 1. Parse deadline if not already parsed
    if (item.applicationEndsRaw && !item.applicationEndsDate) {
        const parsed = parseRawDate(item.applicationEndsRaw);
        if (parsed) {
            item.applicationEndsDate = parsed;
            item.daysLeftAtListTime = daysLeft(parsed);
        }
    }

    // 2. Expiry drop
    if (item.daysLeftAtListTime != null && item.daysLeftAtListTime < 0) {
        return { item: null, dropped: true, reasons: ['expired'] };
    }

    // 3. Nav-dump description
    if (isNavDump(item.description)) {
        item.description = null;
        reasons.push('nav_dump_cleared');
    }

    // 4. Qual-leak location
    if (isQualLeak(item.location)) {
        item.location = null;
        reasons.push('qual_leak_cleared');
    }

    return { item, dropped: false, reasons };
}

module.exports = { applyUniversalNormalize, parseRawDate, daysLeft, isNavDump, isQualLeak };
