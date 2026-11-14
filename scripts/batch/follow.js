// scripts/batch/follow.js
// Consume CAREERS_PAGE_REDIRECT entries that paste.js wrote to
// redirects/<name>.json. For each:
//   1. Load the redirect target URL
//   2. Re-dump the listing (and detail, if a candidate exists)
//   3. Build a fresh wizard prompt against the new target
//   4. Overwrite prompts/<name>.md
//   5. Update classes.json targetUrl (so the next paste's domain-check
//      runs against the redirected URL, not the original)
//   6. Change redirects/<name>.json type to FOLLOWED (paste re-prompts
//      on next run; hopCount preserved)
//
// Depth cap: if hopCount >= maxHops, downgrades to NOT_CAREERS_PAGE
// (terminal) rather than following again. Prevents infinite redirect
// chains where the LLM keeps suggesting new URLs.
//
// Domain safety: paste.js already rejected cross-domain suggestions at
// write-time. This module re-checks anyway as defense in depth.

const fs = require('fs');
const path = require('path');

const { paths, readClasses, writeClasses, readLatest, resolveRunDir, ensureRunLayout } = require('./lib/paths');
const { audit } = require('./lib/audit');
const ui = require('./lib/ui');
const { isSameDomainRedirect } = require('./lib/llm-header');

let wizardCache = null;
function loadWizard() {
    if (wizardCache) return wizardCache;
    const REPO = path.resolve(__dirname, '..', '..');
    const browser = require(path.join(REPO, 'scripts', 'wizard', 'browser'));
    const dump = require(path.join(REPO, 'scripts', 'wizard', 'dump'));
    const detect = require(path.join(REPO, 'scripts', 'wizard', 'detect'));
    const prompt = require(path.join(REPO, 'scripts', 'wizard', 'prompt'));
    wizardCache = {
        createSession: browser.createSession,
        dump, detect, prompt
    };
    return wizardCache;
}

function parseArgs(argv) {
    const args = { runId: null, only: null, maxHops: 3, timeoutSec: 120 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run' && argv[i + 1]) { args.runId = argv[++i]; }
        else if (a === '--only' && argv[i + 1]) { args.only = argv[++i].split(',').map((s) => s.trim()); }
        else if (a === '--max-hops' && argv[i + 1]) { args.maxHops = Math.max(1, parseInt(argv[++i], 10) || 3); }
        else if (a === '--timeout' && argv[i + 1]) { args.timeoutSec = Math.max(30, parseInt(argv[++i], 10) || 120); }
    }
    return args;
}

function pickRunDir(runId) {
    if (runId) return resolveRunDir(runId);
    const latest = readLatest();
    if (!latest) throw new Error('no --run and no latest pointer; run discover first');
    return resolveRunDir(latest);
}

function withHardTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Dump the redirect target. Mirrors generate.js's runWizardPrompt shape
// but without the shell — we're not saving dumps/prompts conditionally,
// we always save because there's nothing else to fall back to.
async function runDumpForRedirect(targetUrl, name, session, wizard, log) {
    const { dump, detect, prompt } = wizard;
    const withPageFn = (fn) => session.withPage(fn);

    log(`loading listing: ${targetUrl}`);
    const listing = await withPageFn(async (page) => {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        log(`  DOM loaded, waiting 3s`);
        await new Promise((r) => setTimeout(r, 3000));
        const d = await dump.dumpListingPage(page);
        log(`  listing dumped: ${d.anchorGroups.length} anchor-groups, ${d.cardGroups.length} card-groups`);
        return d;
    });

    let detail = null;
    const detailPattern = (listing.anchorGroups || [])
        .filter((g) => g.count >= 3)
        .filter((g) => !/^\/(category|tag|search|filter|about|contact)/i.test(g.pattern))
        .filter((g) => !/^#/.test(g.pattern))
        .filter((g) => !/^\/$/.test(g.pattern))
        .sort((a, b) => b.count - a.count)[0];
    if (detailPattern) {
        const detailUrl = detailPattern.samples[0].href;
        log(`  detail candidate: ${detailUrl}`);
        try {
            detail = await withPageFn(async (page) => {
                await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await new Promise((r) => setTimeout(r, 2000));
                return dump.dumpDetailPage(page);
            });
        } catch (e) {
            log(`  detail dump failed: ${e.message}`);
        }
    }

    const detected = detect.detectSiteType(listing, detail);
    log(`  detected: ${detected.type}`);
    const promptBody = prompt.buildPrompt({ name, type: 'jobs', url: targetUrl, listing, detail, detected });
    log(`  prompt built: ${(promptBody.length / 1024).toFixed(1)} KB`);
    return { promptBody, detected, listing, detail };
}

async function runFollow(opts) {
    const runDir = pickRunDir(opts.runId);
    const p = ensureRunLayout(runDir);
    const classes = readClasses(runDir) || {};

    // Enumerate redirect candidates.
    const redirectFiles = fs.existsSync(p.redirects)
        ? fs.readdirSync(p.redirects).filter((f) => f.endsWith('.json'))
        : [];

    const toFollow = [];
    for (const f of redirectFiles) {
        const name = f.slice(0, -5);
        if (opts.only && !opts.only.includes(name)) continue;

        const rdPath = path.join(p.redirects, f);
        let rd;
        try { rd = JSON.parse(fs.readFileSync(rdPath, 'utf8')); } catch (e) { continue; }

        if (rd.type !== 'CAREERS_PAGE_REDIRECT') continue;

        // Depth cap: give up rather than follow again.
        const hop = rd.hopCount || 0;
        if (hop >= opts.maxHops) {
            fs.writeFileSync(rdPath, JSON.stringify({
                type: 'NOT_CAREERS_PAGE',
                reason: `redirect chain exceeded ${opts.maxHops} hops (last: ${rd.url})`,
                hopCount: hop,
                updatedAt: new Date().toISOString()
            }, null, 2));
            audit.skip(runDir, { phase: 'follow', name, url: rd.url, reason: `depth-cap exceeded (${hop}/${opts.maxHops})` });
            ui.warn(`${name}: redirect depth cap hit (${hop}/${opts.maxHops}) -- downgraded to NOT_CAREERS_PAGE`);
            continue;
        }

        if (!rd.url) {
            fs.writeFileSync(rdPath, JSON.stringify({
                type: 'NOT_CAREERS_PAGE',
                reason: 'REDIRECT verdict had no URL',
                hopCount: hop,
                updatedAt: new Date().toISOString()
            }, null, 2));
            audit.skip(runDir, { phase: 'follow', name, url: null, reason: 'redirect had no URL' });
            ui.warn(`${name}: REDIRECT verdict without URL -- downgraded to NOT_CAREERS_PAGE`);
            continue;
        }

        // Defense-in-depth: re-check domain safety.
        const cls = classes[name] || {};
        const originalTarget = cls.targetUrl || cls.url || null;
        if (originalTarget && !isSameDomainRedirect(originalTarget, rd.url)) {
            fs.writeFileSync(rdPath, JSON.stringify({
                type: 'NOT_CAREERS_PAGE',
                reason: `cross-domain redirect: ${rd.url} (from ${originalTarget})`,
                hopCount: hop,
                updatedAt: new Date().toISOString()
            }, null, 2));
            audit.skip(runDir, { phase: 'follow', name, url: rd.url, reason: 'cross-domain rejected' });
            ui.warn(`${name}: cross-domain redirect rejected (${rd.url} from ${originalTarget})`);
            continue;
        }

        toFollow.push({ name, rd, rdPath, hop });
    }

    ui.banner({
        title: 'Batch Follow (redirect verdicts -> fresh prompts)',
        sub: `${toFollow.length} site(s) to follow · max ${opts.maxHops} hops`
    });

    if (toFollow.length === 0) {
        ui.info('nothing to follow -- no CAREERS_PAGE_REDIRECT verdicts pending');
        ui.blank();
        return { followed: 0 };
    }

    const wizard = loadWizard();
    let followed = 0;
    let failed = 0;

    for (let i = 0; i < toFollow.length; i++) {
        const item = toFollow[i];
        ui.divider(`[${i + 1}/${toFollow.length}] ${item.name} (hop ${item.hop + 1}/${opts.maxHops})`);
        ui.blank();
        ui.info(`target: ${item.rd.url}`);

        let session = null;
        const started = Date.now();
        try {
            session = await wizard.createSession();
            const { promptBody, detected, listing, detail } = await withHardTimeout(
                runDumpForRedirect(item.rd.url, item.name, session, wizard, (m) => ui.line(`       ${ui.colors.GRAY}${m}${ui.colors.R}`)),
                opts.timeoutSec * 1000,
                `dump on ${item.name}`
            );

            // Persist prompt.
            fs.writeFileSync(path.join(p.prompts, `${item.name}.md`), promptBody);
            // Persist dump for later template checks.
            fs.writeFileSync(path.join(p.dumps, `${item.name}.json`), JSON.stringify({
                url: item.rd.url,
                detected,
                listing,
                detail: detail || null,
                capturedAt: new Date().toISOString(),
                followedFrom: item.rd.url
            }, null, 2));

            // Update classes.json targetUrl.
            if (!classes[item.name]) classes[item.name] = {};
            classes[item.name].targetUrl = item.rd.url;
            classes[item.name].wizardDetectedType = detected.type;

            // Flip redirects type to FOLLOWED -- paste re-prompts on next
            // run, keeping hopCount so depth tracking is preserved.
            fs.writeFileSync(item.rdPath, JSON.stringify({
                type: 'FOLLOWED',
                url: item.rd.url,
                hopCount: item.hop + 1,
                updatedAt: new Date().toISOString()
            }, null, 2));

            const elapsed = ((Date.now() - started) / 1000).toFixed(1);
            ui.line(`  ${ui.tag('pass')}  ${ui.colors.GRAY}${detected.type} · ${elapsed}s · wrote prompts/${item.name}.md${ui.colors.R}`);
            audit.wizardPrompt(runDir, { name: item.name, url: item.rd.url, siteType: detected.type, ok: true });
            followed++;
        } catch (e) {
            const elapsed = ((Date.now() - started) / 1000).toFixed(1);
            ui.line(`  ${ui.tag('fail')}  ${ui.colors.GRAY}${elapsed}s · ${e.message}${ui.colors.R}`);
            audit.wizardPrompt(runDir, { name: item.name, url: item.rd.url, siteType: null, ok: false, error: e.message });
            failed++;
        } finally {
            if (session) { try { await session.close(); } catch (e) { /* ignore */ } }
            ui.blank();
        }
    }

    writeClasses(runDir, classes);

    ui.divider('Summary');
    ui.blank();
    ui.summary([
        ['followed', String(followed)],
        ['failed', String(failed)],
        ['next step', followed > 0 ? "batch paste (re-prompts the followed sites)" : 'none']
    ]);
    ui.blank();
    if (followed > 0) ui.action('next: pulchowk-events batch paste');
    ui.blank();

    return { followed, failed };
}

// Single-site follow helper. Called by both `batch follow` (batch path)
// and `batch paste` (inline path) so the two modes stay identical.
//
// Responsibilities:
//   - defense-in-depth domain check
//   - depth cap
//   - fresh browser session, dump the redirect target, close the session
//   - write prompts/<name>.md, dumps/<name>.json
//   - update classes.json targetUrl + wizardDetectedType (in-memory on
//     `classes`, persisted on success)
//   - flip redirects/<name>.json to type=FOLLOWED with hopCount+1
//
// Returns:
//   { ok: true, detected, promptBody }        on success
//   { ok: false, reason, error? }             on any failure; caller
//                                             (paste) writes a terminal
//                                             NOT_CAREERS redirects file
//                                             with `reason` as evidence.
//
// Does NOT log to stdout. Caller owns all UI. This is because paste's
// inline mode buffers per-site output; if followOneSite logged directly
// it would interleave with paste's per-item framing.
async function followOneSite({ name, redirectUrl, hopCount, runDir, classes, opts }) {
    const p = paths(runDir);
    const rdPath = path.join(p.redirects, `${name}.json`);

    // Domain safety re-check (paste already checked at write-time; this
    // re-checks because classes.json targetUrl may have moved since then).
    const cls = classes[name] || {};
    const originalTarget = cls.targetUrl || cls.url || null;
    if (originalTarget && !isSameDomainRedirect(originalTarget, redirectUrl)) {
        return { ok: false, reason: `cross-domain redirect rejected: ${redirectUrl} (from ${originalTarget})` };
    }

    // Depth cap.
    if (hopCount >= (opts.maxHops || 3)) {
        return { ok: false, reason: `redirect depth cap (${hopCount}/${opts.maxHops || 3})` };
    }

    const wizard = loadWizard();
    let session = null;
    try {
        session = await wizard.createSession();
        const { promptBody, detected, listing, detail } = await withHardTimeout(
            runDumpForRedirect(redirectUrl, name, session, wizard, () => {}),
            (opts.timeoutSec || 120) * 1000,
            `dump on ${name} (hop ${hopCount + 1})`
        );

        fs.writeFileSync(path.join(p.prompts, `${name}.md`), promptBody);
        fs.writeFileSync(path.join(p.dumps, `${name}.json`), JSON.stringify({
            url: redirectUrl,
            detected,
            listing,
            detail: detail || null,
            capturedAt: new Date().toISOString(),
            followedFrom: cls.targetUrl || cls.url || null
        }, null, 2));

        if (!classes[name]) classes[name] = {};
        classes[name].targetUrl = redirectUrl;
        classes[name].wizardDetectedType = detected.type;
        // Update resolution shape too -- otherwise verify reports the
        // ORIGINAL page's shape (e.g. 'homepage-no-careers') for a site
        // that now targets a real listing. Stale reason => wrong triage.
        const curPf = (classes[name].resolution && classes[name].resolution.preflight) || {};
        classes[name].resolution = {
            action: 'accept',
            pageShape: detected.type || 'unknown',
            reasoning: `followed from ${classes[name].url || '?'} to ${redirectUrl} (detected ${detected.type})`,
            chain: (classes[name].resolution && classes[name].resolution.chain) || [],
            preflight: curPf
        };

        fs.writeFileSync(rdPath, JSON.stringify({
            type: 'FOLLOWED',
            url: redirectUrl,
            hopCount: hopCount + 1,
            updatedAt: new Date().toISOString()
        }, null, 2));

        return { ok: true, detected, promptBody };
    } catch (e) {
        return { ok: false, reason: `dump failed: ${e.message}` };
    } finally {
        if (session) { try { await session.close(); } catch (e) { /* ignore */ } }
    }
}

module.exports = { runFollow, parseArgs, followOneSite };

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    runFollow(opts).catch((e) => {
        console.error('✗ follow failed:', e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    });
}
