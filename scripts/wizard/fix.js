#!/usr/bin/env node
// scripts/wizard/fix.js
//
// Interactive drift-fix entry point. Lists every source with last-known
// status, lets you pick one, runs the diagnosis, offers to apply fixes,
// re-verifies after applying.
//
// Usage:
//   node scripts/wizard/fix.js                  # interactive picker
//   node scripts/wizard/fix.js sathijob         # direct
//   node scripts/wizard/fix.js sathijob --full  # also run the extractor
//   node scripts/wizard/fix.js sathijob --apply # apply fixes non-interactively
//   node scripts/wizard/fix.js all              # sweep all sources
//
// Prints last-known state per source from data/cache.json
// (sourceAlertState). No file mutations without --apply OR the interactive
// confirm prompt. Safe to interrupt at any point.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const os = require('os');

const REPO = path.resolve(__dirname, '..', '..');
const tui = require('./tui');
const registry = require(path.join(REPO, 'src', 'scrapers', 'registry'));

const DIAGNOSE_PATH = path.join(REPO, 'scripts', 'diagnose.js');
const VERIFY_PATH = path.join(REPO, 'scripts', 'verify-source.js');
const CACHE_PATH = path.join(REPO, 'data', 'cache.json');

// ---------- args ----------
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const FULL_MODE = args.includes('--full');
const APPLY_MODE = args.includes('--apply');

// ---------- last-known state ----------
function loadAlertState() {
    try {
        const c = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        return (c.settings && c.settings.sourceAlertState) || {};
    } catch (e) {
        return {};
    }
}

function statusLabel(alertState, name) {
    const s = alertState[name];
    if (!s || !s.consecutiveFailures) return `${tui.colors.GREEN}ok${tui.colors.R}`;
    const n = s.consecutiveFailures;
    const age = s.lastAlertAt ? Math.round((Date.now() - s.lastAlertAt) / 60000) : null;
    if (n >= 3) return `${tui.colors.RED}failing${tui.colors.R} (${n} in a row${age !== null ? `, ${age}m since alert` : ''})`;
    return `${tui.colors.YELLOW}${n} failure${n === 1 ? '' : 's'}${tui.colors.R}`;
}

// ---------- diagnose via subprocess ----------
// Spawns diagnose.js so its pretty output flows directly to the terminal
// while the report is captured to a temp file for programmatic parsing.
function runDiagnose(name) {
    const outFile = path.join(os.tmpdir(), `diagnose-${name}-${Date.now()}.json`);
    const args = [DIAGNOSE_PATH, name, '--report-out', outFile];
    if (FULL_MODE) args.push('--full');

    const r = spawnSync('node', args, { stdio: 'inherit', encoding: 'utf8' });
    if (r.status !== 0) {
        return { error: `diagnose exited ${r.status}` };
    }
    try {
        return JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch (e) {
        return { error: `could not read report: ${e.message}` };
    } finally {
        try { fs.unlinkSync(outFile); } catch (_) { /* ignore */ }
    }
}

// ---------- verify ----------
function runVerify(name) {
    const r = spawnSync('node', [VERIFY_PATH, name], { stdio: 'inherit', encoding: 'utf8' });
    return r.status === 0;
}

// ---------- fix application ----------
function applyFixes(extractorPath, candidates) {
    let source = fs.readFileSync(extractorPath, 'utf8');
    let applied = 0;
    const appliedList = [];
    for (const f of candidates) {
        const forms = [`'${f.from}'`, `"${f.from}"`, `\`${f.from}\``];
        let done = false;
        for (const qf of forms) {
            if (source.includes(qf)) {
                source = source.replace(qf, qf.replace(f.from, f.to));
                appliedList.push(f);
                applied++;
                done = true;
                break;
            }
        }
        if (!done) {
            tui.warn(`could not find quoted form of "${f.from}" in extractor — skipped`);
        }
    }
    if (applied > 0) {
        fs.writeFileSync(extractorPath, source);
    }
    return { applied, appliedList };
}

// ---------- flow: pick source ----------
async function pickSource() {
    const all = registry.getAllSources();
    const alertState = loadAlertState();
    const options = all.map((s) => ({
        value: s.name,
        label: `${s.name.padEnd(16)} ${tui.colors.D}(${s.type.padEnd(12)})${tui.colors.R}  ${statusLabel(alertState, s.name)}`
    }));
    options.push({ value: '__all__', label: `${tui.colors.YELLOW}all${tui.colors.R}              ${tui.colors.D}(sweep every source)${tui.colors.R}` });
    options.push({ value: '__cancel__', label: 'cancel' });

    const choice = await tui.selectMenu(options, {
        header: `Pick a source (${all.length} registered):`,
        defaultValue: 0
    });
    return choice;
}

// ---------- flow: single source ----------
async function fixOne(name) {
    const found = (() => {
        const all = registry.getAllSources().find((s) => s.name === name);
        return all || null;
    })();
    if (!found) {
        tui.fail(`unknown source "${name}" — not in registry`);
        return { ok: false, reason: 'not_found' };
    }

    console.log('');
    tui.info(`Diagnosing ${name} (${found.type})...`);

    const report = runDiagnose(name);
    if (report.error) {
        tui.fail(report.error);
        return { ok: false, reason: 'diagnose_failed' };
    }

    if (report.pageState && report.pageState.looksBlocked) {
        tui.fail('site is BLOCKED (Cloudflare / captcha) — no selector fix will help');
        tui.info(`body: ${JSON.stringify((report.pageState.bodySnippet || '').slice(0, 200))}`);
        tui.info('If this source needs a warm browser profile, ensure BROWSER_EXECUTABLE_PATH is set and the bot is stopped before diagnosing on Windows.');
        return { ok: false, reason: 'blocked' };
    }

    const working = (report.selectors || []).filter((r) => !r.invalid && r.count > 0);
    const broken = (report.selectors || []).filter((r) => !r.invalid && r.count === 0);
    const fixable = broken.filter((r) => r.alternates && r.alternates.length === 1);

    console.log('');
    if (report.extractor && !report.extractor.error) {
        const v = report.extractor.verdict;
        const items = report.extractor.itemCount;
        const dur = Math.round((report.extractor.durationMs || 0) / 1000);
        const okVerdict = v.status === 'ok';
        console.log(`${tui.colors.B}Extractor verdict:${tui.colors.R} ${okVerdict ? tui.colors.GREEN : tui.colors.RED}${v.status}${tui.colors.R}  items: ${items}  duration: ${dur}s`);

        if (!okVerdict && working.length > 0 && items === 0) {
            console.log('');
            tui.warn('selectors work but extractor returns 0 — the bug is NOT selector drift');
            tui.info('candidates: scroll loop not finding cards, harvest filter mismatch, or downstream map/filter');
            if (dur > 120) {
                tui.info(`runtime ${dur}s is the smoking gun — the scroll loop is spinning on empty (MAX_SCROLL_STEPS_PER_LOAD × MAX_LOAD_MORE_CLICKS × delay)`);
            }
            return { ok: false, reason: 'runtime_bug', report };
        }
    }

    if (broken.length === 0) {
        tui.success('all selectors match — no drift detected');
        return { ok: true, reason: 'no_drift', report };
    }

    tui.info(`${broken.length} broken selector(s), ${fixable.length} with an unambiguous alternate`);

    if (fixable.length === 0) {
        tui.warn('no auto-fixable selectors — manual rewrite needed');
        tui.info('next: open the extractor and inspect the page DOM');
        return { ok: false, reason: 'manual_fix_needed', report };
    }

    console.log('');
    tui.info('Fix candidates:');
    for (const r of fixable) {
        console.log(`  ${tui.colors.D}${r.selector}${tui.colors.R}  →  ${tui.colors.GREEN}${r.alternates[0].selector}${tui.colors.R}  (${r.alternates[0].count} matches)`);
    }
    console.log('');

    const shouldApply = APPLY_MODE || await tui.confirm(`Apply ${fixable.length} fix(es) to ${path.relative(REPO, found.path)}?`, { defaultYes: true });
    if (!shouldApply) {
        tui.info('not applied');
        return { ok: false, reason: 'user_declined', report };
    }

    const apply = applyFixes(found.path, fixable.map((r) => ({ from: r.selector, to: r.alternates[0].selector })));
    tui.success(`applied ${apply.applied} fix(es)`);

    console.log('');
    tui.info(`Running verify-source.js ${name} (this is the ground truth)...`);
    console.log('');
    const verified = runVerify(name);

    if (verified) {
        tui.success(`${name} passes verify-source.js — drift fixed`);
        tui.info(`commit when ready:`);
        tui.info(`  git add ${path.relative(REPO, found.path)}`);
        tui.info(`  git commit -m 'fix(${name}): update drifted selectors'`);
        return { ok: true, reason: 'fixed', report };
    }

    tui.fail(`${name} still fails verify-source.js — the fix was not sufficient`);
    tui.info('next: open the extractor and inspect the page DOM manually');
    return { ok: false, reason: 'verify_failed', report };
}

// ---------- flow: sweep all ----------
async function fixAll() {
    const all = registry.getAllSources();
    const results = [];
    for (const s of all) {
        console.log('');
        console.log(`${tui.colors.CYAN}──── ${s.name} (${s.type}) ────${tui.colors.R}`);
        const r = await fixOne(s.name);
        results.push({ name: s.name, type: s.type, ...r });
    }
    console.log('');
    console.log(`${tui.colors.B}════ SWEEP SUMMARY ════${tui.colors.R}`);
    for (const r of results) {
        const icon = r.ok ? `${tui.colors.GREEN}✓${tui.colors.R}` : `${tui.colors.RED}✗${tui.colors.R}`;
        console.log(`  ${icon} ${r.name.padEnd(16)} — ${r.reason}`);
    }
    return results;
}

// ---------- entry ----------
(async () => {
    try {
        const explicit = positional[0];
        if (explicit === 'all') {
            await fixAll();
            return;
        }
        if (explicit) {
            await fixOne(explicit);
            return;
        }
        // Interactive picker
        const choice = await pickSource();
        if (choice === '__cancel__') {
            tui.info('cancelled');
            return;
        }
        if (choice === '__all__') {
            await fixAll();
            return;
        }
        await fixOne(choice);
    } catch (e) {
        console.error(`${tui.colors.RED}❌ fix wizard failed:${tui.colors.R}`, e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    }
})();
