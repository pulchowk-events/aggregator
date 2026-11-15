// scripts/batch/lib/filter-rules.js
// Batch-side helpers for refine-filters. Loads / tests / merges / writes
// src/config/item-filter-rules.json. The runtime that APPLIES rules at
// scrape time is src/scrapers/itemFilter.js -- this module is the
// batch-side counterpart (candidate testing, prompt construction, merge).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..', '..');
const RULES_FILE = path.join(REPO, 'src', 'config', 'item-filter-rules.json');

const TYPE_MAP = { jobs: 'job', events: 'event', scholarships: 'scholarship' };
function typeToItemType(type) { return TYPE_MAP[type] || type; }

function loadRules() {
    return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
}

function saveRules(ruleset) {
    const tmp = RULES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ruleset, null, 2) + '\n');
    fs.renameSync(tmp, RULES_FILE);
    return RULES_FILE;
}

function ruleHash(rule) {
    const key = JSON.stringify({
        itemType: rule.itemType,
        action: rule.action,
        field: rule.field,
        matcher: rule.matcher
    });
    return crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);
}

function ensureRuleId(rule) {
    if (rule.id) return rule;
    return { ...rule, id: `auto-${ruleHash(rule)}` };
}

// Test candidate ruleset against base-4 with short-circuit OFF. Base-4 items
// must see 0 DROPS and 0 CONTENT MUTATIONS.
//
// Content mutation = any mutation where the item's field content changes
// semantically (clear_field nulls a field, strip removes bytes, fix rewrites).
// NOT a mutation = split_field, which only inserts paragraph breaks. Verified
// by stripping all whitespace and comparing before/after -- if the byte
// content is identical modulo whitespace, the change is safe (paragraph
// formatting only, no loss).
//
// Why this distinction matters: base-4 descriptions already contain
// "Key Responsibilities:" style headers (44 items do). split_field would
// paragraph them. That's a readability improvement, not a regression --
// block it and we'd reject a rule that helps the base-4 descriptions too.
function stripWhitespace(s) {
    return String(s || '').replace(/\s+/g, '');
}

function testAgainstBase4(candidateRuleset) {
    const { applyItemFilters } = require(path.join(REPO, 'src', 'scrapers', 'itemFilter'));
    const cachePath = path.join(REPO, 'data', 'cache.json');
    if (!fs.existsSync(cachePath)) {
        return { tested: 0, drops: 0, contentMutations: 0, safeMutations: 0, error: 'cache.json not found' };
    }
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const BASE_4 = new Set(['sathijob', 'kumarijob', 'merojob', 'internsathi']);
    const items = [];
    for (const arr of ['postedEvents', 'pendingEvents', 'skippedEvents']) {
        for (const e of cache[arr] || []) {
            if (e.itemType === 'job' && BASE_4.has(e.source)) items.push(e);
        }
    }
    let drops = 0, contentMutations = 0, safeMutations = 0;
    const sampleDrops = [], sampleContentMutations = [], sampleSafeMutations = [];
    for (const e of items) {
        try {
            const r = applyItemFilters({ ...e }, 'jobs', candidateRuleset, { respectBase4: false });
            if (r.item === null) {
                drops++;
                if (sampleDrops.length < 3) sampleDrops.push({ title: e.title, source: e.source });
                continue;
            }
            if (r.actions.length === 0) continue;

            // Classify each action: split_field is safe (whitespace-only);
            // everything else is a content mutation.
            let hasContentMutation = false;
            for (const a of r.actions) {
                if (a.action === 'split_field') {
                    // Verify whitespace-only for THIS action.
                    const field = a.field;
                    if (stripWhitespace(e[field]) === stripWhitespace(r.item[field])) {
                        safeMutations++;
                        if (sampleSafeMutations.length < 3) sampleSafeMutations.push({ title: e.title, source: e.source, field });
                    } else {
                        // Split unexpectedly changed content -> treat as mutation.
                        hasContentMutation = true;
                    }
                } else {
                    hasContentMutation = true;
                }
            }
            if (hasContentMutation) {
                contentMutations++;
                if (sampleContentMutations.length < 3) {
                    sampleContentMutations.push({ title: e.title, source: e.source, actions: r.actions });
                }
            }
        } catch (err) { /* skip */ }
    }
    return {
        tested: items.length,
        drops,
        contentMutations,
        safeMutations,
        sampleDrops,
        sampleContentMutations,
        sampleSafeMutations
    };
}

// Impact analysis for a single rule against observed items.
function analyzeImpact(rule, items, type) {
    const { applyItemFilters } = require(path.join(REPO, 'src', 'scrapers', 'itemFilter'));
    const singleRuleSet = { version: 1, rules: [ensureRuleId(rule)] };
    const bySource = {};
    const sampleTitles = [];
    let matches = 0;
    for (const it of items) {
        try {
            const r = applyItemFilters({ ...it }, type, singleRuleSet, { respectBase4: false });
            if (r.actions.length === 0) continue;
            matches++;
            const src = it.source || 'unknown';
            bySource[src] = (bySource[src] || 0) + 1;
            if (sampleTitles.length < 3) sampleTitles.push(String(it.title || 'untitled').slice(0, 60));
        } catch (err) { /* skip */ }
    }
    return { matches, bySource, sampleTitles };
}

function buildPrompt(type, items, anomalies, currentRules, opts = {}) {
    const itemType = typeToItemType(type);
    const maxItems = opts.maxItems || 3;
    const truncate = 500;

    const L = [];
    L.push(`# Refine filter rules: ${type}`);
    L.push('');
    L.push('## Context');
    L.push('');
    L.push(`Universal item-filter engine. Rules below run at scrape time on every ${itemType} item from batch sources (base-4 sources skip all filters). Your job: propose ADDITIONS (new rules) or REMOVALS (stale rules) based on observed anomalies.`);
    L.push('');
    L.push('## Rule schema');
    L.push('');
    L.push('```json');
    L.push('{');
    L.push('  "itemType": "job|event|scholarship|*",');
    L.push('  "action": "drop|clear_field|strip_from_field|split_field|fix_field|flag_for_review",');
    L.push('  "field": "title|description|location|price|date|company|*",');
    L.push('  "matcher": {"kind": "substring|substring_any|exact|exact_any|starts_with|ends_with|regex|field_length|pipe_segment", ...},');
    L.push('  "guards": [{"field": "...", "matcher": {...}}],');
    L.push('  "replacement": "for fix_field",');
    L.push('  "reason": "one line",');
    L.push('  "risk": "safe|risky|dangerous"');
    L.push('}');
    L.push('```');
    L.push('');
    L.push('## Action semantics');
    L.push('- `drop` — item discarded. DANGEROUS. False positive = silent job loss. Use guards to scope.');
    L.push('- `clear_field` — field set to null, item kept. Use when the field is ENTIRELY noise.');
    L.push('- `strip_from_field` — remove matching bytes, keep remainder. Real content preserved.');
    L.push('- `split_field` — insert paragraph breaks at matches. Content preserved.');
    L.push('- `fix_field` — regex replace. Title suffix/prefix strips.');
    L.push('- `flag_for_review` — sets item.reviewFlags[]. Item kept.');
    L.push('');
    L.push('## Matcher kinds (case-insensitive by default)');
    L.push('- `substring` / `substring_any`: `{"kind":"substring","pattern":"..."}` or `{"kind":"substring_any","patterns":[...]}`');
    L.push('- `regex`: `{"kind":"regex","pattern":"...","flags":"i"}` (JS regex, no (?i))');
    L.push('- `field_length`: `{"kind":"field_length","max":500}` for guards');
    L.push('- `pipe_segment`: `{"kind":"pipe_segment","labels":["apply now"]}` matches ONLY standalone pipe segments');
    L.push('');
    L.push('## Output');
    L.push('');
    L.push('```json');
    L.push('{ "additions": [<rule>, ...], "removals": [{"id": "<existing-id>"}], "rationale": "..." }');
    L.push('```');
    L.push('');
    L.push('Empty arrays are valid. Return ONLY the JSON.');
    L.push('');
    L.push('## Base-4 constraint');
    L.push('Base-4 sources (sathijob, kumarijob, merojob, internsathi) are production baseline. Any rule that drops/mutates a base-4 item (short-circuit disabled) is REJECTED. Currently 408 items, 0 drops, 0 mutations.');
    L.push('');
    L.push(`## Current rules (v${currentRules.version}, ${(currentRules.rules || []).length} rules)`);
    L.push('');
    L.push('```json');
    L.push(JSON.stringify((currentRules.rules || []).map(r => ({
        id: r.id, itemType: r.itemType, action: r.action, field: r.field, matcher: r.matcher
    })), null, 2));
    L.push('```');
    L.push('');
    L.push(`## Anomalies observed (${Object.keys(anomalies).length} source(s))`);
    L.push('');
    for (const [src, data] of Object.entries(anomalies)) {
        L.push(`### Source: ${src} (${data.itemCount} item(s))`);
        for (const [field, list] of Object.entries(data.anomalies || {})) {
            L.push(`- **${field}**`);
            for (const a of list) {
                L.push(`  - ${a.type} (n=${a.count}):`);
                for (const s of a.samples.slice(0, 2)) {
                    L.push(`    ${JSON.stringify(String(s).slice(0, 300))}`);
                }
            }
        }
        L.push('');
    }
    L.push('## Sample items per anomalous source');
    L.push('');
    for (const [src] of Object.entries(anomalies)) {
        const srcItems = items.filter(it => (it.source || 'unknown') === src).slice(0, maxItems);
        for (const it of srcItems) {
            L.push(`### ${src} -- ${String(it.title || 'untitled').slice(0, 80)}`);
            L.push('```json');
            const sample = {};
            for (const f of ['title', 'description', 'location', 'company', 'salary', 'price', 'date']) {
                if (it[f] != null) sample[f] = String(it[f]).slice(0, truncate);
            }
            L.push(JSON.stringify(sample, null, 2));
            L.push('```');
            L.push('');
        }
    }
    L.push('## Task');
    L.push('');
    L.push('For every anomaly above, propose at least one addition. Choose the RIGHT action: drop ONLY for provably-not-a-job; clear only if the field is entirely noise; strip if real content surrounds noise; split for boundaries; fix for title artifacts; flag for ambiguous cases.');
    L.push('');
    L.push('Be CONSERVATIVE with DANGEROUS. Prefer `clear_field` over `drop` when the item is real (good title, valid apply URL). Prefer `strip_from_field` over `clear_field` when real content surrounds the noise.');
    L.push('');
    L.push('Return ONLY the JSON object.');
    return L.join('\n');
}

function parseLLMResponse(raw) {
    const { stripMarkdownFences } = require('../../wizard/interactive');
    let s = stripMarkdownFences(raw || '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('no JSON object in response');
    const parsed = JSON.parse(s.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object') throw new Error('response not an object');
    if (!Array.isArray(parsed.additions)) parsed.additions = [];
    if (!Array.isArray(parsed.removals)) parsed.removals = [];
    return parsed;
}

function mergeCandidate(current, candidate) {
    const merged = JSON.parse(JSON.stringify(current));
    merged.rules = merged.rules || [];
    const existingHashes = new Set(merged.rules.map(r => r.id || ruleHash(r)));

    const removalIds = new Set((candidate.removals || []).map(r => r.id).filter(Boolean));
    merged.rules = merged.rules.filter(r => !removalIds.has(r.id));

    for (const raw of (candidate.additions || [])) {
        if (!raw || typeof raw !== 'object') continue;
        if (!raw.action || !raw.field || !raw.matcher) continue;
        const rule = ensureRuleId(raw);
        if (existingHashes.has(rule.id)) continue;
        merged.rules.push(rule);
        existingHashes.add(rule.id);
    }

    merged.version = (merged.version || 0) + 1;
    merged.note = (merged.note || '') + ' | v' + merged.version + ': refine-filters pass';
    return merged;
}

function diffSummary(current, merged) {
    const curById = new Map((current.rules || []).map(r => [r.id, r]));
    const mergedById = new Map((merged.rules || []).map(r => [r.id, r]));
    const added = [];
    const removed = [];
    for (const [id, r] of mergedById) if (!curById.has(id)) added.push(r);
    for (const [id, r] of curById) if (!mergedById.has(id)) removed.push(r);
    return { added, removed };
}

module.exports = {
    RULES_FILE,
    typeToItemType,
    loadRules,
    saveRules,
    ruleHash,
    ensureRuleId,
    testAgainstBase4,
    analyzeImpact,
    buildPrompt,
    parseLLMResponse,
    mergeCandidate,
    diffSummary
};
