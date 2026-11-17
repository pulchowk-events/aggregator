// scripts/batch/paste-extension.js
//
// Extension-mode counterpart to paste.js. Same per-source structure as
// the clipboard loop (validate prompt -> send -> parse verdict ->
// extract code -> identity check -> write generated/<name>.js), but the
// transport is deepseek-connect's HTTP round-trip instead of the
// clipboard.
//
// UI is byte-for-byte consistent with paste.js: same banner title, same
// divider, same stepLine, same ok/fail/warn/info, same summary block.
// The one visual difference is the waiting indicator: paste.js shows
// "waiting for you to copy DeepSeek's reply to your clipboard", this
// shows a spinner with elapsed time. Everything else is identical.
//
// Provider routing: ProviderRouter is the only place a provider is
// decided. Router refusals (unknown_provider, conflicting_provider,
// ambiguous_provider_tab) go to the needs-review list with
// code = err.code; nothing falls back to a default provider.

'use strict';

const fs = require('fs');
const path = require('path');

const {
    validateJs,
    extractCodeFromClipboard,
    looksLikeRightSite,
    pickRunDir,
    stripVerdictLine,
} = require('./paste');
const { ensureRunLayout, writeClasses } = require('./lib/paths');
const { ChatMap } = require('./lib/chat-map');
const { validatePrompt } = require('./lib/prompt-structure');
const { parseVerdict, isSameDomainRedirect } = require('./lib/llm-header');
const { followOneSite } = require('./follow');
const { audit } = require('./lib/audit');
const { ExtensionTransport } = require('./lib/transport-extension');
const { ProviderRouter, ProviderRouterError } = require('./lib/provider-router');
const ui = require('./lib/ui');

const MAX_HOPS = 3;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Retry policy per deepseek-connect/docs/error-codes.md:
//   rate_limited         -> 1 delayed retry
//   retryable            -> up to 3 attempts (2 retries)
//   userFixable+no-retry -> fail immediately
//   neither              -> fail immediately
// No beeps — that's a wizard UX follow-up; the error surfaces in the
// summary and the per-source row.
async function sendWithRetry(transport, chatName, provider, prompt, timeoutMs) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await transport.chat({ chatName, provider, prompt, timeoutMs });
        } catch (err) {
            const code = err.code || 'unknown';
            const retryable = err.retryable === true;
            const retryAfter = err.retryAfter || 0;

            if (code === 'rate_limited') {
                if (attempt >= 2) throw err;
                ui.warn(`rate limited — retrying in ${Math.round(retryAfter / 1000)}s`);
                await sleep(retryAfter);
                continue;
            }
            if (!retryable) throw err;
            if (attempt >= 3) throw err;
            if (retryAfter > 0) await sleep(retryAfter);
            ui.warn(`retryable failure (${code}) — attempt ${attempt + 1}/3`);
        }
    }
}

function describeError(err) {
    if (!err) return 'unknown error';
    if (err.code && err.reason) return `${err.code}: ${err.reason}`;
    if (err.code) return err.code;
    return err.message || String(err);
}

// Spinner that also ticks elapsed time in the label. Uses ui.spinner as
// the primitive so the frames / TTY behaviour match every other spinner
// in the batch pipeline.
function makeSpinner(initial) {
    const sp = ui.spinner(initial);
    let started = Date.now();
    let ticker = null;
    return {
        start() {
            sp.start();
            ticker = setInterval(() => {
                const s = ((Date.now() - started) / 1000).toFixed(1);
                sp.update(`${initial} · ${s}s`);
            }, 200);
        },
        stop(finalText, ok = true) {
            if (ticker) { clearInterval(ticker); ticker = null; }
            sp.stop(finalText, ok);
        },
    };
}

// Live tab inventory from the extension (server-cached from the last /hello).
async function fetchTabs(transport) {
    const res = await transport.client.tabs();
    return Array.isArray(res && res.tabs) ? res.tabs : [];
}

async function runPasteExtension(opts) {
    const runDir = pickRunDir(opts.runId);
    const p = ensureRunLayout(runDir);

    const classes = (() => {
        try { return JSON.parse(fs.readFileSync(p.classes, 'utf8')); } catch (e) { return {}; }
    })();
    const chatMap = new ChatMap(runDir);

    if (!fs.existsSync(p.prompts)) {
        ui.info(`no prompts/ in ${runDir}; nothing to paste (all ATS?).`);
        return emptyResult();
    }

    let prompts = fs.readdirSync(p.prompts).filter((f) => f.endsWith('.md')).sort().map((f) => f.slice(0, -3));
    if (opts.only) prompts = prompts.filter((n) => opts.only.includes(n));

    const readRedirectType = (n) => {
        const pth = path.join(p.redirects, `${n}.json`);
        if (!fs.existsSync(pth)) return null;
        try { return JSON.parse(fs.readFileSync(pth, 'utf8')).type || null; } catch (e) { return null; }
    };
    const hasGenerated = (n) => fs.existsSync(path.join(p.generated, `${n}.js`));
    const already = prompts.filter(hasGenerated);
    const terminal = prompts.filter((n) => {
        if (hasGenerated(n)) return false;
        const t = readRedirectType(n);
        return t && t !== 'FOLLOWED';
    });
    const pending = prompts.filter((n) => {
        if (hasGenerated(n)) return false;
        const t = readRedirectType(n);
        return t === null || t === 'FOLLOWED';
    });

    // Starved-prompt filter — same threshold and same --include-small
    // escape hatch as paste.js. Prompts under 40KB lack enough HTML for
    // the LLM to produce real structure.
    if (!opts.includeSmall) {
        const MIN_PROMPT_BYTES = 40000;
        const starved = [];
        const kept = [];
        for (const name of pending) {
            const promptPath = path.join(p.prompts, `${name}.md`);
            try {
                const stat = fs.statSync(promptPath);
                if (stat.size < MIN_PROMPT_BYTES) starved.push({ name, size: stat.size });
                else kept.push(name);
            } catch (e) {
                kept.push(name);
            }
        }
        if (starved.length > 0) {
            ui.warn(`skipping ${starved.length} starved prompt(s) (<${MIN_PROMPT_BYTES / 1000}KB)`);
            for (const item of starved) {
                ui.info(`  ${item.name.padEnd(22)} ${item.size}B`);
            }
            ui.info('pass --include-small to force-include');
            pending.length = 0;
            pending.push(...kept);
        }
    }

    ui.banner({
        title: 'Batch Paste',
        sub: `${pending.length} to answer · ${already.length} generated · ${terminal.length} terminal (skipped) · extension mode`,
    });

    if (pending.length === 0) {
        ui.ok('nothing to paste');
        ui.blank();
        return emptyResult();
    }

    ui.info('How this works:');
    ui.plain('  For each site:');
    ui.plain('    1. Extension opens (or creates) a DeepSeek chat named after the source.');
    ui.plain('    2. Prompt sent, reply awaited (5–15s typical).');
    ui.plain('    3. Reply validated, extractor written to generated/.');
    ui.plain('  Requires the deepseek-connect extension loaded in brave://extensions');
    ui.plain('  with one chat.deepseek.com tab open. Ctrl+C aborts.');
    ui.blank();
    ui.info(`Mode: extension round-trip (per-prompt timeout ${Math.round((opts.timeoutMs || 180000) / 1000)}s)`);
    ui.blank();

    // Validate every prompt's structure before touching the extension —
    // same rationale as paste.js: don't spend LLM time on prompts that
    // can't produce valid extractors.
    const malformed = [];
    for (const name of pending) {
        const pth = path.join(p.prompts, `${name}.md`);
        try {
            const body = fs.readFileSync(pth, 'utf8');
            const v = validatePrompt(body);
            if (!v.ok) malformed.push({ name, reasons: v.reasons });
        } catch (e) {
            malformed.push({ name, reasons: ['read failed: ' + e.message] });
        }
    }
    if (malformed.length > 0) {
        ui.fail(`${malformed.length} prompt(s) fail structural validation:`);
        for (const m of malformed) ui.plain(`  ${m.name}: ${m.reasons.join('; ')}`);
        ui.blank();
        ui.info('run `pulchowk-events batch check` for the full report.');
        throw new Error('prompt structure validation failed; aborting before LLM');
    }

    const transport = new ExtensionTransport();
    try {
        await transport.start();
    } catch (err) {
        ui.fail(`extension not connected: ${describeError(err)}`);
        ui.info('load the deepseek-connect extension in brave://extensions');
        ui.info('and keep one chat.deepseek.com tab open');
        ui.info('the popup token must match EXTENSION_TOKEN in .env');
        await transport.shutdown();
        throw err;
    }
    ui.ok(`extension transport ready on 127.0.0.1:${transport.boundPort}`);
    ui.blank();

    // The router is the only place a provider is decided. Its registry comes from the
    // server (GET /providers), so it can only be built here, after transport.start().
    // opts.provider is null unless --provider was passed (paste.js parseArgs).
    // Any failure is a hard stop: no fallback to a hardcoded provider list.
    let router;
    try {
        router = await ProviderRouter.fromServer(transport.client, { cliProvider: opts.provider || null });
    } catch (err) {
        ui.fail(describeError(err));
        await transport.shutdown();
        throw err;
    }
    ui.ok(`providers routable: ${router.names().join(', ')}`);
    ui.blank();

    const manualFollow = [];
    const notCareers = [];
    const needsReview = [];
    let written = 0;
    let redirected = 0;
    let failed = 0;

    try {
        // Provider preflight. One decision per pending source gives the set of
        // providers this run touches; one checkTabs() per provider against the
        // live tab inventory. A provider that fails the tab check does not abort
        // the run: its sources are routed to needs-review in the loop below.
        const touched = new Set();
        for (const name of pending) {
            try {
                touched.add(router.decide(name, classes[name]).provider);
            } catch (err) {
                if (!(err instanceof ProviderRouterError)) throw err;
                // surfaces per source in the loop
            }
        }
        const tabFailures = new Map();
        if (touched.size > 0) {
            const tabInventory = await fetchTabs(transport);
            for (const provider of Array.from(touched).sort()) {
                try {
                    const tab = router.checkTabs(provider, tabInventory);
                    ui.ok(`${provider} tab ready (id ${tab.id})`);
                } catch (err) {
                    if (!(err instanceof ProviderRouterError)) throw err;
                    tabFailures.set(provider, err);
                    ui.fail(describeError(err));
                }
            }
            ui.blank();
        }

        for (let idx = 0; idx < pending.length; idx++) {
            const name = pending[idx];
            ui.divider(`[${idx + 1}/${pending.length}] ${name}`);
            ui.blank();

            let hop = 0;
            let didFollow = false;
            let siteDone = false;

            while (!siteDone) {
                const promptPath = path.join(p.prompts, `${name}.md`);
                if (!fs.existsSync(promptPath)) {
                    ui.fail('prompt disappeared mid-run');
                    failed++;
                    siteDone = true;
                    break;
                }
                const promptBody = fs.readFileSync(promptPath, 'utf8');

                ui.stepLine(idx + 1, pending.length, name + (hop > 0 ? ` (hop ${hop})` : ''), `${(promptBody.length / 1024).toFixed(1)} KB prompt`);

                const structure = validatePrompt(promptBody);
                if (!structure.ok) {
                    ui.fail('prompt fails structural validation');
                    for (const r of structure.reasons) ui.plain(`  - ${r}`);
                    failed++;
                    siteDone = true;
                    break;
                }

                // Provider: ProviderRouter is the only decision point. A refusal
                // (unknown / conflicting provider, or a failed tab preflight for the
                // decided provider) marks the source needs-review; no fallback.
                const cls = classes[name] || {};
                const targetUrlForVerdict = cls.targetUrl || cls.url || null;
                let decision;
                try {
                    decision = router.decide(name, classes[name]);
                    const tabErr = tabFailures.get(decision.provider);
                    if (tabErr) throw tabErr;
                } catch (err) {
                    if (!(err instanceof ProviderRouterError)) throw err;
                    ui.fail(`needs review — ${describeError(err)}`);
                    needsReview.push({ name, code: err.code, reason: err.reason });
                    audit.skip(runDir, {
                        phase: 'paste-extension',
                        name,
                        url: targetUrlForVerdict,
                        reason: `needs-review ${err.code}: ${err.reason}`,
                    });
                    siteDone = true;
                    break;
                }
                const provider = decision.provider;
                if (hop === 0) ui.info(`provider: ${provider} (${decision.source})`);

                // Establish the chat. On first attempt this navigates to
                // / for a fresh chat; on retry it finds the existing chat
                // in the sidebar so the LLM sees its prior turn.
                const persisted = chatMap.get(name, provider);
                let openResult;
                try {
                    openResult = await transport.open({
                        chatName: name,
                        provider,
                        url: persisted && persisted.url,
                    });
                } catch (err) {
                    ui.fail(`open("${name}" via ${provider}) failed: ${describeError(err)}`);
                    failed++;
                    siteDone = true;
                    break;
                }
                const modeLabel = openResult.mode === 'existing' ? 'reused' : 'fresh';
                ui.info(`chat ${modeLabel}: ${name}`);

                // The round-trip.
                const spinner = makeSpinner(`waiting for ${provider} reply`);
                spinner.start();
                let result;
                try {
                    result = await sendWithRetry(transport, name, provider, promptBody, opts.timeoutMs || 180000);
                } catch (err) {
                    spinner.stop(`failed: ${describeError(err)}`, false);
                    audit.skip(runDir, {
                        phase: 'paste-extension',
                        name,
                        url: targetUrlForVerdict,
                        reason: `extension round-trip failed: ${describeError(err)}`,
                    });
                    failed++;
                    siteDone = true;
                    break;
                }
                spinner.stop(`reply received (${result.elapsedMs}ms via ${provider})`);
                // Persist the chat URL for retry. First send per source
                // gets a fresh chat; subsequent retries navigate directly
                // via /open { url } and skip the sidebar walk.
                if (result.url) {
                    chatMap.set(name, provider, { url: result.url, at: Date.now() });
                }
                const raw = result.content || '';
                ui.blank();

                const verdict = parseVerdict(raw);
                const code = extractCodeFromClipboard(raw);

                if (verdict.known && verdict.type === 'CAREERS_PAGE_REDIRECT') {
                    if (!verdict.suggestedUrl) {
                        const reason = 'REDIRECT verdict without URL';
                        ui.fail(reason);
                        notCareers.push({ name, reason });
                        fs.writeFileSync(path.join(p.redirects, `${name}.json`), JSON.stringify({
                            type: 'NOT_CAREERS_PAGE', reason, hopCount: hop, updatedAt: new Date().toISOString(),
                        }, null, 2));
                        audit.skip(runDir, { phase: 'paste-extension', name, url: targetUrlForVerdict, reason });
                        siteDone = true;
                        break;
                    }
                    if (targetUrlForVerdict && !isSameDomainRedirect(targetUrlForVerdict, verdict.suggestedUrl)) {
                        const reason = `cross-domain redirect rejected (${verdict.suggestedUrl} from ${targetUrlForVerdict})`;
                        ui.warn(reason);
                        manualFollow.push({ name, url: verdict.suggestedUrl, reason });
                        fs.writeFileSync(path.join(p.redirects, `${name}.json`), JSON.stringify({
                            type: 'NOT_CAREERS_PAGE', reason, hopCount: hop, updatedAt: new Date().toISOString(),
                        }, null, 2));
                        audit.skip(runDir, { phase: 'paste-extension', name, url: targetUrlForVerdict, reason });
                        siteDone = true;
                        break;
                    }
                    if (hop >= MAX_HOPS) {
                        const reason = `redirect depth cap ${hop}/${MAX_HOPS} (last: ${verdict.suggestedUrl})`;
                        ui.warn(reason);
                        manualFollow.push({ name, url: verdict.suggestedUrl, reason: 'hop cap' });
                        fs.writeFileSync(path.join(p.redirects, `${name}.json`), JSON.stringify({
                            type: 'NOT_CAREERS_PAGE', reason, hopCount: hop, updatedAt: new Date().toISOString(),
                        }, null, 2));
                        audit.skip(runDir, { phase: 'paste-extension', name, url: targetUrlForVerdict, reason });
                        siteDone = true;
                        break;
                    }
                    ui.ok(`verdict REDIRECT -> ${verdict.suggestedUrl} (hop ${hop + 1}/${MAX_HOPS})`);
                    ui.info('following inline (dump + re-prompt)...');
                    const followResult = await followOneSite({
                        name,
                        redirectUrl: verdict.suggestedUrl,
                        hopCount: hop,
                        runDir,
                        classes,
                        opts: { maxHops: MAX_HOPS, timeoutSec: opts.followTimeoutSec || 120 },
                    });
                    if (followResult.ok) {
                        ui.ok(`followed: detected ${followResult.detected.type}, new prompt ready (${(followResult.promptBody.length / 1024).toFixed(1)} KB)`);
                        audit.skip(runDir, { phase: 'paste-extension', name, url: targetUrlForVerdict, reason: `inline follow -> ${verdict.suggestedUrl}` });
                        hop++;
                        didFollow = true;
                        ui.blank();
                        continue;
                    }
                    ui.fail(`inline follow failed: ${followResult.reason}`);
                    manualFollow.push({ name, url: verdict.suggestedUrl, reason: followResult.reason });
                    audit.skip(runDir, { phase: 'paste-extension', name, url: targetUrlForVerdict, reason: `inline follow failed: ${followResult.reason}` });
                    siteDone = true;
                    break;
                }

                if (verdict.known && verdict.type === 'NOT_CAREERS_PAGE') {
                    const reason = verdict.evidence || '(no reason given)';
                    ui.warn(`verdict NOT_CAREERS_PAGE: ${reason}`);
                    notCareers.push({ name, reason });
                    fs.writeFileSync(path.join(p.redirects, `${name}.json`), JSON.stringify({
                        type: 'NOT_CAREERS_PAGE', reason, hopCount: hop, updatedAt: new Date().toISOString(),
                    }, null, 2));
                    audit.skip(runDir, { phase: 'paste-extension', name, url: targetUrlForVerdict, reason: `llm-verdict NOT_CAREERS: ${reason}` });
                    siteDone = true;
                    break;
                }

                if (verdict.known && verdict.type === 'CAREERS_PAGE') {
                    ui.ok(`verdict CAREERS_PAGE${verdict.evidence ? ' -- ' + verdict.evidence : ''}`);
                }

                const finalCode = stripVerdictLine(code);
                if (!finalCode || finalCode.length < 50) {
                    ui.fail(`reply is not extractor-shaped (${finalCode ? finalCode.length : 0} chars)`);
                    if (finalCode) {
                        ui.info('first 200 chars:');
                        ui.plain(finalCode.slice(0, 200).replace(/\n/g, '\n  '));
                    }
                    failed++;
                    siteDone = true;
                    break;
                }

                // Identity check — must reference the source name / hostname.
                // Same check paste.js runs after the poll, before write.
                if (!looksLikeRightSite(finalCode, name, targetUrlForVerdict)) {
                    ui.fail(`extractor does not reference "${name}" — wrong reply?`);
                    ui.info(`expected "${name}" or the site's hostname in the code`);
                    ui.info('first 200 chars:');
                    ui.plain(finalCode.slice(0, 200).replace(/\n/g, '\n  '));
                    failed++;
                    siteDone = true;
                    break;
                }

                const parsed = validateJs(finalCode);
                if (!parsed.ok) {
                    // Same policy as paste.js: broken code for the RIGHT site
                    // advances so refine can retry with the specific error.
                    const outPathBroken = path.join(p.generated, `${name}.js`);
                    fs.writeFileSync(outPathBroken, finalCode);
                    try {
                        const parseFailLog = path.join(runDir, 'parse-fails.jsonl');
                        fs.appendFileSync(parseFailLog, JSON.stringify({
                            name,
                            at: new Date().toISOString(),
                            error: parsed.reason.slice(0, 300),
                            bytes: finalCode.length,
                        }) + '\n');
                    } catch (e) { /* best-effort */ }
                    audit.llmWrite(runDir, { name, lineCount: finalCode.split('\n').length, bytes: finalCode.length });
                    ui.warn(`wrote generated/${name}.js (parse failed: ${parsed.reason.slice(0, 80)})`);
                    ui.info('verify will catch, refine will retry with specific error');
                    failed++;
                    siteDone = true;
                    break;
                }

                const outPath = path.join(p.generated, `${name}.js`);
                fs.writeFileSync(outPath, finalCode);
                audit.llmWrite(runDir, { name, lineCount: finalCode.split('\n').length, bytes: finalCode.length });
                ui.ok(`wrote generated/${name}.js (${finalCode.split('\n').length} lines)`);
                written++;
                if (didFollow) redirected++;
                siteDone = true;
            }
            ui.blank();
        }
    } finally {
        writeClasses(runDir, classes);
        await transport.shutdown();
    }

    ui.blank();
    ui.divider('Summary');
    ui.blank();
    const headline = failed === 0 && needsReview.length === 0 ? ui.tag('pass') : ui.tag('warn');
    ui.line(`  ${headline}  paste complete (extension mode)`);
    ui.blank();
    ui.summary([
        ['written', String(written)],
        ['followed inline', String(redirected)],
        ['not-a-careers-page', String(notCareers.length)],
        ['failed', String(failed)],
        ['needs review', String(needsReview.length)],
        ['manual follow needed', String(manualFollow.length)],
        ['already present', String(already.length)],
    ]);
    ui.blank();

    if (notCareers.length > 0) {
        ui.warn('LLM says these URLs are NOT careers pages — fix or remove from urls.txt:');
        for (const nc of notCareers) ui.plain(`  ${nc.name.padEnd(22)} ${nc.reason}`);
        ui.blank();
    }
    if (needsReview.length > 0) {
        ui.warn('Needs review (provider routing refused; fix classes.json / --provider / open tabs, then re-run):');
        for (const nr of needsReview) ui.plain(`  ${nr.name.padEnd(22)} ${nr.code}: ${nr.reason}`);
        ui.blank();
    }
    if (manualFollow.length > 0) {
        ui.warn('Manual follow needed (inline follow failed or was rejected):');
        for (const mf of manualFollow) {
            ui.plain(`  ${mf.name.padEnd(22)} ${mf.reason}`);
            ui.plain(`    ${mf.url}`);
        }
        ui.blank();
        const onlyArg = manualFollow.map((x) => x.name).join(',');
        ui.info('To retry via the batch follow path:');
        ui.plain(`  pulchowk-events batch follow --run ${path.basename(runDir)} --only ${onlyArg}`);
        ui.blank();
    }
    if (failed === 0 && manualFollow.length === 0 && needsReview.length === 0) {
        ui.action('next: pulchowk-events batch verify');
    } else if (failed > 0 || needsReview.length > 0) {
        ui.action('re-run `batch paste --extension` to retry failed items');
    }
    ui.blank();

    return {
        written,
        redirected,
        skipped: already.length + terminal.length,
        failed,
        manualFollow,
        notCareers,
        needsReview,
    };
}

function emptyResult() {
    return { written: 0, redirected: 0, skipped: 0, failed: 0, manualFollow: [], notCareers: [], needsReview: [] };
}

module.exports = { runPasteExtension };
