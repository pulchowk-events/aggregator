// src/scrapers/scrapeAll.js
// Top-level orchestration for a full scrape run.
//
// The only entry point bot.js calls. Takes a site filter ('all', a single
// source name, or an array), runs the matching sources in parallel through
// the plugin registry, classifies each source's outcome, records failures
// for the alert subsystem, normalizes every item onto event shape, and
// returns a single flat list. The downstream pipeline (dedup, categories,
// /pending, autopost) never needs to know whether an item came from a
// scraper-plugin, a job plugin, or a scholarship plugin.
//
// Parallelism: Promise.allSettled — one source crashing must not kill
// the others. Rejections are surfaced in `errors`, not thrown.
//
// Failure handling per source:
//   - require/extract errors → logged, source marked 'error' in perSource,
//     added to errors[], alert streak incremented
//   - successful but zero-items → classifyOutcome decides if it's a
//     legitimately empty source or a real failure; either way, alert
//     subsystem records the verdict
//   - successful with items → normalized, merged into `items`, alert
//     streak reset to 0

const { getAllSources, listSources } = require('./registry');
const { classifyOutcome } = require('./diagnostics');
const { recordOutcome } = require('./alerts');
const { normalizeJobToEventShape, normalizeScholarshipToEventShape } = require('../core/shape');
const { auditLog } = require('../core/auditLogger');
const ui = require('../core/ui');

const TYPE_LABEL = { events: 'events', jobs: 'jobs', scholarships: 'scholarships' };

// Resolve the `sites` argument to a concrete list of { type, name, plugin }.
//
// Accepted forms:
//   'all'                 → every plugin across all types
//   ['khalti', 'merojob'] → matching plugins across all types (by name)
//   'khalti'              → single source by name
function resolveSources(sites, type = null) {
    const all = getAllSources();
    // Type filter: 'all', null, and undefined all mean "no filter".
    // 'events' / 'jobs' / 'scholarships' narrow the set to that type only.
    const typeFilter = (type && type !== 'all') ? type : null;

    if (sites === 'all' || sites == null) {
        const filtered = typeFilter ? all.filter((p) => p.type === typeFilter) : all;
        return filtered.map((p) => ({ type: p.type, name: p.name, plugin: p }));
    }

    const names = Array.isArray(sites) ? sites : [sites];
    const byName = new Map();
    for (const p of all) {
        if (!names.includes(p.name)) continue;
        if (typeFilter && p.type !== typeFilter) {
            console.warn('[scrapeAll] Site "' + p.name + '" is type "' + p.type + '", not "' + typeFilter + '" -- skipping.');
            continue;
        }
        byName.set(p.name, { type: p.type, name: p.name, plugin: p });
    }
    if (byName.size === 0) {
        const suffix = typeFilter ? ' + type "' + typeFilter + '"' : '';
        console.warn('[scrapeAll] No plugins matched site filter ' + JSON.stringify(sites) + suffix + ' -- was the name misspelled, or is the site not that type?');
    }
    return Array.from(byName.values());
}

// Normalize one item to event shape based on the source's declared type.
// Returns null if normalization isn't possible (item has no identifiable
// type or title).
function normalizeByType(item, type) {
    if (!item || typeof item !== 'object') return null;
    if (type === 'jobs') return normalizeJobToEventShape(item);
    if (type === 'scholarships') return normalizeScholarshipToEventShape(item);
    return item;
}

async function scrapeAll(bot, { sites = 'all', type = null, progress = null } = {}) {
    const startedAt = Date.now();
    const sources = resolveSources(sites, type);
    const typeFilter = (type && type !== 'all') ? type : null;
    const typeSuffix = typeFilter ? ' (' + typeFilter + ' only)' : '';

    if (sources.length === 0) {
        return {
            items: [],
            errors: [],
            perSource: {},
            durationMs: 0,
            requestedSites: sites
        };
    }

    ui.banner({
        title: 'Scrape cycle',
        sub: `${sources.length} source(s) running in parallel`
    });
    auditLog('scrape_all_start', `Starting scrape run of ${sources.length} source(s)`, {
        sites, sources: sources.map((s) => `${s.type}/${s.name}`)
    });

    const withPage = require('./browser').withPage;

    // Run in parallel. Each task resolves to a structured per-source
    // result — no raw throws escape (allSettled + try/catch inside).
    const tasks = sources.map(async (src) => {
        const sourceStart = Date.now();
        try {
            const result = await src.plugin.scrape({ withPage, progress });

            const items = Array.isArray(result.items) ? result.items : [];
            const meta = result.meta || {};
            const verdict = classifyOutcome({ items, meta });

            // Alert subsystem — never throws; audit + Discord is handled inside.
            try {
                await recordOutcome(bot, src.name, src.type, verdict, {
                    itemCount: items.length,
                    durationMs: Date.now() - sourceStart
                });
            } catch (alertError) {
                console.error(`❌ [scrapeAll] Alert recording failed for "${src.name}":`, alertError.message);
            }

            // Per-source completion line, single-line so parallel sources
            // do not interleave mid-message. Style matches batch phases.
            const dur = ((Date.now() - sourceStart) / 1000).toFixed(1);
            const tagKind = verdict.status === 'ok' ? 'pass' : (verdict.status === 'empty' ? 'skip' : 'warn');
            const namePad = src.name.length > 22 ? src.name.slice(0, 21) + '…' : src.name.padEnd(22);
            console.log(`  ${ui.tag(tagKind)}  ${ui.colors.B}${namePad}${ui.colors.R}  ${String(items.length).padStart(3)} items  ${ui.colors.GRAY}${verdict.status.padEnd(16)} ${dur}s${ui.colors.R}`);

            return {
                type: src.type,
                name: src.name,
                ok: verdict.status === 'ok',
                verdict,
                items,
                meta,
                durationMs: Date.now() - sourceStart,
                error: null
            };
        } catch (error) {
            console.error(`❌ [scrapeAll] Source "${src.name}" threw:`, error.message);
            auditLog('scrape_all_error', `Source "${src.name}" threw during scrape: ${error.message}`, {
                source: src.name, type: src.type, errorMessage: error.message, errorStack: error.stack
            }, 'error');

            // Even a throw is a failure signal for the alert subsystem.
            try {
                await recordOutcome(bot, src.name, src.type, {
                    status: 'parse_failed',
                    errorMessage: error.message
                }, { threw: true });
            } catch (alertError) {
                console.error(`❌ [scrapeAll] Alert recording failed for "${src.name}":`, alertError.message);
            }

            const dur = ((Date.now() - sourceStart) / 1000).toFixed(1);
            console.log(`  ❌ ${src.name} · threw · ${dur}s · ${error.message.slice(0, 100)}`);

            return {
                type: src.type,
                name: src.name,
                ok: false,
                verdict: { status: 'parse_failed', errorMessage: error.message },
                items: [],
                meta: {},
                durationMs: Date.now() - sourceStart,
                error: error.message
            };
        }
    });

    const settled = await Promise.allSettled(tasks);

    // Aggregate.
    const perSource = {};
    const items = [];
    const errors = [];

    for (const entry of settled) {
        if (entry.status === 'rejected') {
            // Shouldn't happen (the task catches internally) but belt-and-suspenders.
            errors.push(`Unknown source rejected: ${entry.reason && entry.reason.message}`);
            continue;
        }
        const r = entry.value;
        perSource[r.name] = {
            type: r.type,
            ok: r.ok,
            verdict: r.verdict,
            itemCount: r.items.length,
            durationMs: r.durationMs,
            error: r.error
        };
        if (r.error) errors.push(`${r.name}: ${r.error}`);

        for (const raw of r.items) {
            const normalized = normalizeByType(raw, r.type);
            if (normalized) items.push(normalized);
        }
    }

    // Progress: mark every source as done/error. The progress tracker's
    // sourceStatus map is the source of truth for the Discord progress bar.
    if (progress && typeof progress.sourceDone === 'function') {
        for (const r of Object.values(perSource)) {
            progress.sourceDone(r.name, r.ok);
        }
    }

    const durationMs = Date.now() - startedAt;
    const okCount = Object.values(perSource).filter((r) => r.ok).length;
    const failCount = Object.values(perSource).length - okCount;

    // Completion summary in ui style, matching batch phase reports.
    const emptyCount = Object.values(perSource).filter((r) => r.verdict && r.verdict.status === 'empty').length;
    const totalDur = (durationMs / 1000).toFixed(1);
    ui.blank();
    ui.divider('Scrape summary');
    ui.blank();
    ui.summary([
        ['pass',   `${okCount}`],
        ['empty',  `${emptyCount}`],
        ['fail',   failCount > 0 ? `${failCount} -- see failures above` : '0'],
        ['items',  String(items.length)],
        ['duration', `${totalDur}s`]
    ]);
    ui.blank();

    auditLog('scrape_all_complete', `Scrape run completed: ${items.length} items from ${okCount}/${Object.keys(perSource).length} sources (${failCount} failed)`, {
        items: items.length,
        okCount,
        failCount,
        durationMs,
        perSource: Object.fromEntries(
            Object.entries(perSource).map(([k, v]) => [k, { ok: v.ok, verdict: v.verdict.status, itemCount: v.itemCount }])
        )
    }, failCount > 0 ? 'warn' : 'info');

    return {
        items,
        errors,
        perSource,
        durationMs,
        requestedSites: sites
    };
}

module.exports = { scrapeAll, resolveSources, normalizeByType };
