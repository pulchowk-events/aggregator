// scripts/batch/report.js
// Phase 4: aggregate results. Reads verify-summary.json + classes.json +
// per-source results/*.json, prints a grouped human table, writes report.json.
//
// Buckets:
//   PASS           -- verify verdict 'ok' or valid-empty
//   FAIL-DRIFT     -- dom_drift_*
//   FAIL-PARSE     -- parse_failed / stage_failed
//   FAIL-BLOCKED   -- blocked
//   FAIL-EMPTY-WIZ -- wizard extractor returned 0 (soft-fail, likely needs notes)
//   NOT-IMPL       -- extractor_not_implemented (stub still in place)
//   SKIP-FETCH     -- fetch-failed at discover time
//   NOT-GENERATED  -- in classes.json but no generated/<name>.js (prompt not answered yet)
//   LLM-NOT-CAREERS -- LLM's VERDICT said this URL isn't a careers page
//   LLM-REDIRECT   -- LLM's VERDICT suggested a different careers URL,
//                     waiting for `batch follow` to process
//
// Exit code: 0 if every non-skipped source passed. 1 if any hard failure.
// Skips (fetch-failed, prompt not answered) don't affect exit.

const fs = require('fs');
const path = require('path');

const { paths, readLatest, resolveRunDir, ensureRunLayout } = require('./lib/paths');
const messages = require('./lib/messages');

function parseArgs(argv) {
    const args = { runId: null, json: false, verbose: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run' && argv[i + 1]) { args.runId = argv[++i]; }
        else if (a === '--json') { args.json = true; }
        else if (a === '--verbose' || a === '-v') { args.verbose = true; }
    }
    return args;
}

function pickRunDir(runId) {
    if (runId) return resolveRunDir(runId);
    const latest = readLatest();
    if (!latest) throw new Error('no --run and no latest pointer; run discover first');
    return resolveRunDir(latest);
}

// Map a verify reason (or null for not-yet-verified) to a report bucket.
// New buckets introduced in Stage B split previously-conflated failures:
//   FAIL-DRIFT-SPA     -- page needs JS; extractor missed client-rendered items
//   FAIL-DRIFT-UNKWN   -- page didn't clearly look like a listing at discovery
//   FAIL-EMPTY-SUSP    -- extractor returned 0 on a page preflight saw items on
//   FAIL-TIMEOUT       -- verify-source.js timed out
//   REJECT-URL         -- discovery rejected the URL before any extractor work
//   REJECT-BLOCKED     -- discovery or verify hit a captcha/challenge
// Old FAIL-DRIFT remains for genuine selector drift; FAIL-BLOCKED retained
// for verify-time blocked (discovery-time blocked lands in REJECT-BLOCKED).
// Redirect-state reading happens first. A site with a terminal redirect
// verdict has no generated file and no verify-summary entry; without this
// check it would fall through to NOT-GENERATED, masking the real state.
// rd is the parsed redirects/<name>.json (or null).
function bucketFor(r, cls, rd) {
    // Discovery rejections always win -- those sites never reached verify.
    if (cls && cls.classResult && cls.classResult.type === 'rejected') {
        const shape = cls.resolution && cls.resolution.pageShape;
        if (shape === 'blocked') return 'REJECT-BLOCKED';
        return 'REJECT-URL';
    }
    if (cls && cls.classResult && cls.classResult.type === 'fetch-failed') return 'SKIP-FETCH';

    // A NOT_CAREERS verdict is terminal. The LLM read the page and said
    // it is not a careers listing; a verify result from BEFORE the verdict
    // was written is stale.
    if (rd && rd.type === 'NOT_CAREERS_PAGE') return 'LLM-NOT-CAREERS';

    // Fresh verify result wins over FOLLOWED redirect state. Sites that
    // were followed, re-prompted, re-pasted and re-verified have a verify
    // result reflecting the current extractor -- the FOLLOWED marker is
    // just a leftover from redirect processing.
    if (r) {
        if (r.pass) return 'PASS';
        const reason = r.reason || '';
        if (reason === 'blocked') return 'REJECT-BLOCKED';
        if (reason === 'dom_drift_spa_needs_js') return 'FAIL-DRIFT-SPA';
        if (reason === 'dom_drift_unknown_shape') return 'FAIL-DRIFT-UNKWN';
        if (reason === 'dom_drift_listing' || reason === 'dom_drift_detail') return 'FAIL-DRIFT';
        if (reason === 'parse_failed' || reason === 'stage_failed') return 'FAIL-PARSE';
        if (reason === 'timeout') return 'FAIL-TIMEOUT';
        if (reason === 'not_implemented') return 'NOT-IMPL';
        if (reason === 'empty-wizard-suspicious') return 'FAIL-EMPTY-SUSP';
        if (reason === 'low_precision') return 'FAIL-LOW-PREC';
        if (reason === 'empty-wizard') return 'PASS';
        if (reason === 'empty-ats') return 'PASS';
        return 'FAIL-OTHER';
    }

    // No verify result: fall back to redirect state for reporting.
    if (rd && rd.type === 'CAREERS_PAGE_REDIRECT') return 'LLM-REDIRECT';
    return 'NOT-GENERATED';
}

function pad(s, n) { return String(s).padEnd(n); }

function runReport(opts) {
    const runDir = pickRunDir(opts.runId);
    const p = ensureRunLayout(runDir);

    const classes = (() => {
        try { return JSON.parse(fs.readFileSync(p.classes, 'utf8')); } catch (e) { return {}; }
    })();
    const verifySummary = (() => {
        try { return JSON.parse(fs.readFileSync(path.join(runDir, 'verify-summary.json'), 'utf8')); } catch (e) { return {}; }
    })();

    const redirects = (() => {
        const out = {};
        if (!fs.existsSync(p.redirects)) return out;
        for (const f of fs.readdirSync(p.redirects).filter((x) => x.endsWith('.json'))) {
            try { out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(p.redirects, f), 'utf8')); }
            catch (e) { /* skip malformed */ }
        }
        return out;
    })();

    // Union of names: everything classify saw.
    const allNames = Object.keys(classes).sort();

    const rows = allNames.map((name) => {
        const cls = classes[name];
        const clsType = cls && cls.classResult ? cls.classResult.type : 'unknown';
        const template = cls && cls.classResult ? cls.classResult.template : null;
        const v = verifySummary[name] || null;
        const rd = redirects[name] || null;
        const bucket = bucketFor(v, cls, rd);

        // Prefer the resolved targetUrl for the row's display URL when it
        // differs from the requested url. The requested url may be a
        // homepage that we followed; targetUrl is what the extractor
        // actually scraped.
        const displayUrl = cls
            ? (cls.targetUrl || cls.url)
            : null;
        const followedFrom = cls && cls.targetUrl && cls.url && cls.targetUrl !== cls.url ? cls.url : null;

        // Effective classification: prefer the wizard's verdict (authoritative,
        // DOM-based) over classifyHtml's initial-HTML guess, and fall back to
        // preflight's pageShape only for rejects / fetch failures where the
        // wizard never ran.
        const effectiveType = cls && cls.wizardDetectedType
            ? `wizard:${cls.wizardDetectedType}`
            : clsType;

        // Pull a reason: verify's if present, then the wizard's classification
        // summary, then discovery's rejection reasoning. Guarantees every row
        // has a one-line explanation without leaking preflight's
        // initial-HTML guess into rows where the wizard actually succeeded.
        let reason = null;
        if (rd && rd.type === 'NOT_CAREERS_PAGE' && rd.reason) {
            reason = 'Not a careers page: ' + rd.reason;
        } else if (v) {
            reason = messages.label(v.reason);
        } else if (rd && rd.reason) {
            reason = 'LLM verdict: ' + rd.reason;
        } else if (rd && rd.url) {
            reason = 'LLM redirect -> ' + rd.url;
        } else if (cls && cls.wizardDetectedType) {
            reason = 'Wizard detected: ' + cls.wizardDetectedType + ' -- awaiting paste';
        } else if (cls && cls.resolution && cls.resolution.action === 'reject') {
            reason = cls.resolution.pageShape + ': ' + cls.resolution.reasoning;
        } else if (cls && cls.resolution) {
            reason = cls.resolution.pageShape + ': ' + cls.resolution.reasoning;
        }

        return {
            name,
            url: displayUrl,
            followedFrom,
            classType: effectiveType,
            template,
            verdict: v ? v.verdict : null,
            items: v ? v.items : null,
            durationSec: v ? v.durationSec : null,
            reason,
            bucket,
            collided: Boolean(cls && cls.collided),
            baseName: cls ? cls.baseName : null,
            redirectUrl: rd ? (rd.url || null) : null,
            redirectHop: rd ? (rd.hopCount || 0) : null
        };
    });

    // Bucket counts.
    const counts = {};
    for (const r of rows) counts[r.bucket] = (counts[r.bucket] || 0) + 1;

    if (opts.json) {
        const report = {
            runDir,
            generatedAt: new Date().toISOString(),
            counts,
            rows
        };
        fs.writeFileSync(p.report, JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));
        return report;
    }

    // Human table.
    const BUCKET_ORDER = ['PASS', 'REJECT-URL', 'REJECT-BLOCKED', 'FAIL-DRIFT', 'FAIL-DRIFT-SPA', 'FAIL-DRIFT-UNKWN', 'FAIL-EMPTY-SUSP', 'FAIL-LOW-PREC', 'FAIL-PARSE', 'FAIL-TIMEOUT', 'FAIL-OTHER', 'NOT-IMPL', 'LLM-NOT-CAREERS', 'LLM-REDIRECT', 'NOT-GENERATED', 'SKIP-FETCH'];

    console.log('');
    console.log(`▶ report: ${runDir}`);
    console.log(`  sources: ${rows.length}`);
    console.log('');
    console.log('  bucket counts:');
    for (const b of BUCKET_ORDER) {
        if (counts[b]) console.log(`    ${String(counts[b]).padStart(3)}  ${b}`);
    }
    console.log('');

    // Full listing, grouped.
    for (const b of BUCKET_ORDER) {
        const group = rows.filter((r) => r.bucket === b);
        if (group.length === 0) continue;
        console.log(`=== ${b} (${group.length}) ===`);
        for (const r of group) {
            const t = (r.template || r.classType || '').padEnd(18);
            const v = (r.verdict || '-').padEnd(18);
            const items = r.items === null || r.items === undefined ? '-' : String(r.items);
            const collTag = r.collided ? ` ${r.baseName}->${r.name}` : '';
            console.log(`  ${pad(r.name, 22)}  ${t}  ${v}  items=${items.padStart(3)}  ${r.reason || ''}${collTag}`);
            if (opts.verbose && r.url) console.log(`    ${r.url}`);
            if (opts.verbose && r.followedFrom) console.log(`    (followed from ${r.followedFrom})`);
            if (opts.verbose && r.redirectUrl) console.log(`    (redirect target: ${r.redirectUrl} · hop ${r.redirectHop})`);
            if (opts.verbose && r.reason && r.reason !== 'ok' && r.reason !== 'empty-ats') {
                const vv = verifySummary[r.name];
                if (vv && vv.stdoutTail) {
                    const lastLine = vv.stdoutTail.split('\n').filter(Boolean).slice(-2).join(' / ');
                    if (lastLine) console.log(`    log: ${lastLine.slice(0, 160)}`);
                }
            }
        }
        console.log('');
    }

    // Write the same data as JSON for downstream.
    const report = {
        runDir,
        generatedAt: new Date().toISOString(),
        counts,
        rows
    };
    fs.writeFileSync(p.report, JSON.stringify(report, null, 2));
    console.log(`  wrote: ${path.relative(process.cwd(), p.report)}`);
    console.log('');

    // Exit codes:
    //   0 = clean. Every source is PASS, REJECT-URL, or REJECT-BLOCKED.
    //       Rejects are intentional, not failures.
    //   1 = hard failures. Any FAIL-* bucket or NOT-IMPL present.
    //       Real work is needed on at least one source.
    //   2 = incomplete. No hard failures, but at least one NOT-GENERATED
    //       (prompt written, paste not done). Distinguishes "everything
    //       done and clean" from "clean so far, work still pending".
    //       A CI/shell wrapper that chains generate->paste->verify->report
    //       must treat 2 as "don't declare victory yet".
    const HARD_BUCKETS = new Set([
        'FAIL-DRIFT', 'FAIL-DRIFT-SPA', 'FAIL-DRIFT-UNKWN',
        'FAIL-EMPTY-SUSP', 'FAIL-PARSE', 'FAIL-TIMEOUT',
        'FAIL-OTHER', 'NOT-IMPL'
    ]);
    const hardFailures = rows.filter((r) => HARD_BUCKETS.has(r.bucket));
    if (hardFailures.length > 0) {
        console.log(`  ✗ ${hardFailures.length} source(s) need attention`);
        return { report, exitCode: 1 };
    }
    const notGenerated = rows.filter((r) => r.bucket === 'NOT-GENERATED');
    const llmPending = rows.filter((r) => r.bucket === 'LLM-NOT-CAREERS' || r.bucket === 'LLM-REDIRECT');
    if (notGenerated.length > 0 || llmPending.length > 0) {
        console.log(`  ⚠ no hard failures, but ${notGenerated.length + llmPending.length} source(s) still need work`);
        if (notGenerated.length > 0) {
            console.log(`    ${notGenerated.length} pending paste -- run \`pulchowk-events batch paste\``);
        }
        if (llmPending.length > 0) {
            const notCareers = llmPending.filter((r) => r.bucket === 'LLM-NOT-CAREERS').length;
            const toRedirect = llmPending.filter((r) => r.bucket === 'LLM-REDIRECT').length;
            if (toRedirect > 0) console.log(`    ${toRedirect} redirect verdict(s) -- run \`pulchowk-events batch follow\``);
            if (notCareers > 0) console.log(`    ${notCareers} NOT_CAREERS verdict(s) -- fix urls.txt or remove site(s)`);
        }
        return { report, exitCode: 2 };
    }
    console.log('  ✓ all sources accounted for (pass or intentional reject)');
    return { report, exitCode: 0 };
}

module.exports = { runReport, parseArgs, bucketFor };

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    try {
        const r = runReport(opts);
        process.exit(r.exitCode);
    } catch (e) {
        console.error('✗ report failed:', e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    }
}
