// src/scrapers/itemFilter.js
//
// Universal content-hygiene filter. Applied per-item, after geo scope check,
// before trim. Rules live in src/config/item-filter-rules.json.
//
// Content hygiene only. Scope filtering (is this item from a Nepal-relevant
// location?) lives in src/core/geo.js and runs first. Foreign items never
// reach this module.
//
// Actions:
//   drop                -- item = null (dangerous; nothing downstream sees it)
//   clear_field         -- field set to null (item kept)
//   strip_from_field    -- exact bytes removed from field (item kept)
//   split_field         -- paragraph breaks inserted at boundaries (content preserved)
//   fix_field           -- regex replace (e.g., strip (f/m/d) from title)
//   flag_for_review     -- item.reviewFlags = [...] (item kept; /pending shows badge)
//
// Base-4 sources (sathijob, kumarijob, merojob, internsathi) skip all rules.
// Their extractors produce clean output; any change to posted items is
// regression risk. If a base-4 extractor breaks, that's extractor drift —
// a filter won't save you, and a filter that DOES fire on base-4 would
// silently mangle already-valid items.
//
// Rule processing order: drop first (fail fast), then clear, strip, split,
// fix, flag. Within one action category, rules fire in file order.
// A rule fires if: itemType matches, field exists, matcher matches, AND
// every guard matches. Failure of any guard skips the rule.

const fs = require('fs');
const path = require('path');
const { BASE_4 } = require('../core/geo');

let _rulesCache = null;
function loadRules() {
    if (_rulesCache) return _rulesCache;
    const p = path.join(__dirname, '..', 'config', 'item-filter-rules.json');
    _rulesCache = JSON.parse(fs.readFileSync(p, 'utf8'));
    return _rulesCache;
}

const ACTION_ORDER = ['drop', 'clear_field', 'strip_from_field', 'split_field', 'fix_field', 'flag_for_review'];

function typeToItemType(type) {
    if (type === 'jobs') return 'job';
    if (type === 'events') return 'event';
    if (type === 'scholarships') return 'scholarship';
    return type;
}

// ---------- matchers ----------
// Each returns true when the pattern applies to `value`.
function matches(value, matcher) {
    if (value == null || value === '') return false;
    const s = String(value);
    const sl = s.toLowerCase();
    // Default case-insensitive for text matchers. The rules file carries
    // human-readable phrases ("this vacancy is already fulfilled") while
    // source text is often title-cased ("This vacancy is already fulfilled").
    // Set caseSensitive: true in a matcher when exact casing matters.
    const cs = matcher.caseSensitive === true;
    switch (matcher.kind) {
        case 'substring':
            return cs ? s.includes(matcher.pattern) : sl.includes(String(matcher.pattern).toLowerCase());
        case 'substring_any':
            return (matcher.patterns || []).some(p => cs ? s.includes(p) : sl.includes(String(p).toLowerCase()));
        case 'exact':
            return cs ? s === matcher.pattern : sl === String(matcher.pattern).toLowerCase();
        case 'exact_any':
            return (matcher.patterns || []).some(p => cs ? s === p : sl === String(p).toLowerCase());
        case 'starts_with':
            return cs ? s.startsWith(matcher.pattern) : sl.startsWith(String(matcher.pattern).toLowerCase());
        case 'ends_with':
            return cs ? s.endsWith(matcher.pattern) : sl.endsWith(String(matcher.pattern).toLowerCase());
        case 'regex': {
            try {
                const re = new RegExp(matcher.pattern, matcher.flags || '');
                return re.test(s);
            } catch (e) { return false; }
        }
        case 'field_length': {
            const len = s.length;
            if (matcher.min != null && len < matcher.min) return false;
            if (matcher.max != null && len > matcher.max) return false;
            return true;
        }
        case 'pipe_segment': {
            const labels = (matcher.labels || []).map(l => l.toLowerCase());
            const segments = s.split('|').map(p => p.trim().toLowerCase());
            return segments.some(seg => labels.some(lbl => seg === lbl || seg.startsWith(lbl + ' ') || seg.startsWith(lbl + '-')));
        }
        default:
            return false;
    }
}

function guardsPass(item, guards) {
    if (!Array.isArray(guards) || guards.length === 0) return true;
    for (const g of guards) {
        if (!matches(item[g.field], g.matcher)) return false;
    }
    return true;
}

// ---------- executors ----------
// Each returns { item, applied: bool }. `applied` = rule actually did something.
function execDrop(item, rule) {
    return { item: null, applied: true };
}

function execClearField(item, rule) {
    const before = item[rule.field];
    if (before == null || before === '') return { item, applied: false };
    item[rule.field] = null;
    return { item, applied: true };
}

function execStripFromField(item, rule) {
    const before = item[rule.field];
    if (before == null || before === '') return { item, applied: false };
    let after;

    if (rule.matcher.kind === 'pipe_segment') {
        // Split on pipe, drop matching segments, rejoin with \n\n.
        const labels = (rule.matcher.labels || []).map(l => l.toLowerCase());
        const segments = String(before).split('|').map(p => p.trim()).filter(Boolean);
        const kept = segments.filter(seg => {
            const ls = seg.toLowerCase();
            return !labels.some(lbl => ls === lbl || ls.startsWith(lbl + ' ') || ls.startsWith(lbl + '-'));
        });
        if (kept.length === segments.length) return { item, applied: false };
        after = kept.join('\n\n');
    } else if (rule.matcher.kind === 'substring') {
        const pat = String(rule.matcher.pattern);
        const re = new RegExp(escapeRegex(pat), 'gi');
        if (!re.test(String(before))) return { item, applied: false };
        after = String(before).replace(re, ' ').replace(/\s+/g, ' ').trim();
    } else if (rule.matcher.kind === 'substring_any') {
        let s = String(before);
        let changed = false;
        for (const p of (rule.matcher.patterns || [])) {
            const re = new RegExp(escapeRegex(String(p)), 'gi');
            if (re.test(s)) {
                s = s.replace(re, ' ');
                changed = true;
            }
        }
        if (!changed) return { item, applied: false };
        after = s.replace(/\s+/g, ' ').trim();
    } else if (rule.matcher.kind === 'regex') {
        try {
            const re = new RegExp(rule.matcher.pattern, rule.matcher.flags || 'g');
            const m = String(before).match(re);
            if (!m) return { item, applied: false };
            after = String(before).replace(re, ' ').replace(/\s+/g, ' ').trim();
        } catch (e) { return { item, applied: false }; }
    } else {
        return { item, applied: false };
    }

    if (after === before) return { item, applied: false };
    item[rule.field] = after;
    return { item, applied: true };
}

function execSplitField(item, rule) {
    const before = item[rule.field];
    if (before == null || before === '') return { item, applied: false };
    let s = String(before);
    let changed = false;
    const patterns = rule.matcher.kind === 'substring_any'
        ? (rule.matcher.patterns || [])
        : rule.matcher.kind === 'substring' ? [rule.matcher.pattern] : [];
    for (const p of patterns) {
        const re = new RegExp('(?<!\\n\\n)\\s*' + escapeRegex(String(p)), 'gi');
        if (!re.test(s)) continue;
        const newS = s.replace(re, '\n\n' + p.trim());
        if (newS !== s) { s = newS; changed = true; }
    }
    if (!changed) return { item, applied: false };
    item[rule.field] = s.replace(/\n{3,}/g, '\n\n').trim();
    return { item, applied: true };
}

function execFixField(item, rule) {
    const before = item[rule.field];
    if (before == null || before === '') return { item, applied: false };
    if (rule.matcher.kind !== 'regex') return { item, applied: false };
    try {
        const re = new RegExp(rule.matcher.pattern, rule.matcher.flags || '');
        if (!re.test(String(before))) return { item, applied: false };
        const after = String(before).replace(re, rule.replacement || '').trim();
        if (after === before) return { item, applied: false };
        item[rule.field] = after;
        return { item, applied: true };
    } catch (e) {
        return { item, applied: false };
    }
}

function execFlagForReview(item, rule) {
    if (!Array.isArray(item.reviewFlags)) item.reviewFlags = [];
    const tag = rule.id;
    if (item.reviewFlags.includes(tag)) return { item, applied: false };
    item.reviewFlags.push(tag);
    return { item, applied: true };
}

const EXECUTOR = {
    drop: execDrop,
    clear_field: execClearField,
    strip_from_field: execStripFromField,
    split_field: execSplitField,
    fix_field: execFixField,
    flag_for_review: execFlagForReview
};

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Apply filters to a single item.
 * @param {Object} item
 * @param {string} type  'jobs' | 'events' | 'scholarships' (matches _orchestrate runSource arg)
 * @param {Object} [rulesOverride]  optional; for refine-filters candidate testing
 * @returns {{ item: Object|null, actions: Array<{id,action,field,risk}> }}
 */
function applyItemFilters(item, type, rulesOverride = null) {
    if (!item) return { item, actions: [] };

    // Base-4 short-circuit: no filters fire. See module header.
    if (BASE_4.has(item.source)) return { item, actions: [] };

    const ruleset = rulesOverride || loadRules();
    const itemType = typeToItemType(type);
    const rules = (ruleset.rules || [])
        .filter(r => r.itemType === '*' || r.itemType === itemType)
        .sort((a, b) => ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action));

    const applied = [];
    for (const rule of rules) {
        const fieldVal = rule.field === '*' ? null : item[rule.field];
        if (!guardsPass(item, rule.guards)) continue;

        // Match check -- for '*' field, rule applies unconditionally.
        if (rule.field !== '*') {
            if (!matches(fieldVal, rule.matcher)) continue;
        }

        const exec = EXECUTOR[rule.action];
        if (!exec) continue;
        const res = exec(item, rule);
        if (res.item === null) {
            applied.push({ id: rule.id, action: rule.action, field: rule.field, risk: rule.risk });
            return { item: null, actions: applied };
        }
        if (res.applied) {
            applied.push({ id: rule.id, action: rule.action, field: rule.field, risk: rule.risk });
            item = res.item;
        }
    }
    return { item, actions: applied };
}

module.exports = { applyItemFilters, matches: matches, _loadRules: loadRules };
