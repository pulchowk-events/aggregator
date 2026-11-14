// scripts/batch/discover.js
// Phase 1: for every URL in urls.txt, (a) fetch, (b) analyze with
// preflight, (c) resolve to a listing page by following career links if
// needed, (d) classify the resolved page, (e) write html + audit + classes.
//
// Replaces the pre-Stage-A version that silently trusted every URL to be
// a listing page. That version fed homepages into the wizard and produced
// extractors pointed at the wrong target -- indistinguishable from real
// selector drift at verify time. This version resolves the target first
// and rejects URLs that cannot become listings, with an audit trail for
// every decision.
//
// classes.json shape (per name), backward-compatible with old shape:
//   {
//     url,                    // ORIGINAL requested URL (unchanged)
//     name, baseName, collided,
//     httpStatus, bytes,      // from the RESOLVED page fetch
//     fetchError,             // only if original fetch failed outright
//     targetUrl,              // NEW: resolved URL the extractor should hit
//     resolution,             // NEW: full decideStep result (action, shape, chain, preflight)
//     classResult             // NEW: classification of the RESOLVED page
//   }
//
// Old consumers (generate/verify/report) read `classResult.template` and
// `classResult.type`, both of which still exist. 'rejected' is a new
// classResult.type that those consumers currently treat as "not ATS, try
// wizard" -- Stage B will teach them to skip it explicitly.

const fs = require('fs');
const path = require('path');

const { deriveName } = require('./lib/naming');
const { readSnapshot, takenSetFromSnapshot } = require('./lib/snapshot');
const { classifyHtml } = require('./classify');
const { resolveWithFetcher } = require('./lib/url-resolve');
const { audit } = require('./lib/audit');
const { Heartbeat } = require('./lib/heartbeat');
const ui = require('./lib/ui');
const { paths, readLatest, resolveRunDir, ensureRunLayout } = require('./lib/paths');

const MAX_HTML_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;
// Pool size for the fetch+classify phase. 15 is safe because this phase
// is network-bound, not CPU- or memory-bound -- the pool only holds open
// sockets and small HTML strings, not Chromium instances. 15 in flight
// cuts wall time ~3x on 34-76 URL batches without triggering per-origin
// rate limits (each origin sees at most 1-2 concurrent requests since
// most batches have one URL per origin).
//
// --concurrency <n> still overrides this at the CLI.
const DEFAULT_CONCURRENCY = 15;

function parseArgs(argv) {
    const args = { runId: null, concurrency: DEFAULT_CONCURRENCY, urlsFile: null, limit: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run' && argv[i + 1]) { args.runId = argv[++i]; }
        else if (a === '--concurrency' && argv[i + 1]) { args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 1); }
        else if (a === '--urls' && argv[i + 1]) { args.urlsFile = argv[++i]; }
        else if (a === '--limit' && argv[i + 1]) { args.limit = parseInt(argv[++i], 10); }
    }
    return args;
}

// Fetch one URL. Returns { status, html, bytes, finalUrl, contentType, error }.
// `finalUrl` is the URL after HTTP redirects (via res.url), which matters
// for preflight's `redirected` signal and for classifying the right page.
async function fetchOne(url, timeoutMs) {
    // Retry once on network failure (DNS blip, WAF interstitial, socket
    // reset). Do NOT retry on 0-byte 200 response -- the server already
    // answered with nothing, retry rarely helps and costs 200ms of sleep
    // per such URL, which at pool-15 becomes the whole batch's wall time.
    const first = await fetchOneOnce(url, timeoutMs);
    if (first.error && /fetch|network|ECONN|ETIMEDOUT|abort/i.test(first.error)) {
        await new Promise((r) => setTimeout(r, 200));
        return await fetchOneOnce(url, timeoutMs);
    }
    return first;
}

async function fetchOneOnce(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            redirect: 'follow',
            signal: ctrl.signal
        });
        const buf = await res.arrayBuffer();
        const bytes = buf.byteLength;
        if (bytes > MAX_HTML_BYTES) {
            return { status: res.status, html: '', bytes, finalUrl: res.url || url, contentType: res.headers.get('content-type') || null, error: `body ${bytes}B exceeds ${MAX_HTML_BYTES}B cap` };
        }
        const html = new TextDecoder('utf-8').decode(buf);
        return {
            status: res.status,
            html,
            bytes,
            finalUrl: res.url || url,
            contentType: res.headers.get('content-type') || null,
            error: null
        };
    } catch (e) {
        return { status: 0, html: '', bytes: 0, finalUrl: url, contentType: null, error: e.message || String(e) };
    } finally {
        clearTimeout(timer);
    }
}

// Pool: run `worker` over `items` with at most `concurrency` in flight.
// Preserves input order in output.
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
    for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(worker_());
    await Promise.all(workers);
    return results;
}

// Build a fetch function for resolveWithFetcher that memoizes responses so
// we can retrieve the HTML of the resolved page after the resolver returns.
function makeMemoizedFetcher() {
    const cache = new Map();
    const fetcher = async (url) => {
        if (!cache.has(url)) {
            cache.set(url, await fetchOne(url, DEFAULT_TIMEOUT_MS));
        }
        return cache.get(url);
    };
    return { fetcher, cache };
}

async function runDiscover(opts) {
    let runDir;
    if (opts.runId) {
        runDir = resolveRunDir(opts.runId);
    } else {
        const latest = readLatest();
        if (!latest) throw new Error('no --run given and no data/batch/latest.txt; start with `discover`');
        runDir = resolveRunDir(latest);
    }

    const p = ensureRunLayout(runDir);
    const urlsFile = opts.urlsFile || p.urls;
    if (!fs.existsSync(urlsFile)) {
        throw new Error(`urls file not found: ${urlsFile}`);
    }

    let urls = fs.readFileSync(urlsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    if (opts.limit && opts.limit > 0) urls = urls.slice(0, opts.limit);

    // Naming basis: prefer the run's frozen snapshot (stable across
    // re-runs), fall back to live filesystem for old runs created before
    // snapshotting existed. The snapshot-based set is mutable during this
    // discover run so intra-batch collisions also get suffixed.
    const snapshot = readSnapshot(runDir);
    const takenSet = takenSetFromSnapshot(snapshot, 'jobs');
    if (takenSet) {
        console.log(`  naming:  using snapshot (${takenSet.size} name(s) already taken)`);
    } else {
        console.log(`  naming:  no snapshot found, using live filesystem (run may not be stable across re-discovers)`);
    }

    ui.banner({
        title: 'Batch Discover',
        sub: `${urls.length} URL(s) - conc ${opts.concurrency} - ${path.basename(runDir)}`,
        subShort: `${urls.length} URLs - conc ${opts.concurrency}`
    });

    const start = Date.now();
    let done = 0;
    const classesOut = {};

    // Heartbeat: individual URLs are usually <500ms, but a hanging site
    // (DNS stall, 20s fetch timeout) makes discover look stuck. Heartbeat
    // surfaces URLs over 3s with elapsed time.
    const heartbeat = new Heartbeat({ intervalMs: 3000, minAgeMs: 3000 });
    heartbeat.onTick((ops) => {
        const parts = ops.map((op) => `${op.name} (${(op.ageMs / 1000).toFixed(1)}s)`);
        const fitted = ui.fitList(parts, { prefix: 'still fetching: ' });
        ui.line(`  ${fitted}`);
    });
    heartbeat.start();

    await pool(urls, opts.concurrency, async (url) => {
        const nameRes = deriveName(url, 'jobs', takenSet);
        // Add the derived name so the next URL with the same base name
        // gets a suffix instead of silently overwriting this one in
        // classesOut.
        if (takenSet && nameRes.name) takenSet.add(nameRes.name);
        if (!nameRes.name) {
            console.log(`  [skip] could not derive name: ${url} (${nameRes.error})`);
            audit.skip(runDir, { phase: 'discover', name: null, url, reason: `name derivation: ${nameRes.error}` });
            return;
        }
        const name = nameRes.name;
        done++;
        const n = String(done).padStart(2, '0');
        const urlStart = Date.now();
        heartbeat.setOp(name, 'fetching');

        if (nameRes.collided) {
            audit.collision(runDir, { name, baseName: nameRes.baseName, url });
        }

        // Resolve: fetch, preflight, follow career links if needed.
        const { fetcher, cache } = makeMemoizedFetcher();
        let resolution;
        try {
            resolution = await resolveWithFetcher(url, fetcher);
        } catch (e) {
            resolution = {
                action: 'reject',
                pageShape: 'fetch-error',
                reasoning: e.message,
                chain: [url],
                followedUrls: [url],
                preflight: null
            };
        }

        // Initial fetch result is always in cache under the requested URL.
        const initial = cache.get(url);
        const initialStatus = initial ? initial.status : 0;
        const initialBytes = initial ? initial.bytes : 0;
        const initialFetchError = initial ? initial.error : null;

        // Persist original HTML under html/<name>.original.html for debugging.
        if (initial && initial.html) {
            fs.writeFileSync(path.join(p.html, `${name}.original.html`), initial.html);
        }

        // Before honoring a reject, check whether the requested URL itself
        // matches an ATS pattern. ATS templates (Workable, Personio,
        // SmartRecruiters) hit public JSON APIs directly -- a captcha on
        // the human-facing careers frontend doesn't affect the API. Without
        // this, verisk was being rejected as 'blocked' even though
        // api.smartrecruiters.com/v1/companies/Verisk/postings works fine.
        if (resolution.action === 'reject') {
            const initialHtml = initial ? initial.html : '';
            const atsCheck = classifyHtml(url, initialHtml);
            if (atsCheck.template) {
                // Override the reject with an accept, keyed on the ATS template.
                classesOut[name] = {
                    url,
                    name,
                    baseName: nameRes.baseName,
                    collided: nameRes.collided,
                    httpStatus: initialStatus,
                    bytes: initialBytes,
                    fetchError: initialFetchError,
                    targetUrl: url,
                    resolution: {
                        action: 'accept',
                        pageShape: 'ats-override',
                        reasoning: `ATS pattern (${atsCheck.template}) supersedes page state ${resolution.pageShape}`,
                        chain: resolution.chain,
                        preflight: resolution.preflight
                    },
                    classResult: atsCheck
                };
                audit.resolveAccept(runDir, {
                    name, url,
                    targetUrl: url,
                    pageShape: 'ats-override',
                    reasoning: `ATS pattern ${atsCheck.template} overrides rejected page: ${resolution.reasoning}`
                });
                audit.classifyResult(runDir, {
                    name, url,
                    classType: atsCheck.type,
                    template: atsCheck.template,
                    slug: atsCheck.slug,
                    reasoning: 'matched by URL pattern (ATS API reachable despite page state)'
                });
                const atsElapsedMs = Date.now() - urlStart;
                const atsElapsedStr = atsElapsedMs >= 1000 ? `${(atsElapsedMs/1000).toFixed(1)}s` : '';
                heartbeat.endOp(name);
                const atsLines = ui.resultRow({
                    ts: `[${n}/${urls.length}]`,
                    tag: ui.tag('pass'),
                    name,
                    meta: `${atsCheck.type} - ATS override`,
                    right: atsElapsedStr,
                    warn: url
                });
                for (const ln of atsLines) ui.line(ln);
                ui.blank();
                return;
            }
        }

        // Handle rejection: no target, no classification.
        if (resolution.action === 'reject') {
            const cls = { type: 'rejected', template: null, evidence: { pageShape: resolution.pageShape, reasoning: resolution.reasoning } };
            classesOut[name] = {
                url,
                name,
                baseName: nameRes.baseName,
                collided: nameRes.collided,
                httpStatus: initialStatus,
                bytes: initialBytes,
                fetchError: initialFetchError,
                targetUrl: null,
                resolution,
                classResult: cls
            };
            audit.resolveReject(runDir, {
                name, url,
                pageShape: resolution.pageShape,
                reasoning: resolution.reasoning,
                chain: resolution.chain
            });
            const rejElapsedMs = Date.now() - urlStart;
            const rejElapsedStr = rejElapsedMs >= 1000 ? `${(rejElapsedMs/1000).toFixed(1)}s` : '';
            heartbeat.endOp(name);
            const rejectLines = ui.resultRow({
                ts: `[${n}/${urls.length}]`,
                tag: ui.tag('fail'),
                name,
                meta: `REJECT - ${resolution.pageShape}`,
                right: rejElapsedStr,
                reason: resolution.reasoning,
                warn: url
            });
            for (const ln of rejectLines) ui.line(ln);
            ui.blank();
            return;
        }

        // Accept: resolution.url is the target page. Its HTML is in cache.
        const targetUrl = resolution.url;
        const target = cache.get(targetUrl) || initial;
        const targetHtml = target ? target.html : '';
        const targetStatus = target ? target.status : 0;
        const targetBytes = target ? target.bytes : 0;

        // Persist target HTML under html/<name>.html (unchanged filename
        // for compatibility with the old discover behavior).
        if (targetHtml) {
            fs.writeFileSync(path.join(p.html, `${name}.html`), targetHtml);
        }

        // Classify the RESOLVED page, not the requested one.
        const classResult = classifyHtml(targetUrl, targetHtml);

        classesOut[name] = {
            url,
            name,
            baseName: nameRes.baseName,
            collided: nameRes.collided,
            httpStatus: targetStatus,
            bytes: targetBytes,
            fetchError: initialFetchError,
            targetUrl,
            resolution,
            classResult
        };

        // Audit the resolution (accepted) and classification separately so
        // a reader can see whether the shape came from a followed link.
        audit.resolveAccept(runDir, {
            name, url,
            targetUrl,
            pageShape: resolution.pageShape,
            reasoning: resolution.reasoning
        });
        audit.classifyResult(runDir, {
            name, url: targetUrl,
            classType: classResult.type,
            template: classResult.template,
            slug: classResult.slug,
            reasoning: classResult.evidence ? JSON.stringify(classResult.evidence).slice(0, 200) : ''
        });

        const followNote = (targetUrl !== url) ? targetUrl : null;
        const elapsedMs = Date.now() - urlStart;
        const elapsedStr = elapsedMs >= 1000 ? `${(elapsedMs/1000).toFixed(1)}s` : '';
        heartbeat.endOp(name);
        const rowWarn = followNote ? `${url} -> ${followNote}` : url;
        const rowLines = ui.resultRow({
            ts: `[${n}/${urls.length}]`,
            tag: ui.tag('pass'),
            name,
            meta: `${targetStatus} - ${classResult.type}`,
            right: elapsedStr,
            reason: null,
            warn: rowWarn
        });
        for (const ln of rowLines) ui.line(ln);
        if (nameRes.collided) {
            ui.line(`         ${ui.colors.GRAY}(collision: base "${nameRes.baseName}" taken, using "${name}")${ui.colors.R}`);
        }
        ui.blank();
    });

    heartbeat.stop();

    // Stable output order.
    const sorted = {};
    for (const k of Object.keys(classesOut).sort()) sorted[k] = classesOut[k];
    fs.writeFileSync(p.classes, JSON.stringify(sorted, null, 2));

    // Summary.
    const actionCounts = {};
    const classCounts = {};
    for (const v of Object.values(sorted)) {
        const a = v.resolution ? v.resolution.action : 'unknown';
        actionCounts[a] = (actionCounts[a] || 0) + 1;
        const t = v.classResult ? v.classResult.type : 'unknown';
        classCounts[t] = (classCounts[t] || 0) + 1;
    }

    console.log('');
    console.log(`✓ discover complete in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    console.log(`  wrote: ${p.classes}`);
    console.log(`  html:  ${p.html}/`);
    console.log('');
    console.log('  resolution actions:');
    for (const [a, n] of Object.entries(actionCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(n).padStart(3)}  ${a}`);
    }
    console.log('');
    console.log('  classification types:');
    for (const [t, n] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(n).padStart(3)}  ${t}`);
    }
    console.log('');
    if (actionCounts.reject) {
        console.log(`  ⚠ ${actionCounts.reject} URL(s) rejected during resolution -- see audit.jsonl for reasons`);
        console.log('');
    }

    return { classes: sorted, actionCounts, classCounts, runDir };
}

module.exports = { runDiscover, parseArgs, fetchOne, pool, makeMemoizedFetcher };

if (require.main === module) {
    const argv = process.argv.slice(2);
    const opts = parseArgs(argv);
    runDiscover(opts).catch((e) => {
        console.error('✗ discover failed:', e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    });
}
