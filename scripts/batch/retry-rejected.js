#!/usr/bin/env node
// scripts/batch/retry-rejected.js
//
// F1 fix from layer review: recover sources that discover classified as
// rejected. Discover has no second chance -- a transient failure, an
// unusual URL pattern, or a preflight false-positive means the whole
// source is silently lost. This phase re-attempts each rejected entry
// with three escalating strategies:
//
//   1. Retry-original     -- transient timeouts / 503 / DNS blips clear
//                            on second try.
//   2. Career-link follow -- fetch the original HTML, harvest anchors that
//                            look like careers/jobs links (via
//                            extractCareerLinkCandidates inside analyzePage),
//                            follow each candidate.
//   3. Suffix probe       -- try common career-page suffixes against the
//                            origin (careers, jobs, join-us, hiring, etc).
//
// First strategy that produces a wizard/ATS classification wins -- the
// entry is promoted in classes.json (old rejection replaced, new classResult
// + targetUrl + recovery trace recorded). Sources where nothing works land
// in needs-review/<name>.json with the full attempt log -- nothing is lost
// silently, humans can inspect and re-add.
//
// Wired into `batch run` between discover and generate (opt-in via
// --retry-rejected on run.js). Also invokable standalone:
//   pulchowk-events batch retry-rejected --run <id>

const fs = require('fs');
const path = require('path');

const { paths, readLatest, resolveRunDir, readClasses, writeClasses } = require('./lib/paths');
const { fetchOne } = require('./discover');
const { resolveWithFetcher } = require('./lib/url-resolve');
const { analyzePage } = require('./lib/preflight');
const { classifyHtml } = require('./classify');
const { audit } = require('./lib/audit');
const ui = require('./lib/ui');

// Common careers-page suffixes, ordered by observed hit rate.
const SUFFIX_PROBES = [
    '/careers', '/careers/', '/jobs', '/jobs/',
    '/join-us', '/join-us/', '/hiring', '/hiring/',
    '/work-with-us', '/work-with-us/',
    '/about/careers', '/about/jobs',
    '/career', '/career/',
    '/en/careers', '/company/careers'
];

// Subdomain probes. Many companies host careers on a dedicated subdomain
// (careers.foo.com) rather than at foo.com/careers. Prior version only
// tried path suffixes, so sites like hamropatro.com (careers on a
// subdomain) went to needs-review despite having a real careers page.
const SUBDOMAIN_PREFIXES = ['careers', 'jobs', 'join', 'apply', 'work', 'hiring', 'talent'];

function parseArgs(argv) {
    const args = { runId: null, only: null, timeoutMs: 20000, maxCandidates: 5, concurrency: 4, useBrowserFallback: true };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run' && argv[i + 1]) args.runId = argv[++i];
        else if (a === '--only' && argv[i + 1]) args.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
        else if (a === '--timeout' && argv[i + 1]) args.timeoutMs = Math.max(5000, parseInt(argv[++i], 10) || 20000);
        else if (a === '--max-candidates' && argv[i + 1]) args.maxCandidates = Math.max(1, parseInt(argv[++i], 10) || 5);
        else if (a === '--concurrency' && argv[i + 1]) args.concurrency = Math.max(1, parseInt(argv[++i], 10) || 4);
        else if (a === '--no-browser-fallback') args.useBrowserFallback = false;
    }
    return args;
}

async function fetchForRetry(url, timeoutMs) {
    try {
        const r = await fetchOne(url, timeoutMs);
        return {
            finalUrl: r.finalUrl || url,
            httpStatus: r.httpStatus || r.status || 0,
            html: r.html || '',
            bytes: r.bytes || (r.html ? r.html.length : 0),
            contentType: r.contentType || null,
            error: r.error || null
        };
    } catch (e) {
        return { finalUrl: url, httpStatus: 0, html: '', bytes: 0, contentType: null, error: e.message };
    }
}

// Puppeteer fallback for sources that return 0-byte bodies to `fetch`.
// Sites behind Cloudflare JS challenges / bot detection / lazy routes
// serve nothing to fetch but render fine in a headless browser. We spin
// up one page, load the URL, grab page.content(), and classify from
// that. Lazily require Puppeteer so the module still loads in non-batch
// contexts.
async function fetchWithBrowser(url, timeoutMs) {
    try {
        const { withPage } = require('../../src/scrapers/browser');
        return await withPage(async (page) => {
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
                await new Promise((r) => setTimeout(r, 1500));
                const html = await page.content();
                return {
                    finalUrl: page.url(),
                    httpStatus: 200,
                    html: html || '',
                    bytes: html ? html.length : 0,
                    contentType: 'text/html',
                    error: null
                };
            } catch (e) {
                return { finalUrl: url, httpStatus: 0, html: '', bytes: 0, contentType: null, error: e.message };
            }
        });
    } catch (e) {
        return { finalUrl: url, httpStatus: 0, html: '', bytes: 0, contentType: null, error: 'browser-render-failed: ' + e.message };
    }
}

// True when a fetch result looks like it needs browser rendering:
// zero bytes, empty HTML, or a blocked-looking status.
function looksLikeFetchBlocked(fetchResult) {
    if (!fetchResult) return false;
    if (fetchResult.bytes === 0 || !fetchResult.html) return true;
    if (fetchResult.httpStatus === 0 || fetchResult.httpStatus === 403 || fetchResult.httpStatus === 503) return true;
    return false;
}

// Guard against promoting non-careers pages. classifyHtml() answers "does
// this page have wizard-shaped content?" -- not "is this a careers page?".
// A blog, marketing site, or documentation page can be wizard-shaped but
// absolutely not where job listings live. Recovery phase tries to find a
// MISSING careers page, so it needs stricter acceptance than the general
// classifier. Rejects anything that isn't clearly careers-adjacent.
//
// Three signals, any one passes:
//   1. URL path contains careers / jobs / hiring / openings / etc.
//   2. Page title or h1 mentions careers / hiring / open roles
//   3. HTML contains 3+ anchors to careers-like paths
function isCareersContext(finalUrl, html) {
    if (!finalUrl) return false;
    const url = String(finalUrl);
    const path = (() => {
        try { return new URL(url).pathname; } catch (e) { return ''; }
    })();

    // Signal 1: URL is obviously careers-y
    if (/\/(careers?|jobs?|join-us|join-our-team|hiring|openings?|vacanc(?:y|ies)|positions?|work-with-us|apply|talent|recruit(?:ment)?)\b/i.test(path)) {
        return true;
    }

    if (!html || typeof html !== 'string') return false;
    const head = html.slice(0, 8000);

    // Signal 2: title / h1 mentions careers
    const titleMatch = head.match(/<title[^>]*>([^<]+)<\/title>/i);
    const h1Match = head.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    const text = ((titleMatch && titleMatch[1]) || '') + ' ' + ((h1Match && h1Match[1]) || '');
    if (/\b(career|careers|hiring|job openings?|open positions?|open roles?|join our team|join the team|we['\u2019]re hiring|work with us|vacanc(?:y|ies))\b/i.test(text)) {
        return true;
    }

    // Signal 3: 3+ anchors to careers-like paths
    const anchors = html.match(/href=["'][^"']*\/(?:careers?|jobs?|join-us|hiring|openings?|positions?|vacanc(?:y|ies))[\/\"']/gi) || [];
    if (anchors.length >= 3) return true;

    return false;
}

function isAcceptableClass(c) {
    if (!c) return false;
    if (c.type === 'rejected') return false;
    // Any non-reject class that has a template or is a known type
    if (c.type === 'wizard') return true;
    if (c.template) return true;
    return false;
}

async function tryResolve(url, timeoutMs, useBrowserFallback = true) {
    let resolution = null;
    try {
        resolution = await resolveWithFetcher(url, (u) => fetchForRetry(u, timeoutMs));
    } catch (e) {
        return { ok: false, url, reason: 'resolve-threw: ' + e.message, failureClass: classifyFailure(e.message) };
    }
    if (!resolution || resolution.action !== 'accept') {
        const reason = (resolution && (resolution.reasoning || resolution.pageShape)) || 'no resolution';

        // Resolution failed at fetch level (0-byte body, empty response).
        // This is the khalti-class case: fetch() returns 0 bytes for a
        // valid careers URL because the cert chain is broken for Node's
        // TLS. We need browser detection HERE (not just at target-fetch
        // time, which we never reach because resolution aborted first).
        //
        // Run one browser fetch to:
        //   a) resolve successfully if browser can load (returns classResult)
        //   b) surface cert-error as failureClass='cert-error' so the
        //      cert-bypass tier downstream fires
        if (useBrowserFallback && /0 bytes|empty response|empty body/i.test(reason)) {
            const browserFetch = await fetchWithBrowser(url, Math.max(timeoutMs * 2, 30000));
            if (browserFetch.html && browserFetch.bytes > 0) {
                const classResult = classifyHtml(browserFetch.finalUrl || url, browserFetch.html);
                if (isAcceptableClass(classResult) && isCareersContext(browserFetch.finalUrl || url, browserFetch.html)) {
                    return {
                        ok: true,
                        url: browserFetch.finalUrl || url,
                        classResult,
                        httpStatus: browserFetch.httpStatus,
                        bytes: browserFetch.bytes,
                        html: browserFetch.html,
                        resolution: { action: 'accept', url: browserFetch.finalUrl || url, pageShape: 'browser-resolve' },
                        browserFallbackUsed: true
                    };
                }
            }
            if (browserFetch.error && /err_cert|err_ssl|ssl_error|certificate|tls/i.test(browserFetch.error)) {
                return {
                    ok: false,
                    url,
                    reason: 'target-fetch-empty -- ' + browserFetch.error,
                    failureClass: 'cert-error'
                };
            }
        }

        return { ok: false, url, reason, failureClass: classifyFailure(reason) };
    }
    const targetUrl = resolution.url || url;
    let targetFetch = await fetchForRetry(targetUrl, timeoutMs);
    let browserFallbackUsed = false;
    // If fetch returns 0 bytes / blocked, retry through Puppeteer. Sites
    // that block fetch() (Cloudflare, JS-only routes) often serve fine to
    // a headless browser. This is the khalti-class recovery path.
    if (looksLikeFetchBlocked(targetFetch) && useBrowserFallback) {
        const browserFetch = await fetchWithBrowser(targetUrl, Math.max(timeoutMs * 2, 30000));
        if (browserFetch.html && browserFetch.bytes > 0) {
            targetFetch = browserFetch;
            browserFallbackUsed = true;
        } else if (browserFetch.error) {
            // Browser fallback failed with an error (cert / DNS / etc).
            // Propagate so hadCertError / failure classes can see it.
            targetFetch = { ...targetFetch, error: browserFetch.error };
        }
    }
    if (!targetFetch.html) {
        const underlyingError = targetFetch.error || 'empty body';
        return {
            ok: false,
            url: targetUrl,
            reason: 'target-fetch-empty (browser fallback also empty) -- ' + underlyingError,
            failureClass: classifyFailure(underlyingError)
        };
    }
    const classResult = classifyHtml(targetUrl, targetFetch.html);
    if (!isAcceptableClass(classResult)) {
        return { ok: false, url: targetUrl, reason: 'classify-rejected: ' + (classResult.type || 'unknown'), failureClass: 'classifier-reject' };
    }
    // Even if wizard-shaped, require careers context -- recovery phase is
    // searching for a MISSING careers page, so a wizard-shaped blog or
    // marketing page is a wrong answer, not a recovery.
    if (!isCareersContext(targetUrl, targetFetch.html)) {
        return { ok: false, url: targetUrl, reason: 'not-careers-context: ' + (classResult.type || 'unknown'), failureClass: 'not-careers-context' };
    }
    return {
        ok: true,
        url: targetUrl,
        classResult,
        httpStatus: targetFetch.httpStatus,
        bytes: targetFetch.bytes,
        html: targetFetch.html,
        resolution,
        browserFallbackUsed
    };
}

// Classify a failure reason string into a structured class. Every
// attempt's reason gets bucketed so needs-review JSON has meaningful
// counts instead of raw error strings. A human opening needs-review/khalti.json
// sees "dominantFailureClass: cert-error (24x)" at a glance.
function classifyFailure(reason) {
    if (!reason) return 'unknown';
    const r = String(reason).toLowerCase();
    if (/err_cert|err_ssl|ssl_error|certificate|self[-_ ]signed|tls/.test(r)) return 'cert-error';
    if (/err_name_not_resolved|enotfound|getaddrinfo|dns/.test(r)) return 'dns-error';
    if (/http\s*404|404 .*not found/.test(r)) return 'url-404';
    if (/http\s*403|403 .*forbidden/.test(r)) return 'blocked-403';
    if (/http\s*5\d\d|server error|bad gateway/.test(r)) return 'server-error';
    if (/0 bytes|empty response|empty body|target-fetch-empty/.test(r)) return 'empty-response';
    if (/timeout|timed out/.test(r)) return 'timeout';
    if (/classify.rejected/.test(r)) return 'classifier-reject';
    if (/not-careers-context/.test(r)) return 'not-careers-context';
    if (/no job anchors|marketing page|no careers/.test(r)) return 'no-careers-page';
    return 'other';
}

// Cert-bypass browser. Launches a SEPARATE ephemeral Puppeteer with
// ignoreHTTPSErrors + --ignore-certificate-errors. Only invoked when a
// prior attempt failed with a cert error -- sites like khalti.com have
// expired certificates that WSL's clock can't validate, so the shared
// singleton browser (strict TLS) can't touch them. This tier spins its
// own browser with strict TLS OFF, gets the content, closes. Cost: one
// browser launch per cert-blocked source (~2-5s).
async function fetchWithCertBypass(url, timeoutMs) {
    let browser = null;
    try {
        const fs = require('fs');
        const puppeteer = require('puppeteer-extra');
        const StealthPlugin = require('puppeteer-extra-plugin-stealth');
        puppeteer.use(StealthPlugin());

        const launchOpts = {
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--ignore-certificate-errors',
                '--ignore-ssl-errors',
                '--disable-web-security'
            ]
        };
        if (process.env.BROWSER_EXECUTABLE_PATH && fs.existsSync(process.env.BROWSER_EXECUTABLE_PATH)) {
            launchOpts.executablePath = process.env.BROWSER_EXECUTABLE_PATH;
        }

        browser = await puppeteer.launch({
            ...launchOpts,
            ignoreHTTPSErrors: true,
            timeout: Math.max(timeoutMs, 15000)
        });

        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await new Promise((r) => setTimeout(r, 2000));
        const html = await page.content();
        return {
            finalUrl: page.url(),
            httpStatus: 200,
            html: html || '',
            bytes: html ? html.length : 0,
            contentType: 'text/html',
            error: null
        };
    } catch (e) {
        return {
            finalUrl: url,
            httpStatus: 0,
            html: '',
            bytes: 0,
            contentType: null,
            error: 'cert-bypass-browser-failed: ' + e.message
        };
    } finally {
        if (browser) {
            try { await browser.close(); } catch (e) { /* ignore */ }
        }
    }
}

async function recoverOne(entry, name, opts) {
    const originalUrl = entry.url;
    const attempts = [];

    // ---- Strategy 1: retry original ----
    attempts.push({ strategy: 'retry-original', url: originalUrl });
    let r = await tryResolve(originalUrl, opts.timeoutMs, opts.useBrowserFallback);
    if (r.ok) return { ok: true, result: r, attempts };
    attempts[attempts.length - 1].reason = r.reason;

    // ---- Strategy 2: career-link candidates from initial HTML ----
    const initialFetch = await fetchForRetry(originalUrl, opts.timeoutMs);
    if (initialFetch.html) {
        const pf = analyzePage({
            requestedUrl: originalUrl,
            finalUrl: initialFetch.finalUrl,
            httpStatus: initialFetch.httpStatus,
            html: initialFetch.html,
            bytes: initialFetch.bytes,
            contentType: initialFetch.contentType
        });
        const candidates = (pf && pf.urlCandidates) || [];
        const topCandidates = candidates.slice(0, opts.maxCandidates);
        // Fan out in parallel; first success wins. Each attempt is a
        // separate URL fetch -- independent, safe to interleave.
        const s2Results = await Promise.all(topCandidates.map(async (c) => {
            const a = { strategy: 'career-link', url: c.href, text: c.text, confidence: c.confidence };
            const res = await tryResolve(c.href, opts.timeoutMs, opts.useBrowserFallback);
            if (!res.ok) a.reason = res.reason;
            return { attempt: a, result: res };
        }));
        for (const { attempt, result } of s2Results) attempts.push(attempt);
        const s2Win = s2Results.find((x) => x.result.ok);
        if (s2Win) return { ok: true, result: s2Win.result, attempts };
    }

    // ---- Strategy 3: common suffix probes ----
    try {
        const origin = new URL(originalUrl).origin;
        const suffixCandidates = SUFFIX_PROBES
            .map((suffix) => origin + suffix)
            .filter((c) => c !== originalUrl);
        // Same fan-out: fire every suffix probe in parallel, first success wins.
        const s3Results = await Promise.all(suffixCandidates.map(async (candidate) => {
            const a = { strategy: 'suffix-probe', url: candidate };
            const res = await tryResolve(candidate, opts.timeoutMs, opts.useBrowserFallback);
            if (!res.ok) a.reason = res.reason;
            return { attempt: a, result: res };
        }));
        for (const { attempt } of s3Results) attempts.push(attempt);
        const s3Win = s3Results.find((x) => x.result.ok);
        if (s3Win) return { ok: true, result: s3Win.result, attempts };
    } catch (e) {
        attempts.push({ strategy: 'origin-parse', reason: e.message });
    }

    // ---- Strategy 4: subdomain probes ----
    // careers.foo.com, jobs.foo.com, etc. Recovery path for companies
    // that host careers on a subdomain instead of a path suffix. We
    // skip subdomains when the origin host already starts with one of
    // the prefixes (careers.foo.com -> do not try careers.careers.foo.com).
    try {
        const u = new URL(originalUrl);
        const hostParts = u.hostname.replace(/^www\./, '').split('.');
        const alreadySubdomain = SUBDOMAIN_PREFIXES.includes(hostParts[0]);
        if (!alreadySubdomain && hostParts.length >= 2) {
            const apex = hostParts.join('.');
            const subdomainCandidates = SUBDOMAIN_PREFIXES.map((prefix) => `${u.protocol}//${prefix}.${apex}/`);
            // Fire in parallel; first success wins.
            const s4Results = await Promise.all(subdomainCandidates.map(async (candidate) => {
                const a = { strategy: 'subdomain-probe', url: candidate };
                const res = await tryResolve(candidate, opts.timeoutMs, opts.useBrowserFallback);
                if (!res.ok) a.reason = res.reason;
                return { attempt: a, result: res };
            }));
            for (const { attempt } of s4Results) attempts.push(attempt);
            const s4Win = s4Results.find((x) => x.result.ok);
            if (s4Win) return { ok: true, result: s4Win.result, attempts };
        }
    } catch (e) {
        attempts.push({ strategy: 'subdomain-parse', reason: e.message, failureClass: 'other' });
    }

    // ---- Strategy 5: cert-bypass browser (conditional) ----
    // Fires only when a prior attempt failed specifically with a cert
    // error. Launches a separate ephemeral Puppeteer with TLS strictness
    // off. Sites like khalti.com have expired certs that WSL's clock
    // rejects -- shared singleton browser can't recover them, this tier
    // can. Also retries common career suffixes through the same browser
    // because cert-blocked sources often fail every suffix too.
    const hadCertError = attempts.some((a) =>
        a.failureClass === 'cert-error' || classifyFailure(a.reason) === 'cert-error'
    );
    if (hadCertError) {
        const a = { strategy: 'cert-bypass-browser', url: originalUrl };
        attempts.push(a);
        const fetchResult = await fetchWithCertBypass(originalUrl, Math.max(opts.timeoutMs * 2, 30000));
        if (fetchResult.html && fetchResult.bytes > 0) {
            const classResult = classifyHtml(fetchResult.finalUrl || originalUrl, fetchResult.html);
            if (isAcceptableClass(classResult) && isCareersContext(fetchResult.finalUrl || originalUrl, fetchResult.html)) {
                return {
                    ok: true,
                    result: {
                        url: fetchResult.finalUrl || originalUrl,
                        classResult,
                        httpStatus: fetchResult.httpStatus,
                        bytes: fetchResult.bytes,
                        html: fetchResult.html,
                        resolution: { action: 'accept', url: fetchResult.finalUrl || originalUrl, pageShape: 'cert-bypass' },
                        browserFallbackUsed: true
                    },
                    attempts
                };
            }
            a.reason = 'classify-rejected: ' + (classResult.type || 'unknown');
            a.failureClass = 'classifier-reject';
        } else {
            a.reason = fetchResult.error || 'cert-bypass-browser-empty';
            a.failureClass = classifyFailure(a.reason);
        }

        // Cert-blocked sources often fail path suffix probes too (because
        // those also went through strict TLS). Retry the most common
        // career paths through the cert-bypass browser.
        try {
            const u = new URL(originalUrl);
            const origin = u.origin;
            const certSuffixes = ['/careers', '/careers/', '/jobs', '/jobs/', '/career', '/career/'];
            for (const suffix of certSuffixes) {
                const candidate = origin + suffix;
                if (candidate === originalUrl) continue;
                const subA = { strategy: 'cert-bypass-browser', url: candidate };
                attempts.push(subA);
                const subFetch = await fetchWithCertBypass(candidate, Math.max(opts.timeoutMs * 2, 30000));
                if (subFetch.html && subFetch.bytes > 0) {
                    const classResult = classifyHtml(subFetch.finalUrl || candidate, subFetch.html);
                    if (isAcceptableClass(classResult) && isCareersContext(subFetch.finalUrl || candidate, subFetch.html)) {
                        return {
                            ok: true,
                            result: {
                                url: subFetch.finalUrl || candidate,
                                classResult,
                                httpStatus: subFetch.httpStatus,
                                bytes: subFetch.bytes,
                                html: subFetch.html,
                                resolution: { action: 'accept', url: subFetch.finalUrl || candidate, pageShape: 'cert-bypass' },
                                browserFallbackUsed: true
                            },
                            attempts
                        };
                    }
                    subA.reason = 'classify-rejected: ' + (classResult.type || 'unknown');
                    subA.failureClass = 'classifier-reject';
                } else {
                    subA.reason = subFetch.error || 'cert-bypass-browser-empty';
                    subA.failureClass = classifyFailure(subA.reason);
                }
            }
        } catch (e) {
            attempts.push({ strategy: 'cert-bypass-origin-parse', reason: e.message, failureClass: 'other' });
        }
    }

    return { ok: false, attempts };
}

async function runRetryRejected(opts) {
    let runId = opts.runId;
    if (!runId) runId = readLatest();
    if (!runId) throw new Error('no active run; pass --run <id>');
    const runDir = resolveRunDir(runId);
    const p = paths(runDir);

    ui.banner({
        title: 'Retry rejected sources',
        sub: `run ${runId} · recover preflight-rejected URLs`
    });

    const classes = readClasses(runDir);
    if (!classes) {
        ui.warn('classes.json not found; run discover first');
        return { promoted: 0, needsReview: 0, tried: 0 };
    }

    const rejected = Object.entries(classes).filter(([name, cls]) => {
        if (opts.only && !opts.only.includes(name)) return false;
        return cls.classResult && cls.classResult.type === 'rejected';
    });

    if (rejected.length === 0) {
        ui.ok('no rejected sources to retry');
        return { promoted: 0, needsReview: 0, tried: 0 };
    }

    ui.info(`${rejected.length} rejected source(s) to attempt`);
    ui.blank();

    const needsReviewDir = path.join(runDir, 'needs-review');
    fs.mkdirSync(needsReviewDir, { recursive: true });

    let promoted = 0;
    let needsReview = 0;

    // Worker pool: N sources in flight at a time. Each source's strategy
    // cascade is independent (separate runDir writes, separate audit
    // entries, no shared state). Concurrency defaults to 4; each source
    // may fire 1 + 5 + 16 parallel URL fetches internally, so 4 concurrent
    // sources = 4 * (up to 21) = 84 concurrent HTTP requests at peak.
    // 8GB WSL can handle that; adjust --concurrency if you hit rate limits.
    const queue = rejected.slice();
    const runOne = async ([name, cls]) => {
        ui.line(`  ${ui.colors.CYAN}\u25b8${ui.colors.R} ${name.padEnd(22)} ${ui.colors.GRAY}${cls.url}${ui.colors.R}`);
        const rec = await recoverOne(cls, name, opts);

        if (rec.ok) {
            const r = rec.result;
            if (r.html) {
                try { fs.writeFileSync(path.join(p.html, `${name}.html`), r.html); }
                catch (e) { /* non-fatal */ }
            }
            const lastAttempt = rec.attempts[rec.attempts.length - 1];
            cls.classResult = r.classResult;
            cls.targetUrl = r.url;
            cls.httpStatus = r.httpStatus;
            cls.bytes = r.bytes;
            cls.recovery = {
                strategy: lastAttempt.strategy,
                attempts: rec.attempts.length,
                at: new Date().toISOString()
            };
            audit.writeAudit(runDir, {
                phase: 'retry',
                event: 'retry-promote',
                name,
                url: cls.url,
                decision: 'promote',
                reason: `recovered via ${lastAttempt.strategy} after ${rec.attempts.length} attempt(s)`,
                data: { targetUrl: r.url, classType: r.classResult.type, template: r.classResult.template || null }
            });
            ui.line(`         ${ui.tag('pass')} ${r.classResult.type}${r.classResult.template ? ' (' + r.classResult.template + ')' : ''} \u00b7 ${r.url}`);
            ui.line(`         ${ui.colors.GRAY}via ${lastAttempt.strategy} (${rec.attempts.length} attempt${rec.attempts.length === 1 ? '' : 's'})${ui.colors.R}`);
            promoted++;
        } else {
            const reviewPath = path.join(needsReviewDir, `${name}.json`);
            const originalReason = (cls.resolution && cls.resolution.reasoning) ||
                (cls.classResult.evidence && cls.classResult.evidence.reasoning) ||
                'rejected';
            // Aggregate failure classes -- dominantFailureClass is the
            // front-and-center diagnostic. A human opening needs-review/
            // <name>.json sees "dominantFailureClass: cert-error (24x)"
            // and immediately knows it's a TLS problem, not a dead source.
            const classCounts = {};
            for (const a of rec.attempts) {
                const fc = a.failureClass || classifyFailure(a.reason);
                classCounts[fc] = (classCounts[fc] || 0) + 1;
            }
            const dominant = Object.entries(classCounts).sort((x, y) => y[1] - x[1])[0];
            fs.writeFileSync(reviewPath, JSON.stringify({
                name,
                originalUrl: cls.url,
                originalReason,
                dominantFailureClass: dominant ? dominant[0] : 'unknown',
                dominantFailureCount: dominant ? dominant[1] : 0,
                failureClassCounts: classCounts,
                attemptedUrls: rec.attempts,
                note: 'All recovery strategies exhausted. The dominantFailureClass tells you why. cert-error means TLS chain broke (expired cert / clock drift). empty-response means the server returns 200 with 0 bytes. url-404 means the path does not exist. Fix the URL manually or remove from urls.txt.'
            }, null, 2));
            audit.writeAudit(runDir, {
                phase: 'retry',
                event: 'retry-needs-review',
                name,
                url: cls.url,
                decision: 'needs-review',
                reason: `${rec.attempts.length} attempt(s) exhausted`,
                data: { reviewPath }
            });
            ui.line(`         ${ui.tag('warn')} needs-review (${rec.attempts.length} attempt${rec.attempts.length === 1 ? '' : 's'}) \u00b7 ${reviewPath}`);
            needsReview++;
        }
        ui.blank();
    };

    const workers = Array.from({ length: Math.min(opts.concurrency, queue.length) }, async () => {
        while (queue.length > 0) {
            const next = queue.shift();
            if (!next) break;
            await runOne(next);
        }
    });
    await Promise.all(workers);

    writeClasses(runDir, classes);

    ui.summary([
        ['rejected sources', String(rejected.length)],
        ['promoted', String(promoted)],
        ['needs-review', String(needsReview)],
        ['classes.json', 'updated'],
        ['audit', 'audit.jsonl']
    ]);
    ui.blank();

    return { promoted, needsReview, tried: rejected.length };
}

module.exports = { runRetryRejected, parseArgs, SUFFIX_PROBES };

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    runRetryRejected(opts)
        .then(() => process.exit(0))
        .catch((e) => { console.error('\u2717 retry-rejected failed:', e.message); process.exit(1); });
}
