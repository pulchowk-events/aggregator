// scripts/batch/generate.js
// Phase 2: turn classes.json into either (a) a fully-rendered extractor
// for ATS-template sites, written to generated/<name>.js, or (b) a
// paste-ready LLM prompt for wizard-fallback sites, written to
// prompts/<name>.md.
//
// ATS path is pure-string, no browser. Wizard path calls into the wizard's
// existing dump.js + detect.js + prompt.js -- nothing re-implemented, all
// reused. The wizard modules were designed to be importable; this is the
// first batch-side consumer.
//
// What this phase does NOT do:
//   - write anything into src/  (that's verify's stage-then-commit step)
//   - run the LLM  (the human does that; paste-into-DeepSeek is the free-
//                   tier flow, no API key required)
//   - modify state outside the run directory

const fs = require('fs');
const path = require('path');

const { paths, readClasses, readLatest, resolveRunDir, ensureRunLayout } = require('./lib/paths');
const { audit } = require('./lib/audit');
const ui = require('./lib/ui');
const { Heartbeat } = require('./lib/heartbeat');
const workable = require('./templates/workable');
const personio = require('./templates/personio');
const smartrecruiters = require('./templates/smartrecruiters');
const htmlCardsListing = require('./templates/html-cards-listing');

const TEMPLATE_RENDERERS = {
    'workable': workable.renderWorkable,
    'personio': personio.renderPersonio,
    'smartrecruiters': smartrecruiters.renderSmartRecruiters
};

// Wizard modules. Imported lazily so `generate` on an all-ATS run doesn't
// spin up Puppeteer's require chain.
let wizardCache = null;
function loadWizard() {
    if (wizardCache) return wizardCache;
    const REPO = path.resolve(__dirname, '..', '..');
    const browser = require(path.join(REPO, 'scripts', 'wizard', 'browser'));
    const dump = require(path.join(REPO, 'scripts', 'wizard', 'dump'));
    const detect = require(path.join(REPO, 'scripts', 'wizard', 'detect'));
    const prompt = require(path.join(REPO, 'scripts', 'wizard', 'prompt'));
    wizardCache = {
        withPage: browser.withPage,
        closeBrowser: browser.closeBrowser,
        createSession: browser.createSession,
        dump, detect, prompt
    };
    return wizardCache;
}

function parseArgs(argv) {
    const args = { runId: null, only: null, concurrency: 3, timeoutSec: 120, parallel: 5 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run' && argv[i + 1]) { args.runId = argv[++i]; }
        else if (a === '--only' && argv[i + 1]) { args.only = argv[++i].split(',').map((s) => s.trim()); }
        else if (a === '--concurrency' && argv[i + 1]) { args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1); }
        else if (a === '--timeout' && argv[i + 1]) { args.timeoutSec = Math.max(30, parseInt(argv[++i], 10) || 120); }
        else if (a === '--parallel' && argv[i + 1]) { args.parallel = Math.max(1, parseInt(argv[++i], 10) || 5); }
    }
    return args;
}

function pickRunDir(runId) {
    if (runId) return resolveRunDir(runId);
    const latest = readLatest();
    if (!latest) throw new Error('no --run and no latest pointer; run discover first');
    return resolveRunDir(latest);
}

// Render one ATS site using its template renderer. Returns the source text.
function renderAts(entry) {
    const t = entry.classResult.template;
    const fn = TEMPLATE_RENDERERS[t];
    if (!fn) {
        throw new Error(`no renderer for template "${t}"`);
    }
    if (t === 'personio') {
        return fn(entry.name, entry.classResult.slug, entry.classResult.tld);
    }
    return fn(entry.name, entry.classResult.slug);
}

// Decide whether a wizard dump qualifies for the html-cards-listing template.
// Criteria: at least one cardCandidates entry with
//   - hasJobishContent: true
//   - looksLikeSectionWrapper: false
//   - count >= 2 (real listings have at least 2 jobs; single-item
//     listings are usually the whole page, not a group)
//   - avgChildTextLength in 100..1500 (card-sized, not wrapper-sized)
// Returns the chosen card candidate, or null.
function pickHtmlCardsCandidate(dump) {
    if (!dump || !dump.listing || !Array.isArray(dump.listing.cardCandidates)) return null;
    const candidates = dump.listing.cardCandidates;
    // Require jobTitleRatio >= 0.3 -- at least 30% of the group's children
    // must have a job-role word in their heading. This is the strict gate
    // that prevents culture/values/product groups from being selected.
    // Without it, a "Join our team" section passes hasJobishContent and
    // the template produces 0 real jobs after its own title filter.
    for (const c of candidates) {
        // Tag-only selector (`div`, `a`, `li`, `section` -- no class) matches
        // too broadly at runtime. The dump reported count=3 because it
        // counted children under one parent, but querySelectorAll('div')
        // on the live page returns hundreds. Templates need a class-scoped
        // selector that pins down the card group. LLM prompts still see
        // these in the dump and can decide what to do.
        if (!c.childClass) continue;
        if (c.looksLikeSectionWrapper) continue;
        if (c.count < 2) continue;
        if (c.avgChildTextLength < 100 || c.avgChildTextLength > 1500) continue;
        if ((c.jobTitleRatio || 0) < 0.3) continue;
        return c;
    }
    return null;
}

// Run the wizard dump pass for one URL: listing page, sample detail page
// (if a detail-link group exists), then buildPrompt. Returns the prompt
// text. Throws on total failure; caller catches and records.
// Race a promise against a hard wall-clock timeout. Used as a final
// safety net around each site's wizard call -- if a Puppeteer page.goto or
// browser IPC deadlocks, this fires and lets the batch move on. The
// underlying promise keeps running (can't be cancelled), but the batch
// treats it as failed and continues.
function withHardTimeout(promise, ms, label) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms/1000)}s`)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// Simple concurrency-limited pool. Preserves result order.
async function pool(items, concurrency, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function worker_() {
        while (true) {
            const i = cursor++;
            if (i >= items.length) return;
            results[i] = await worker(items[i], i);
        }
    }
    const workers = [];
    for (let k = 0; k < Math.min(concurrency, items.length); k++) workers.push(worker_());
    await Promise.all(workers);
    return results;
}

async function runWizardPrompt(url, name, type, withPageFn, utils, log) {
    const { dump, detect, prompt } = utils;

    // Step 1 -- listing page.
    log(`loading listing: ${url}`);
    log(`  goto (domcontentloaded, 30s timeout)`);
    const listing = await withPageFn(async (page) => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        log(`  DOM loaded, waiting 3s for late content`);
        await new Promise((r) => setTimeout(r, 3000));
        log(`  dumping listing DOM`);
        const d = await dump.dumpListingPage(page);
        log(`  listing dumped: ${d.anchorGroups.length} anchor-groups, ${d.cardGroups.length} card-groups`);
        return d;
    });

    // Step 2 -- optional detail page.
    let detail = null;
    const detailPattern = (listing.anchorGroups || [])
        .filter((g) => g.count >= 3)
        .filter((g) => !/^\/(category|tag|search|filter|about|contact)/i.test(g.pattern))
        // In-page anchors (#main-content, #contact) are never detail links --
        // they're same-document jumps. page.goto('#foo') throws
        // "Cannot navigate to invalid URL" and yields no evidence.
        .filter((g) => !/^#/.test(g.pattern))
        .filter((g) => !/^\/$/.test(g.pattern))
        .sort((a, b) => b.count - a.count)[0];
    if (detailPattern) {
        const detailUrl = detailPattern.samples[0].href;
        log(`detail pattern: ${detailPattern.pattern} (${detailPattern.count} matches)`);
        log(`  sample: ${detailUrl}`);
        log(`  goto (domcontentloaded, 30s timeout)`);
        try {
            detail = await withPageFn(async (page) => {
                await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                log(`  DOM loaded, waiting 2s`);
                await new Promise((r) => setTimeout(r, 2000));
                log(`  dumping detail DOM`);
                const d = await dump.dumpDetailPage(page);
                log(`  detail dumped: ${d.headings.length} headings, ${d.jsonLdSamples.length} jsonld`);
                return d;
            });
        } catch (e) {
            log(`  detail dump failed: ${e.message} -- continuing with listing-only evidence`);
        }
    } else {
        log(`no detail candidates -- treating as single-page source`);
    }

    // Step 3 -- classify.
    log(`detecting site type`);
    const detected = detect.detectSiteType(listing, detail);
    log(`  detected: ${detected.type}`);

    // Step 4 -- build prompt.
    log(`building prompt`);
    const promptBody = prompt.buildPrompt({ name, type, url, listing, detail, detected });
    log(`  prompt built: ${(promptBody.length / 1024).toFixed(1)} KB`);
    return { promptBody, detected, listing, detail };
}

async function runGenerate(opts) {
    const runDir = pickRunDir(opts.runId);
    const p = ensureRunLayout(runDir);
    const classes = readClasses(runDir);
    if (!classes) throw new Error(`classes.json not found in ${runDir}; run discover first`);

    let names = Object.keys(classes);
    if (opts.only) {
        names = names.filter((n) => opts.only.includes(n));
    }

    ui.banner({
        title: 'Batch Generate',
        sub: `${names.length} source(s) · ${opts.parallel} worker(s) · run ${path.basename(runDir)}`,
        subShort: `${names.length} sources · ${opts.parallel} workers`
    });

    const summary = { ats: [], wizard: [], skipped: [], failed: [] };
    const wizard = loadWizard();

    // Two-pass parallel wizard work:
    //   Pass A: skip / ATS entries -- no browser, instant, sequential
    //   Pass B: wizard entries -- pool of opts.parallel, each worker owns
    //           its own Chromium session, output buffered per-site
    const skipItems = [];
    const atsItems = [];
    const wizardItems = [];
    for (let idx = 0; idx < names.length; idx++) {
        const name = names[idx];
        const entry = classes[name];
        const t = entry.classResult.type;
        if (t === 'fetch-failed' || t === 'rejected') skipItems.push({ name, entry, idx });
        else if (entry.classResult.template) atsItems.push({ name, entry, idx });
        else wizardItems.push({ name, entry, idx });
    }

    // Pass A: skip
    for (const item of skipItems) {
        const { name, entry } = item;
        const t = entry.classResult.type;
        const reason = entry.resolution
            ? `${entry.resolution.pageShape}: ${entry.resolution.reasoning}`
            : (entry.classResult.evidence && entry.classResult.evidence.error) || t;
        summary.skipped.push({ name, reason: t, detail: reason });
        const skipLines = ui.resultRow({
            ts: '',
            tag: ui.tag('skip'),
            name,
            meta: t,
            reason: (reason || '').slice(0, 200)
        });
        for (const ln of skipLines) ui.line(ln);
        audit.skip(runDir, { phase: 'generate', name, url: entry.url, reason });
    }

    // Pass A: ATS template render (no browser, sync)
    for (const item of atsItems) {
        const { name, entry } = item;
        try {
            const src2 = renderAts(entry);
            const outPath = path.join(p.generated, `${name}.js`);
            fs.writeFileSync(outPath, src2);
            summary.ats.push({ name, template: entry.classResult.template, file: path.relative(runDir, outPath) });
            const atsLines = ui.resultRow({
                ts: '',
                tag: ui.tag('pass'),
                name,
                meta: `${entry.classResult.template} → generated`,
                reason: null
            });
            for (const ln of atsLines) ui.line(ln);
            audit.atsRender(runDir, { name, template: entry.classResult.template, ok: true });
        } catch (e) {
            summary.failed.push({ name, reason: 'ats-render', detail: e.message });
            console.log(`  [fail]  ${name.padEnd(22)}  ats-render: ${e.message}`);
            audit.atsRender(runDir, { name, template: entry.classResult.template, ok: false, error: e.message });
        }
    }

    // Pass B: parallel wizard pool.
    if (wizardItems.length > 0) {
        ui.blank();
        ui.line(`  ${ui.colors.CYAN}▸${ui.colors.R} ${ui.colors.B}${Math.min(opts.parallel, wizardItems.length)} parallel browser worker(s)${ui.colors.R} ${ui.colors.GRAY}for ${wizardItems.length} site(s)${ui.colors.R}`);
        ui.blank();
    }
    const wizardUtils = { dump: wizard.dump, detect: wizard.detect, prompt: wizard.prompt };
    let completedWizard = 0;
    const totalWizard = wizardItems.length;

    // Heartbeat: wizard sites have silent 5-40s windows (browser launch,
    // page.goto waiting, DOM dump walk). A single heartbeat line every 3s
    // for any site running >3s makes the terminal feel alive even when the
    // per-site logs are all buffered for orderly output.
    const heartbeat = new Heartbeat({ intervalMs: 3000, minAgeMs: 3000 });
    heartbeat.onTick((ops) => {
        const parts = ops.map((op) => `${op.name} (${(op.ageMs / 1000).toFixed(1)}s)`);
        const fitted = ui.fitList(parts, { prefix: '⏱  still running: ' });
        ui.line(`  ${ui.colors.GRAY}${fitted}${ui.colors.R}`);
    });
    heartbeat.start();

    await pool(wizardItems, opts.parallel, async (item) => {
        const { name, entry } = item;
        const targetUrl = entry.targetUrl || entry.url;
        const started = Date.now();

        // Per-site buffered output. Flushed as one coherent block when the
        // worker finishes this site. Signals at line boundaries are
        // synchronous, so cross-worker interleaving is prevented.
        const logBuf = [];
        const pushWrapped = (tagStr, msg) => {
            const W = ui.termWidth();
            const indent = 14;
            const firstAvail = W - indent;
            if (msg.length <= firstAvail) {
                logBuf.push(`       ${tagStr}  ${ui.colors.GRAY}${msg}${ui.colors.R}`);
                return;
            }
            // First line: tag + first chunk. Continuation: wrapped remainder
            // indented to the same column as the first chunk.
            const wrapped = ui.wrapDetail(msg, { indent });
            const lines = wrapped.split('\n');
            logBuf.push(`       ${tagStr}  ${ui.colors.GRAY}${lines[0]}${ui.colors.R}`);
            for (let i = 1; i < lines.length; i++) {
                logBuf.push(`${' '.repeat(indent)}${ui.colors.GRAY}${lines[i]}${ui.colors.R}`);
            }
        };
        const logInfo = (msg) => pushWrapped(`${ui.colors.GRAY}i${ui.colors.R}`, msg);
        const logPass = (msg) => pushWrapped(ui.tag('pass'), msg);
        const logFail = (msg) => pushWrapped(ui.tag('fail'), msg);
        const logWarn = (msg) => pushWrapped(`${ui.colors.YELLOW}!${ui.colors.R}`, msg);
        const flushLog = () => { for (const l of logBuf) ui.line(l); logBuf.length = 0; };

        heartbeat.setOp(name, 'generating');
        ui.line(`       ${ui.colors.CYAN}▸${ui.colors.R} ${ui.colors.GRAY}starting${ui.colors.R} ${ui.colors.B}${name}${ui.colors.R}`);

        let session = null;
        try {
            session = await wizard.createSession();
            const withPageFn = (fn) => session.withPage(fn);

            try {
                const { promptBody, detected, listing, detail } = await withHardTimeout(
                    runWizardPrompt(targetUrl, name, 'jobs', withPageFn, wizardUtils, logInfo),
                    opts.timeoutSec * 1000,
                    `wizard on ${name}`
                );
                const elapsed = ((Date.now() - started) / 1000).toFixed(1);

                // Save dump (both template and prompt need it later).
                const dumpPath = path.join(p.dumps, `${name}.json`);
                const dumpObj = {
                    url: targetUrl,
                    detected,
                    listing,
                    detail: detail || null,
                    capturedAt: new Date().toISOString()
                };
                try {
                    fs.writeFileSync(dumpPath, JSON.stringify(dumpObj, null, 2));
                } catch (e) {
                    throw new Error(`dump-save failed: ${e.message}`);
                }

                // Template path (preferred when possible).
                let templateSucceeded = false;
                const cardCandidate = pickHtmlCardsCandidate(dumpObj);
                if (cardCandidate) {
                    try {
                        const src2 = htmlCardsListing.renderHtmlCardsListing(name, targetUrl, cardCandidate.selector);
                        const outPath = path.join(p.generated, `${name}.js`);
                        fs.writeFileSync(outPath, src2);
                        summary.ats.push({ name, template: 'html-cards-listing', file: path.relative(runDir, outPath) });
                        logPass(`html-cards-listing · ${elapsed}s · card="${cardCandidate.selector}" (${cardCandidate.count} cards) -> generated/${name}.js`);
                        audit.atsRender(runDir, { name, template: 'html-cards-listing', ok: true });
                        entry.wizardDetectedType = detected.type;
                        entry.templatedBy = 'html-cards-listing';
                        templateSucceeded = true;
                    } catch (e) {
                        logWarn(`html-cards-listing render failed: ${e.message} -- falling back to prompt`);
                        audit.atsRender(runDir, { name, template: 'html-cards-listing', ok: false, error: e.message });
                    }
                }

                // Prompt path (fallback when template failed or not applicable).
                if (!templateSucceeded) {
                    const promptPath = path.join(p.prompts, `${name}.md`);
                    fs.writeFileSync(promptPath, promptBody);
                    summary.wizard.push({ name, siteType: detected.type, file: path.relative(runDir, promptPath) });
                    logPass(`${detected.type} · ${elapsed}s · wrote prompts/${name}.md`);
                    audit.wizardPrompt(runDir, { name, url: targetUrl, siteType: detected.type, ok: true });
                    entry.wizardDetectedType = detected.type;
                }
            } catch (e) {
                const elapsed = ((Date.now() - started) / 1000).toFixed(1);
                const failReason = (e.message && e.message.startsWith('dump-save')) ? 'dump-save' : 'wizard-dump';
                summary.failed.push({ name, reason: failReason, detail: e.message });
                logFail(`${elapsed}s · ${e.message}`);
                audit.wizardPrompt(runDir, { name, url: targetUrl, siteType: null, ok: false, error: e.message });
            }
        } catch (e) {
            const elapsed = ((Date.now() - started) / 1000).toFixed(1);
            summary.failed.push({ name, reason: 'session-launch', detail: e.message });
            logFail(`${elapsed}s · session launch: ${e.message}`);
            audit.wizardPrompt(runDir, { name, url: targetUrl, siteType: null, ok: false, error: `session-launch: ${e.message}` });
        } finally {
            heartbeat.endOp(name);
            if (session) {
                try { await session.close(); } catch (e) { /* ignore */ }
            }
            flushLog();
            completedWizard++;
            ui.line(`       ${ui.progressBar(completedWizard, totalWizard)} ${ui.colors.GRAY}${completedWizard}/${totalWizard} complete${ui.colors.R}`);
        }
    });

    // Stop heartbeat after the pool settles.
    heartbeat.stop();

    // Persist wizard-classification decisions so report.js can read them.
    // Only writes if at least one entry gained a wizardDetectedType this
    // run -- otherwise leaves classes.json alone (cheap, idempotent).
    const anyDetected = Object.values(classes).some((e) => e.wizardDetectedType);
    if (anyDetected) {
        const { writeClasses } = require('./lib/paths');
        writeClasses(runDir, classes);
    }

    console.log('');
    console.log('✓ generate complete');
    console.log(`  ats-generated:   ${summary.ats.length}`);
    console.log(`  wizard-prompts:  ${summary.wizard.length}  (paste each into DeepSeek, save reply as generated/<name>.js)`);
    console.log(`  skipped:         ${summary.skipped.length}`);
    console.log(`  failed:          ${summary.failed.length}`);
    if (summary.wizard.length > 0) {
        console.log('');
        console.log('  next: for each prompt in prompts/, paste into https://chat.deepseek.com,');
        console.log('        save the code block it returns as generated/<name>.js');
        console.log('        (name is the filename stem of the prompt)');
    }
    console.log('');

    return summary;
}

module.exports = { runGenerate, parseArgs, renderAts, runWizardPrompt, TEMPLATE_RENDERERS };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const opts = parseArgs(argv);
    runGenerate(opts).catch((e) => {
        console.error('✗ generate failed:', e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    });
}
