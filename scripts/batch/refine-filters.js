#!/usr/bin/env node
// scripts/batch/refine-filters.js
//
// LLM-driven rule refinement for itemFilter. Reads observed items, detects
// anomalies per source, builds a focus prompt, polls clipboard for LLM JSON
// reply, tests candidate rules against base-4 (must be 0 drops + 0 content
// mutations with short-circuit bypassed), walks the user through plain-English
// review cards, writes only approved rules.
//
// Dry-run by default. Reuses:
//   scripts/wizard/interactive.js     -- clipboard + provider URL
//   scripts/wizard/tui.js             -- input() for DANGEROUS gate, confirm()
//   scripts/batch/lib/paths.js        -- run-dir layout
//   scripts/batch/lib/audit.js        -- batch audit
//   scripts/batch/lib/filter-rules.js -- load/test/merge/diff
//   scripts/batch/lib/anomaly-detect.js -- per-source anomaly detector
//   src/core/ui.js                    -- banner / resultRow / summary

const fs = require('fs');
const path = require('path');

const { readLatest, resolveRunDir, ensureRunLayout, newRunId, writeLatest } = require('./lib/paths');
const { writeAudit } = require('./lib/audit');
const ui = require('./lib/ui');
const { copyToClipboard, readFromClipboard, openUrl, LLM_PROVIDERS } = require('../wizard/interactive');
const tui = require('../wizard/tui');
const {
    RULES_FILE, loadRules, saveRules, testAgainstBase4, analyzeImpact, buildPrompt,
    parseLLMResponse, mergeCandidate, diffSummary, ensureRuleId, typeToItemType
} = require('./lib/filter-rules');
const { detectAnomalies } = require('./lib/anomaly-detect');

const POLL_INTERVAL_MS = 1000;
const POLL_HEARTBEAT_MS = 15000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const RISK_BY_ACTION = {
    drop: 'dangerous',
    clear_field: 'risky',
    strip_from_field: 'safe',
    split_field: 'safe',
    fix_field: 'risky',
    flag_for_review: 'safe'
};

const ACTION_EXPLAIN = {
    drop: { label: 'Drop the entire item', does: 'The item is discarded. Never reaches /pending, Discord, or the website.', effect: 'DANGEROUS. Only for items provably NOT a job.' },
    clear_field: { label: 'Clear the field (item kept)', does: 'The field is emptied. Everything else preserved.', effect: 'Use when the field is ENTIRELY noise. Item still posts.' },
    strip_from_field: { label: 'Strip matching bytes from field', does: 'Removes matching string(s). Real content preserved.', effect: 'Use when noise is embedded in real content.' },
    split_field: { label: 'Split field into sections', does: 'Inserts paragraph breaks at matching boundaries. No content removed.', effect: 'Use for run-on descriptions with section headers.' },
    fix_field: { label: 'Fix field by regex replace', does: 'Applies regex replacement. Used for title cleanup.', effect: 'Content-aware rewrite. Review the regex carefully.' },
    flag_for_review: { label: 'Flag for human review', does: 'Adds a review flag. Item kept; /pending shows badge.', effect: 'Use for ambiguous cases where auto-decision is unsafe.' }
};

function parseArgs(argv) {
    const args = {
        type: 'jobs',
        runId: null,
        fromAudit: '/tmp/audit-survey.jsonl',
        fromReply: null,
        provider: 'deepseek',
        noBrowser: false,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        noReview: false,
        acceptAll: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--type' && argv[i + 1]) args.type = argv[++i];
        else if (a === '--run' && argv[i + 1]) args.runId = argv[++i];
        else if (a === '--from-audit' && argv[i + 1]) args.fromAudit = argv[++i];
        else if (a === '--from-reply' && argv[i + 1]) args.fromReply = argv[++i];
        else if (a === '--provider' && argv[i + 1]) args.provider = argv[++i];
        else if (a === '--no-browser') args.noBrowser = true;
        else if (a === '--timeout' && argv[i + 1]) args.timeoutMs = Math.max(60000, parseInt(argv[++i], 10) || DEFAULT_TIMEOUT_MS);
        else if (a === '--no-review') args.noReview = true;
        else if (a === '--accept-all') args.acceptAll = true;
    }
    return args;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function normalizeForCompare(s) { return String(s || '').replace(/\r\n/g, '\n').trim(); }

async function pollClipboardForReply({ timeoutMs, promptBody }) {
    const start = Date.now();
    const promptNorm = normalizeForCompare(promptBody);
    let lastHeartbeat = start;
    while (Date.now() - start < timeoutMs) {
        await sleep(POLL_INTERVAL_MS);
        let cur = null;
        try { cur = readFromClipboard(); } catch (e) { /* ignore */ }
        if (!cur) continue;
        const curNorm = normalizeForCompare(cur);
        if (curNorm === promptNorm) continue;
        if (curNorm.length < 30) continue;
        const hasJson = curNorm.indexOf('{') >= 0 && curNorm.lastIndexOf('}') > curNorm.indexOf('{');
        if (!hasJson) {
            if (Date.now() - lastHeartbeat > POLL_HEARTBEAT_MS) {
                ui.info('clipboard changed but no JSON object found -- still polling');
                lastHeartbeat = Date.now();
            }
            continue;
        }
        return cur;
    }
    throw new Error(`timeout after ${Math.round(timeoutMs / 1000)}s -- no valid JSON reply`);
}

function collectItemsFromAudit(auditPath, type) {
    const itemType = typeToItemType(type);
    if (!fs.existsSync(auditPath)) throw new Error(`audit file not found: ${auditPath}`);
    const lines = fs.readFileSync(auditPath, 'utf8').split('\n');
    const items = [];
    const seen = new Set();
    for (const l of lines) {
        if (!l.trim()) continue;
        let e;
        try { e = JSON.parse(l); } catch { continue; }
        if (e.category !== 'sanitize_scraped_event') continue;
        const ev = e.data && e.data.event;
        if (!ev) continue;
        const id = ev.id || ev.title;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        items.push({ ...ev, itemType });
    }
    return items;
}

function colorBadge(risk) {
    const C = ui.colors;
    if (risk === 'dangerous') return `${C.BG_RED}${C.B} DANGEROUS ${C.R}`;
    if (risk === 'risky') return `${C.BG_YELLOW}${C.B} RISKY ${C.R}`;
    return `${C.BG_GREEN}${C.B} SAFE ${C.R}`;
}

async function interactiveReview({ proposals, items, type }) {
    if (!ui.isTTY) return null;
    if (proposals.length === 0) return { approved: [], rejected: [] };

    const C = ui.colors;
    const byRisk = { safe: [], risky: [], dangerous: [] };
    for (const p of proposals) byRisk[RISK_BY_ACTION[p.action] || 'risky'].push(p);

    ui.blank();
    ui.divider(`Review ${proposals.length} proposed rule(s)`);
    ui.blank();
    ui.line(`    ${C.BG_GREEN}${C.B} ${byRisk.safe.length} SAFE ${C.R}       strip/split/flag -- cannot lose items`);
    ui.line(`    ${C.BG_YELLOW}${C.B} ${byRisk.risky.length} RISKY ${C.R}      clear/fix -- can alter content if over-matched`);
    ui.line(`    ${C.BG_RED}${C.B} ${byRisk.dangerous.length} DANGEROUS ${C.R}  drop -- false positive loses an item silently`);
    ui.blank();
    ui.line(`  ${C.B}${C.CYAN}Commands:${C.R}  ${C.B}y${C.R} accept  ${C.YELLOW}n${C.R} skip  ${C.GREEN}a${C.R} accept-all-tier  ${C.YELLOW}s${C.R} skip-all-tier  ${C.RED}q${C.R} quit`);
    ui.line(`  ${C.GRAY}DANGEROUS rules require typing DROP to confirm.${C.R}`);
    ui.blank();

    const approved = [], rejected = [];
    const acceptTier = new Set(), skipTier = new Set();

    outer:
    for (let i = 0; i < proposals.length; i++) {
        const p = proposals[i];
        const risk = RISK_BY_ACTION[p.action] || 'risky';
        const explain = ACTION_EXPLAIN[p.action] || { label: p.action, does: '', effect: '' };

        if (acceptTier.has(risk)) { approved.push(p); continue; }
        if (skipTier.has(risk)) { rejected.push({ ...p, reason: 'skip-all-tier' }); continue; }

        const impact = analyzeImpact(p, items, type);

        ui.blank();
        ui.divider(`Rule ${i + 1}/${proposals.length}  \u00b7  ${explain.label}`);
        ui.line(`  ${colorBadge(risk)}  ${C.B}${C.CYAN}${p.action}${C.R}  on  ${C.CYAN}${p.field}${C.R}`);
        if (p.reason) ui.line(`  ${C.GRAY}${p.reason}${C.R}`);
        ui.blank();

        if (impact.matches > 0) {
            const srcList = Object.entries(impact.bySource).map(([s, n]) => `${s}(${n})`).join(', ');
            ui.line(`  ${C.B}${C.CYAN}Affects:${C.R}  ${C.B}${C.YELLOW}${impact.matches}${C.R} ${C.GRAY}item(s) -- ${srcList}${C.R}`);
            for (const t of impact.sampleTitles) ui.line(`            ${C.GRAY}${t}${C.R}`);
        } else {
            ui.line(`  ${C.B}${C.CYAN}Affects:${C.R}  ${C.GRAY}no matching items in current scrape${C.R}`);
        }
        ui.blank();
        ui.line(`  ${C.B}${C.CYAN}What it does:${C.R}`);
        ui.line(`    ${explain.does}`);
        ui.blank();
        ui.line(`  ${C.B}${C.CYAN}Effect on future scrapes:${C.R}`);
        ui.line(`    ${explain.effect}`);
        ui.blank();
        ui.line(`  ${C.B}${C.CYAN}Matcher:${C.R}  ${C.GRAY}${JSON.stringify(p.matcher)}${C.R}`);
        if (p.guards) ui.line(`  ${C.B}${C.CYAN}Guards:${C.R}   ${C.GRAY}${JSON.stringify(p.guards)}${C.R}`);
        if (p.replacement != null) ui.line(`  ${C.B}${C.CYAN}Replace:${C.R}  ${C.GRAY}${JSON.stringify(p.replacement)}${C.R}`);
        ui.blank();

        if (risk === 'dangerous') {
            ui.line(`  ${C.B}${C.RED}\u26a0 DANGEROUS -- false positive loses an item silently.${C.R}`);
            ui.blank();
            const v = await tui.input(`  Type DROP to confirm, or 'skip' to reject:`, { defaultValue: 'skip' });
            const ans = String(v || '').trim();
            if (ans === 'DROP') { approved.push(p); ui.line(`  ${C.GREEN}\u2713 accepted (DANGEROUS, typed).${C.R}`); }
            else { rejected.push({ ...p, reason: 'user-skip-dangerous' }); ui.line(`  ${C.YELLOW}\u2298 skipped.${C.R}`); }
            continue;
        }

        for (;;) {
            const raw = await ui.ask(`  ${C.GRAY}[${i + 1}/${proposals.length}]${C.R} y/n/a/s/q >`);
            const a = String(raw || '').trim().toLowerCase();
            if (a === 'q') { for (let j = i; j < proposals.length; j++) rejected.push({ ...proposals[j], reason: 'quit' }); ui.line(`  ${C.RED}quit.${C.R}`); break outer; }
            if (a === 'a') { acceptTier.add(risk); approved.push(p); ui.line(`  ${C.GREEN}\u2713 accepted -- auto-accepting ${risk} tier.${C.R}`); break; }
            if (a === 's') { skipTier.add(risk); rejected.push({ ...p, reason: 'skip-all-tier' }); ui.line(`  ${C.YELLOW}\u2298 skipped -- auto-skipping ${risk} tier.${C.R}`); break; }
            if (a === 'y' || a === 'yes') { approved.push(p); ui.line(`  ${C.GREEN}\u2713 accepted.${C.R}`); break; }
            if (a === 'n' || a === 'no' || a === '') { rejected.push({ ...p, reason: 'user-skip' }); ui.line(`  ${C.YELLOW}\u2298 skipped.${C.R}`); break; }
            ui.line(`  ${C.RED}unknown${C.R} ${C.GRAY}-- y / n / a / s / q${C.R}`);
        }
    }

    ui.blank();
    ui.divider('Review complete');
    ui.summary([['approved', String(approved.length)], ['rejected', String(rejected.length)]]);
    ui.blank();
    return { approved, rejected };
}

async function runRefineFilters(opts) {
    const itemType = typeToItemType(opts.type);
    if (!['job', 'event', 'scholarship'].includes(itemType)) {
        ui.line(`unknown --type '${opts.type}' (expected: jobs|events|scholarships)`);
        return { error: true };
    }

    let runId = opts.runId;
    if (!runId) runId = readLatest();
    let runDir;
    if (runId) { try { runDir = resolveRunDir(runId); } catch (e) { runId = null; runDir = null; } }
    if (!runDir) { runId = newRunId(); runDir = resolveRunDir(runId); writeLatest(runId); }
    ensureRunLayout(runDir);

    const subdir = path.join(runDir, 'refine-filters');
    fs.mkdirSync(subdir, { recursive: true });
    const stateDir = path.join(subdir, opts.type);
    fs.mkdirSync(stateDir, { recursive: true });

    ui.banner({
        title: `refine-filters: ${opts.type}`,
        sub: `run ${runId} · ${opts.acceptAll ? 'accept-all' : opts.noReview ? 'review-only' : 'interactive review'}`
    });

    const itemsPath = path.join(stateDir, 'items.json');
    let items;
    if (fs.existsSync(itemsPath)) {
        items = JSON.parse(fs.readFileSync(itemsPath, 'utf8'));
        ui.resultRow({ tag: ui.tag('skip'), name: 'collect', meta: `${items.length} items (cached)` }).forEach(l => ui.line(l));
    } else {
        try { items = collectItemsFromAudit(opts.fromAudit, opts.type); }
        catch (e) { ui.line(`collect failed: ${e.message}`); return { error: true }; }
        fs.writeFileSync(itemsPath, JSON.stringify(items, null, 2));
        ui.resultRow({ tag: ui.tag('pass'), name: 'collect', meta: `${items.length} items` }).forEach(l => ui.line(l));
    }

    const anomalies = detectAnomalies(items, itemType);
    const anomalySources = Object.keys(anomalies);
    ui.resultRow({
        tag: ui.tag(anomalySources.length > 0 ? 'pass' : 'warn'),
        name: 'anomalies',
        meta: `${anomalySources.length} source(s)`
    }).forEach(l => ui.line(l));
    if (anomalySources.length === 0) { ui.line('no anomalies.'); return { error: false, noChanges: true }; }

    const current = loadRules();
    const baseline = testAgainstBase4(current);
    const baseOk = baseline.drops === 0 && baseline.contentMutations === 0;
    ui.resultRow({
        tag: ui.tag(baseOk ? 'pass' : 'fail'),
        name: 'baseline',
        meta: `tested=${baseline.tested} drops=${baseline.drops} contentMutations=${baseline.contentMutations} safeMutations=${baseline.safeMutations}`
    }).forEach(l => ui.line(l));

    const prompt = buildPrompt(opts.type, items, anomalies, current);
    const promptPath = path.join(stateDir, 'prompt.md');
    fs.writeFileSync(promptPath, prompt);
    ui.resultRow({ tag: ui.tag('info'), name: 'prompt', meta: `${prompt.length} bytes · ${promptPath}` }).forEach(l => ui.line(l));

    if (!copyToClipboard(prompt)) ui.line('copy failed -- paste manually from ' + promptPath);
    else ui.resultRow({ tag: ui.tag('pass'), name: 'copy prompt', meta: 'clipboard (CRLF)' }).forEach(l => ui.line(l));
    if (!opts.noBrowser) {
        const provider = LLM_PROVIDERS.find(pr => pr.value === opts.provider);
        if (provider && provider.url) { ui.waitingFor(`paste into ${provider.label}, copy JSON reply back`); openUrl(provider.url); }
    } else ui.waitingFor('paste JSON reply into clipboard manually');

    let rawReply;
    if (opts.fromReply) {
        try { rawReply = fs.readFileSync(opts.fromReply, 'utf8'); ui.resultRow({ tag: ui.tag('info'), name: 'reply from file', meta: opts.fromReply }).forEach(l => ui.line(l)); }
        catch (e) { ui.line(`read reply failed: ${e.message}`); return { error: true }; }
    } else {
        try { rawReply = await pollClipboardForReply({ timeoutMs: opts.timeoutMs, promptBody: prompt }); }
        catch (e) { ui.line(`poll failed: ${e.message}`); return { error: true }; }
    }
    const replyPath = path.join(stateDir, 'reply.json');
    fs.writeFileSync(replyPath, rawReply);
    ui.resultRow({ tag: ui.tag('pass'), name: 'reply', meta: `${rawReply.length} bytes` }).forEach(l => ui.line(l));

    let candidate;
    try { candidate = parseLLMResponse(rawReply); }
    catch (e) { ui.line(`parse failed: ${e.message} -- see ${replyPath}`); return { error: true }; }
    ui.resultRow({
        tag: ui.tag('pass'), name: 'parse',
        meta: `+${candidate.additions.length} additions, -${candidate.removals.length} removals`
    }).forEach(l => ui.line(l));

    if (candidate.additions.length === 0 && candidate.removals.length === 0) {
        ui.line('nothing proposed.');
        return { error: false, noChanges: true };
    }

    const fullMerged = mergeCandidate(current, candidate);
    const fullTest = testAgainstBase4(fullMerged);
    const fullOk = fullTest.drops === 0 && fullTest.contentMutations === 0;
    ui.resultRow({
        tag: ui.tag(fullOk ? 'pass' : 'fail'),
        name: 'candidate test',
        meta: `tested=${fullTest.tested} drops=${fullTest.drops} contentMutations=${fullTest.contentMutations} safeMutations=${fullTest.safeMutations}`
    }).forEach(l => ui.line(l));

    if (!fullOk) {
        ui.line('REJECTED: candidate breaks base-4. Not writing.');
        if (fullTest.sampleDrops.length) ui.line(`  drops: ${JSON.stringify(fullTest.sampleDrops)}`);
        if (fullTest.sampleContentMutations.length) ui.line(`  content muts: ${JSON.stringify(fullTest.sampleContentMutations)}`);
        return { error: true, rejected: true };
    }

    let review;
    if (opts.acceptAll) {
        review = { approved: candidate.additions.map(ensureRuleId), rejected: [] };
        ui.line(`--accept-all: accepting all ${review.approved.length} addition(s).`);
    } else if (opts.noReview) {
        const diff = diffSummary(current, fullMerged);
        ui.divider('proposed diff (dry-run, no write)');
        for (const r of diff.added) ui.line(`  + [${RISK_BY_ACTION[r.action]}] ${r.action}/${r.field}  ${r.reason || ''}`);
        for (const r of diff.removed) ui.line(`  - ${r.id}  ${r.reason || ''}`);
        return { error: false, applied: false, runId };
    } else {
        review = await interactiveReview({ proposals: candidate.additions.map(ensureRuleId), items, type: opts.type });
        if (!review) { ui.line('interactive review requires TTY -- use --accept-all or --no-review'); return { error: true, noTTY: true }; }
    }

    const approvedCandidate = { additions: review.approved, removals: candidate.removals };
    const finalMerged = mergeCandidate(current, approvedCandidate);
    const finalTest = testAgainstBase4(finalMerged);
    if (finalTest.drops > 0 || finalTest.contentMutations > 0) {
        ui.line(`ERROR: approved subset breaks base-4 (drops=${finalTest.drops} contentMutations=${finalTest.contentMutations}). Not writing.`);
        return { error: true };
    }

    if (review.approved.length === 0 && candidate.removals.length === 0) {
        ui.line('nothing approved. rules unchanged.');
        return { error: false, applied: false, runId };
    }

    const okFinal = await tui.confirm(
        `Write ${review.approved.length} addition(s) + ${candidate.removals.length} removal(s) to ${path.basename(RULES_FILE)}?`,
        { defaultYes: true }
    );
    if (!okFinal) { ui.line('cancelled. rules unchanged.'); return { error: false, applied: false, runId }; }

    try {
        const written = saveRules(finalMerged);
        ui.resultRow({ tag: ui.tag('pass'), name: 'written', meta: `${written} (v${finalMerged.version})` }).forEach(l => ui.line(l));
        writeAudit(runDir, {
            phase: 'refine-filters', event: 'apply', decision: 'ok',
            reason: `v${finalMerged.version}: +${review.approved.length} -${candidate.removals.length}`,
            data: { file: written, approvedCount: review.approved.length, rejectedCount: review.rejected.length, removalCount: candidate.removals.length }
        });
    } catch (e) {
        ui.line(`write failed: ${e.message}`);
        return { error: true };
    }

    ui.blank();
    ui.summary([
        ['run', runId],
        ['rules file', RULES_FILE],
        ['version', String(finalMerged.version)],
        ['next', 'node /tmp/test-item-filter.js --reuse']
    ]);
    ui.blank();
    return { error: false, applied: true, runId };
}

module.exports = { runRefineFilters, parseArgs };
