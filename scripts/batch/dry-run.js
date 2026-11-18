// scripts/batch/dry-run.js
// Policy-only dry run: pipes data/batch/<run>/results/<name>.items.json
// through the same item-level gates post.js applies in the live path.
// No Discord, no cache read, no sanitize call.
//
// Gate order (mirrors src/posting/post.js):
//   no_category -> [category_paused: skipped] -> no_channel
//   -> no_image (main only) -> data_quality_warning (main only)
//   -> [already_posted: skipped]
// force=false is assumed. no_category / no_channel are evaluated only when
// injectable resolvers are supplied; otherwise they are "not evaluated" and
// never pass or fail an item.

'use strict';

const fs = require('fs');
const path = require('path');
const { resolveRunDir, paths, itemsPath } = require('./lib/paths');
const gates = require('../../src/posting/gates');

const ITEMS_SUFFIX = '.items.json';
const MODES = ['main', 'test'];
const REASON_ORDER = ['invalid_item', 'no_category', 'no_channel', 'no_image', 'data_quality_warning'];

function parseDryRunArgs(argv) {
    const a = Array.isArray(argv) ? argv : [];
    const args = { run: null, mode: null, source: null, itemsDir: null, json: false };
    const need = (i, flag) => {
        const v = a[i + 1];
        if (v === undefined || String(v).startsWith('--')) throw new Error(`${flag} requires a value`);
        return v;
    };
    for (let i = 0; i < a.length; i++) {
        const t = a[i];
        if (t === '--run') { args.run = need(i, t); i++; }
        else if (t === '--mode') { args.mode = need(i, t); i++; }
        else if (t === '--source') { args.source = need(i, t); i++; }
        else if (t === '--items') { args.itemsDir = need(i, t); i++; }
        else if (t === '--json') { args.json = true; }
        else throw new Error(`unknown argument: ${t}`);
    }
    if (args.mode && !MODES.includes(args.mode)) {
        throw new Error(`--mode must be one of: ${MODES.join(', ')}`);
    }
    return args;
}

// Returns { ok: true } or { ok: false, reason }.
// opts.resolveCategory(item) -> categoryKey | falsy   (optional)
// opts.resolveChannel(categoryKey, mode) -> id | falsy (optional)
function evaluateItem(item, mode, opts) {
    opts = opts || {};
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, reason: 'invalid_item' };
    }
    let categoryKey = null;
    if (typeof opts.resolveCategory === 'function') {
        categoryKey = opts.resolveCategory(item);
        if (!categoryKey) return { ok: false, reason: 'no_category' };
    }
    if (typeof opts.resolveChannel === 'function' && categoryKey) {
        if (!opts.resolveChannel(categoryKey, mode)) return { ok: false, reason: 'no_channel' };
    }
    if (mode === 'main') {
        if (!gates.hasValidImage(null, item)) return { ok: false, reason: 'no_image' };
        if (gates.hasDataQualityWarnings(item)) return { ok: false, reason: 'data_quality_warning' };
    }
    return { ok: true };
}

function resolveItemsDir(opts) {
    if (opts.itemsDir) return path.resolve(opts.itemsDir);
    if (!opts.run) throw new Error('--run <id> is required (or --items <dir>)');
    return paths(resolveRunDir(opts.run)).results;
}

function fileFor(opts, dir, name) {
    if (opts.itemsDir) return path.join(dir, name + ITEMS_SUFFIX);
    return itemsPath(opts.run, name);
}

function readVerify(dir, name) {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'));
        if (j && j.pass === true) return 'pass';
        if (j && j.pass === false) return 'fail';
    } catch (_) { /* absent or unreadable: unknown */ }
    return '-';
}

function newStat() { return { ok: 0, rejected: 0, reasons: {} }; }

function tally(stat, res) {
    if (res.ok) { stat.ok++; return; }
    stat.rejected++;
    stat.reasons[res.reason] = (stat.reasons[res.reason] || 0) + 1;
}

function analyzeRun(opts) {
    opts = opts || {};
    const dir = resolveItemsDir(opts);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`items dir not found: ${dir}`);
    }
    const modes = opts.mode ? [opts.mode] : MODES.slice();
    const catEval = typeof opts.resolveCategory === 'function';
    const chanEval = catEval && typeof opts.resolveChannel === 'function';

    let names = fs.readdirSync(dir)
        .filter((f) => f.endsWith(ITEMS_SUFFIX))
        .map((f) => f.slice(0, -ITEMS_SUFFIX.length))
        .sort();
    if (opts.source) {
        if (!names.includes(opts.source)) throw new Error(`source not found in ${dir}: ${opts.source}`);
        names = [opts.source];
    }

    const aggregate = { items: 0, modes: {} };
    for (const m of modes) aggregate.modes[m] = newStat();
    const sources = [];
    const errors = [];

    for (const name of names) {
        const row = { name, verify: readVerify(dir, name), items: 0, modes: {} };
        for (const m of modes) row.modes[m] = newStat();
        let items;
        try {
            items = JSON.parse(fs.readFileSync(fileFor(opts, dir, name), 'utf8'));
            if (!Array.isArray(items)) throw new Error('top level is not an array');
        } catch (e) {
            row.error = `cannot read/parse ${name}${ITEMS_SUFFIX}: ${e.message}`;
            errors.push(row.error);
            sources.push(row);
            continue;
        }
        row.items = items.length;
        aggregate.items += items.length;
        for (const it of items) {
            for (const m of modes) {
                const res = evaluateItem(it, m, opts);
                tally(row.modes[m], res);
                tally(aggregate.modes[m], res);
            }
        }
        sources.push(row);
    }

    return {
        run: opts.run || '(stub)',
        itemsDir: dir,
        modes,
        gates: {
            evaluated: ['no_image', 'data_quality_warning']
                .concat(catEval ? ['no_category'] : [])
                .concat(chanEval ? ['no_channel'] : []),
            skipped: ['already_posted (no cache read)', 'category_paused (no cache read)'],
            notEvaluated: [].concat(catEval ? [] : ['no_category']).concat(chanEval ? [] : ['no_channel']),
            force: false,
            sanitize: 'warnings as persisted, no re-sanitize'
        },
        sources,
        aggregate,
        errors
    };
}

function pct(n, d) { return d ? (100 * n / d).toFixed(1) + '%' : '-'; }

function table(headers, rows) {
    const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
    const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
    return [line(headers), line(w.map((n) => '-'.repeat(n))), ...rows.map(line)].join('\n');
}

function renderText(report) {
    const out = [];
    const g = report.gates;
    out.push('DRY RUN - posting gates (policy only, nothing is sent)');
    out.push(`run:           ${report.run}`);
    out.push(`items dir:     ${report.itemsDir}`);
    out.push(`mode(s):       ${report.modes.join(', ')}   (force=false)`);
    out.push(`evaluated:     ${g.evaluated.join(', ')}`);
    out.push(`skipped:       ${g.skipped.join(', ')}`);
    out.push(`not evaluated: ${g.notEvaluated.length ? g.notEvaluated.join(', ') + ' (no resolver supplied)' : '(none)'}`);
    out.push(`sanitize:      ${g.sanitize}`);
    out.push('');

    const showMain = report.modes.includes('main');
    const showTest = report.modes.includes('test');
    const evalCat = g.evaluated.includes('no_category');
    const evalChan = g.evaluated.includes('no_channel');
    const headers = ['source', 'run', 'verify', 'items', 'main_ok', 'test_ok', 'rejected_main', 'no_image', 'data_quality_warning'];
    if (evalCat) headers.push('no_category');
    if (evalChan) headers.push('no_channel');
    const rows = report.sources.map((s) => {
        if (s.error) {
            const r = [s.name, report.run, s.verify, 'ERR', '-', '-', '-', '-', '-'];
            if (evalCat) r.push('-');
            if (evalChan) r.push('-');
            return r;
        }
        const m = s.modes.main;
        const t = s.modes.test;
        const r = [
            s.name, report.run, s.verify, s.items,
            showMain ? m.ok : '-',
            showTest ? t.ok : '-',
            showMain ? m.rejected : '-',
            showMain ? (m.reasons.no_image || 0) : '-',
            showMain ? (m.reasons.data_quality_warning || 0) : '-'
        ];
        const any = showMain ? m : t;
        if (evalCat) r.push(any.reasons.no_category || 0);
        if (evalChan) r.push(any.reasons.no_channel || 0);
        return r;
    });
    out.push('PER SOURCE');
    out.push(rows.length ? table(headers, rows) : '(no *.items.json files found)');
    out.push('');

    const total = report.aggregate.items;
    out.push('AGGREGATE');
    out.push(`total items:        ${total}`);
    if (showMain) out.push(`postable to main:   ${report.aggregate.modes.main.ok} (${pct(report.aggregate.modes.main.ok, total)})`);
    if (showTest) out.push(`postable to test:   ${report.aggregate.modes.test.ok} (${pct(report.aggregate.modes.test.ok, total)})`);
    out.push('');

    for (const m of report.modes) {
        const st = report.aggregate.modes[m];
        out.push(`REJECTION HISTOGRAM (${m}, first failing gate, each item counted once)`);
        const hrows = [['postable', st.ok, pct(st.ok, total)]];
        const reasons = Object.keys(st.reasons).sort((a, b) => {
            const ia = REASON_ORDER.indexOf(a), ib = REASON_ORDER.indexOf(b);
            return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
        for (const r of reasons) hrows.push([r, st.reasons[r], pct(st.reasons[r], total)]);
        out.push(table(['reason', 'count', 'pct'], hrows));
        if (g.notEvaluated.length) {
            const n = st.ok + st.rejected;
            out.push(`not_evaluated: ${g.notEvaluated.map((x) => `${x}=${n}`).join(', ')} (gate skipped for these items, not counted as pass or fail)`);
        }
        out.push('');
    }

    if (report.errors.length) {
        out.push('ERRORS');
        for (const e of report.errors) out.push('  ' + e);
        out.push('');
    }
    return out.join('\n');
}

function runDryRun(opts) {
    const report = analyzeRun(opts);
    if (!opts || opts.print !== false) {
        console.log(opts && opts.json ? JSON.stringify(report, null, 2) : renderText(report));
    }
    return { exitCode: report.errors.length ? 1 : 0, report };
}

module.exports = { parseDryRunArgs, evaluateItem, analyzeRun, renderText, runDryRun };
