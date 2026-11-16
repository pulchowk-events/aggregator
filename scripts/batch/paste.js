// scripts/batch/paste.js
// Phase 2b: interactive paste loop.
//
// Default mode: clipboard polling. Copy prompt to clipboard, poll every
// 1s for a change, validate the reply, write to generated/<name>.js,
// advance. No Enter presses -- the human works at their own pace.
//
// --no-poll mode: legacy Enter-driven flow (escape hatch for terminals
// without a working clipboard reader).
//
// Reuses the wizard's helpers (copyToClipboard, readFromClipboard,
// openUrl, stripMarkdownFences, looksLikeExtractorCode) so behavior
// matches the single-site wizard paste flow.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const { paths, readLatest, resolveRunDir, ensureRunLayout, writeClasses } = require('./lib/paths');
const { validatePrompt } = require('./lib/prompt-structure');
const { parseVerdict, isSameDomainRedirect, shouldSkipVerify } = require('./lib/llm-header');
const { followOneSite } = require('./follow');
const { audit } = require('./lib/audit');
const ui = require('./lib/ui');
const {
    copyToClipboard,
    readFromClipboard,
    openUrl,
    stripMarkdownFences,
    looksLikeExtractorCode,
    LLM_PROVIDERS
} = require('../wizard/interactive');

const POLL_INTERVAL_MS = 1000;
const POLL_HEARTBEAT_MS = 15000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// Parse-check JS via `node --check` before committing to disk.
// WSL's clipboard bridge mangles ₹ (U+20B9) to '?' on round-trip. That
// corrupts currency regexes: /(NPR|Rs\.?|₹|\$)/ becomes
// /(NPR|Rs\.?|?|\$)/ which won't parse as a regex literal. Detection:
// a bare '?' between two alternation pipes ('|?|') never appears in
// valid JS regex -- it's the mangling signature. Restore ₹ before
// re-validating.
function autoHealClipboard(code) {
    return String(code).replace(/\|\?\|/g, '|\u20B9|');
}

function validateJs(code) {
    const tryCheck = (c) => {
        const tmp = path.join(os.tmpdir(), `batch-paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.js`);
        try {
            fs.writeFileSync(tmp, c);
            const r = spawnSync('node', ['--check', tmp], { encoding: 'utf8', timeout: 10000 });
            if (r.status === 0) return { ok: true, code: c };
            const msg = (r.stderr || r.stdout || 'syntax error').split('\n').slice(0, 3).join(' ').trim();
            return { ok: false, reason: msg };
        } catch (e) {
            return { ok: false, reason: e.message };
        } finally {
            try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
        }
    };

    const first = tryCheck(code);
    if (first.ok) return first;

    // Only auto-heal when the failure mode is the clipboard corruption
    // pattern. Other syntax errors pass through untouched so we don't
    // mask real bugs in the LLM's output.
    const healed = autoHealClipboard(code);
    if (healed !== code) {
        const second = tryCheck(healed);
        if (second.ok) {
            console.warn('  \u26a0\ufe0f  auto-healed clipboard mangling (₹ restored)');
            return second;
        }
    }
    return first;
}

// Normalize text for clipboard comparison. WSL's clip.exe writes CRLF while
// JS-side strings are LF, so a byte comparison of "same content" fails on
// line endings alone.
function normalizeForCompare(s) {
    return String(s || '').replace(/\r\n/g, '\n').trim();
}

// Poll clipboard until content changes to something that parses as JS and
// is not the prompt we just copied. Prints a heartbeat dot every
// POLL_HEARTBEAT_MS so the terminal doesn't look dead.
async function pollClipboardForReply({ timeoutMs, promptBody, name, targetUrl }) {
    const start = Date.now();
    const promptNorm = normalizeForCompare(promptBody);
    let lastHeartbeat = start;
    let lastWarn = 0;

    while (Date.now() - start < timeoutMs) {
        await sleep(POLL_INTERVAL_MS);
        let cur = null;
        try {
            cur = readFromClipboard();
        } catch (e) {
            cur = null;
        }
        const curNorm = normalizeForCompare(cur);

        // Empty, unchanged, or still holding the prompt we just copied --
        // keep waiting.
        if (!cur || curNorm.length < 50 || curNorm === promptNorm) {
            if (Date.now() - lastHeartbeat >= POLL_HEARTBEAT_MS) {
                process.stdout.write(ui.colors.D + '.' + ui.colors.R);
                lastHeartbeat = Date.now();
            }
            continue;
        }

        // Parse verdict from the RAW clipboard (whole message), not the
        // stripped code. If the user copied only the code block, verdict
        // becomes UNSPECIFIED (backward-compat, extractor still runs). If
        // they copied the whole message, the VERDICT line survives even
        // though the code block is embedded in fences.
        const verdictProbe = parseVerdict(cur);
        const code = extractCodeFromClipboard(cur);
        const isExtractorShaped = looksLikeExtractorCode(code);
        const hasNegativeVerdict = verdictProbe.known && verdictProbe.type !== 'CAREERS_PAGE';

        if (!isExtractorShaped && !hasNegativeVerdict) {
            if (Date.now() - lastWarn > 30000) {
                ui.blank();
                ui.warn('clipboard changed but is neither an extractor nor a negative verdict -- still polling');
                lastWarn = Date.now();
            }
            continue;
        }

        // Parse-check + identity check only when the reply is code.
        let parsed = null;
        if (isExtractorShaped) {
            parsed = validateJs(code);
            if (!parsed.ok) {
                // Broken code for the RIGHT site still advances. Refine
                // will retry with the specific parse error as evidence.
                // Broken code for the WRONG site is a stale clipboard --
                // keep polling.
                if (!looksLikeRightSite(code, name, targetUrl)) {
                    if (Date.now() - lastWarn > 15000) {
                        ui.warn(`parse failed AND does not reference "${name}" -- wrong clipboard? still polling`);
                        lastWarn = Date.now();
                    }
                    continue;
                }
                if (Date.now() - lastWarn > 5000) {
                    ui.blank();
                    ui.warn(`parse failed, writing anyway (refine will retry): ${parsed.reason.slice(0, 100)}`);
                    lastWarn = Date.now();
                }
                return { code, raw: cur, parse_failed: true, parse_error: parsed.reason };
            }
            // Identity check: does this extractor reference the current site?
            // If not, likely the user copied a previous site's reply.
            if (!looksLikeRightSite(code, name, targetUrl)) {
                if (Date.now() - lastWarn > 15000) {
                    ui.blank();
                    ui.warn(`clipboard is a valid extractor but does not reference "${name}" -- wrong clipboard?`);
                    ui.info(`site: ${name}${targetUrl ? ' (' + targetUrl + ')' : ''} -- still polling`);
                    lastWarn = Date.now();
                }
                continue;
            }
        }

        // Negative verdicts (NOT_CAREERS_PAGE, REDIRECT) must reference
        // the site -- otherwise a stale clipboard from a previous site
        // could incorrectly mark THIS site as dead, silently losing the
        // source.
        if (hasNegativeVerdict && !isExtractorShaped) {
            const verdictText = (verdictProbe.raw || '') + ' ' + (verdictProbe.evidence || '') + ' ' + cur;
            if (!looksLikeRightSite(verdictText, name, targetUrl)) {
                if (Date.now() - lastWarn > 15000) {
                    ui.warn(`negative verdict does not reference "${name}" -- likely stale clipboard`);
                    ui.info('ask LLM to include site name in the reason, or copy the reply again');
                    lastWarn = Date.now();
                }
                continue;
            }
            // Duplicate-detection: byte-identical negative verdict accepted
            // for another site in the last 5 min is almost certainly stale.
            const crypto = require('crypto');
            const rawHash = crypto.createHash('sha1').update(cur).digest('hex').slice(0, 12);
            if (module._lastNegVerdictHash === rawHash && Date.now() - (module._lastNegVerdictAt || 0) < 300000) {
                if (Date.now() - lastWarn > 15000) {
                    ui.warn(`identical negative verdict accepted for another site recently -- likely stale clipboard`);
                    lastWarn = Date.now();
                }
                continue;
            }
            module._lastNegVerdictHash = rawHash;
            module._lastNegVerdictAt = Date.now();
        }

        return { code: (parsed && parsed.code) ? parsed.code : code, raw: cur };
    }
    return null;
}

// Manual-paste fallback when clipboard read fails. Reads stdin until EOF.
function readFromStdin() {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        const lines = [];
        ui.warn('clipboard read failed -- paste code here, then type EOF on its own line');
        rl.on('line', (line) => {
            if (line === 'EOF') { rl.close(); }
            else { lines.push(line); }
        });
        rl.on('close', () => resolve(lines.join('\n')));
    });
}

function waitForEnter(message) {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(`  ${message} `, () => { rl.close(); resolve(); });
    });
}

// Remove a leading VERDICT: line from a code block. The LLM emits it
// before the code as required by the prompt; leaving it in the extractor
// would break `node --check`.
function stripVerdictLine(code) {
    return String(code || '').replace(/^\s*VERDICT\s*:\s*[^\n]+\n?/i, '').trimStart();
}

// Extract the code block from a clipboard payload. Handles two copy modes:
//
//   1. User copied only the code block: raw === code. No fences to find;
//      stripMarkdownFences is a no-op.
//   2. User copied the whole LLM message: raw === prose + fenced code +
//      trailing prose. Find the largest ```js...``` block and take only
//      its contents. Prose and other fences are dropped.
//
// "Largest" not "first": LLMs occasionally show a small snippet (e.g.
// imports only) as illustration before the real extractor. The real
// extractor is always the longest fenced block. Taking the largest is
// the safer heuristic.
// Identity check: does this extractor actually reference the site it is
// about to be written for? Catches the "user copied the wrong LLM reply"
// failure mode -- e.g. pasting an extractor for site A while the batch is
// on site B. Without this, a wrong clipboard silently writes an extractor
// that lives at the wrong path and fails verify with a confusing reason.
//
// Pass criteria (any one is enough -- LLMs sometimes omit the others):
//   1. name appears as a quoted string literal (source: '<name>')
//   2. the site's hostname (or registrable part) appears in the code
//   3. name appears as a word-boundary token in the first 1000 chars
//      (header comment area -- where LLMs put "// Extractor: <name>")
function looksLikeRightSite(code, name, targetUrl) {
    // Collision tolerance: for names ending in -N (e.g. 'adex-2'), accept
    // if the code references the base name ('adex'). The LLM writes the
    // site's natural name even when told to use 'adex-2' -- that IS the
    // correct identity. The -N suffix is only internal file naming.
    const baseName = name.replace(/-\d+$/, '');
    if (baseName !== name && code && String(code).includes(baseName)) {
        return true;
    }
    if (!code || !name) return false;
    const escName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 1. Quoted literal name.
    if (new RegExp(`['"\`]${escName}['"\`]`).test(code)) return true;

    // 2. Hostname (or its 2-label suffix).
    if (targetUrl) {
        try {
            const host = new URL(targetUrl).hostname.replace(/^www\./i, '');
            if (host && code.includes(host)) return true;
            const parts = host.split('.');
            if (parts.length >= 2) {
                const tail = parts.slice(-2).join('.');
                if (tail && code.includes(tail)) return true;
            }
        } catch (e) { /* ignore */ }
    }

    // 3. Word-boundary name in header comment.
    const head = code.slice(0, 1000);
    if (new RegExp(`\\b${escName}\\b`, 'i').test(head)) return true;

    return false;
}

function extractCodeFromClipboard(raw) {
    if (!raw) return '';
    const fenceRe = /```(?:js|javascript|node|mjs|ts|typescript)?\s*\n([\s\S]*?)\n```/g;
    let best = null;
    let m;
    while ((m = fenceRe.exec(raw)) !== null) {
        if (best === null || m[1].length > best.length) best = m[1];
    }
    if (best !== null) return best;
    return stripMarkdownFences(raw);
}

function parseArgs(argv) {
    const args = {
        includeSmall: false,
        runId: null,
        only: null,
        provider: null,  // null = --provider not passed; ProviderRouter decides
        skipBrowser: false,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        usePoll: true,
        mode: null  // 'manual' | 'extension' | null (=auto)
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run' && argv[i + 1]) { args.runId = argv[++i]; }
        else if (a === '--only' && argv[i + 1]) { args.only = argv[++i].split(',').map((s) => s.trim()); }
        else if (a === '--provider' && argv[i + 1]) { args.provider = argv[++i]; }
        else if (a === '--no-browser') { args.skipBrowser = true; }
        else if (a === '--no-poll') { args.usePoll = false; }
        else if (a === '--include-small') { args.includeSmall = true; }
        else if (a === '--manual') { args.mode = 'manual'; }
        else if (a === '--extension') { args.mode = 'extension'; }
        else if (a === '--timeout' && argv[i + 1]) {
            const secs = parseInt(argv[++i], 10);
            if (secs > 0) args.timeoutMs = secs * 1000;
        }
    }
    // Auto mode: extension if EXTENSION_TOKEN is present, manual otherwise.
    // Explicit flags always win. --extension without a token is a hard
    // error so the user isn't silently dropped into manual.
    if (args.mode === null) {
        args.mode = process.env.EXTENSION_TOKEN ? 'extension' : 'manual';
    }
    if (args.mode === 'extension' && !process.env.EXTENSION_TOKEN) {
        throw new Error('--extension requires EXTENSION_TOKEN in .env');
    }
    return args;
}

function pickRunDir(runId) {
    if (runId) return resolveRunDir(runId);
    const latest = readLatest();
    if (!latest) throw new Error('no --run and no latest pointer; run discover first');
    return resolveRunDir(latest);
}

async function runPaste(opts) {
    // Dispatch to extension mode. Lazy require avoids a circular import
    // (paste-extension.js requires helpers from this file).
    if (opts.mode === 'extension') {
        return require('./paste-extension').runPasteExtension(opts);
    }
    const runDir = pickRunDir(opts.runId);
    const p = ensureRunLayout(runDir);

    const classes = (() => {
        try { return JSON.parse(fs.readFileSync(p.classes, 'utf8')); } catch (e) { return {}; }
    })();

    if (!fs.existsSync(p.prompts)) {
        ui.info(`no prompts/ in ${runDir}; nothing to paste (all ATS?).`);
        return { written: 0, redirected: 0, skipped: 0, failed: 0, manualFollow: [], notCareers: [] };
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


    // Starved-prompt filter. A prompt under 40KB lacks enough raw HTML to
    // give the LLM real structure -- it will produce hollow code that
    // fails verify. Skip unless --include-small was passed. The threshold
    // matches the triage output: sites under 40K after chrome-strip
    // either have tiny content (legit) or wrong-content fallback (bug).
    if (!opts.includeSmall) {
        const MIN_PROMPT_BYTES = 40000;
        const starved = [];
        const kept = [];
        for (const name of pending) {
            const promptPath = path.join(p.prompts, `${name}.md`);
            try {
                const stat = fs.statSync(promptPath);
                if (stat.size < MIN_PROMPT_BYTES) {
                    starved.push({ name, size: stat.size });
                } else {
                    kept.push(name);
                }
            } catch (e) {
                kept.push(name);  // can't stat = pass through, don't block
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
        sub: `${pending.length} to answer · ${already.length} generated · ${terminal.length} terminal (skipped)`
    });

    if (pending.length === 0) {
        ui.ok('nothing to paste');
        ui.blank();
        return { written: 0, redirected: 0, skipped: already.length + terminal.length, failed: 0, manualFollow: [], notCareers: [] };
    }

    ui.info('How this works:');
    ui.plain('  For each site:');
    ui.plain('    1. Prompt copied to your clipboard.');
    ui.plain('    2. Ctrl+V into DeepSeek (NEW chat), send.');
    ui.plain('    3. Copy DeepSeek\'s reply.');
    ui.plain('    4. Come back here -- do NOTHING in this terminal.');
    ui.plain('  The loop watches your clipboard. Three reply shapes accepted:');
    ui.plain('    - Extractor code (module.exports...)     -> written to generated/');
    ui.plain('    - VERDICT: CAREERS_PAGE_REDIRECT -- <url>');
    ui.plain('        -> followed INLINE (dump + re-prompt, bounded same-domain)');
    ui.plain('    - VERDICT: NOT_CAREERS_PAGE -- <reason>');
    ui.plain('        -> recorded, skipped (fix urls.txt later)');
    ui.plain('  Ctrl+C aborts.');
    ui.blank();
    ui.info(`Mode: ${opts.usePoll ? `clipboard polling (${POLL_INTERVAL_MS/1000}s interval, ${Math.round(opts.timeoutMs/1000)}s timeout)` : 'Enter-driven (--no-poll)'}`);
    ui.blank();

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

    if (!opts.skipBrowser) {
        const provider = LLM_PROVIDERS.find((x) => x.value === opts.provider) || LLM_PROVIDERS[0];
        if (provider.url) {
            openUrl(provider.url);
            ui.ok(`opened ${provider.label} (${provider.url})`);
            ui.blank();
        }
    }

    const manualFollow = [];
    const notCareers = [];
    let written = 0;
    let redirected = 0;
    let failed = 0;

    const MAX_HOPS = 3;

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
                ui.fail(`prompt disappeared mid-run`);
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

            if (!copyToClipboard(promptBody)) {
                ui.fail('clipboard copy failed');
                failed++;
                siteDone = true;
                break;
            }
            ui.ok('prompt copied to clipboard');

            let raw;
            if (opts.usePoll) {
                ui.waitingFor(
                    'you to copy DeepSeek\'s reply to your clipboard',
                    `${Math.round(opts.timeoutMs/1000)}s timeout · Ctrl+C aborts`
                );
                const reply = await pollClipboardForReply({ timeoutMs: opts.timeoutMs, promptBody, name, targetUrl: (classes[name] && (classes[name].targetUrl || classes[name].url)) || null });
                if (!reply) {
                    ui.fail(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
                    failed++;
                    siteDone = true;
                    break;
                }
                ui.blank();
                raw = reply.raw;
            } else {
                await waitForEnter('paste in DeepSeek, copy reply, press Enter:');
                raw = readFromClipboard();
                if (!raw || raw.trim().length < 50) raw = await readFromStdin();
            }

            const verdict = parseVerdict(raw);
            const code = extractCodeFromClipboard(raw);
            const cls = classes[name] || {};
            const targetUrlForVerdict = cls.targetUrl || cls.url || null;

            if (verdict.known && verdict.type === 'CAREERS_PAGE_REDIRECT') {
                if (!verdict.suggestedUrl) {
                    const reason = 'REDIRECT verdict without URL';
                    ui.fail(reason);
                    notCareers.push({ name, reason });
                    fs.writeFileSync(path.join(p.redirects, `${name}.json`), JSON.stringify({
                        type: 'NOT_CAREERS_PAGE', reason, hopCount: hop, updatedAt: new Date().toISOString()
                    }, null, 2));
                    audit.skip(runDir, { phase: 'paste', name, url: targetUrlForVerdict, reason });
                    siteDone = true;
                    break;
                }

                if (targetUrlForVerdict && !isSameDomainRedirect(targetUrlForVerdict, verdict.suggestedUrl)) {
                    const reason = `cross-domain redirect rejected (${verdict.suggestedUrl} from ${targetUrlForVerdict})`;
                    ui.warn(reason);
                    manualFollow.push({ name, url: verdict.suggestedUrl, reason });
                    fs.writeFileSync(path.join(p.redirects, `${name}.json`), JSON.stringify({
                        type: 'NOT_CAREERS_PAGE', reason, hopCount: hop, updatedAt: new Date().toISOString()
                    }, null, 2));
                    audit.skip(runDir, { phase: 'paste', name, url: targetUrlForVerdict, reason });
                    siteDone = true;
                    break;
                }

                if (hop >= MAX_HOPS) {
                    const reason = `redirect depth cap ${hop}/${MAX_HOPS} (last: ${verdict.suggestedUrl})`;
                    ui.warn(reason);
                    manualFollow.push({ name, url: verdict.suggestedUrl, reason: 'hop cap' });
                    fs.writeFileSync(path.join(p.redirects, `${name}.json`), JSON.stringify({
                        type: 'NOT_CAREERS_PAGE', reason, hopCount: hop, updatedAt: new Date().toISOString()
                    }, null, 2));
                    audit.skip(runDir, { phase: 'paste', name, url: targetUrlForVerdict, reason });
                    siteDone = true;
                    break;
                }

                ui.ok(`verdict REDIRECT -> ${verdict.suggestedUrl} (hop ${hop + 1}/${MAX_HOPS})`);
                ui.info(`following inline (dump + re-prompt)...`);
                const followResult = await followOneSite({
                    name,
                    redirectUrl: verdict.suggestedUrl,
                    hopCount: hop,
                    runDir,
                    classes,
                    opts: { maxHops: MAX_HOPS, timeoutSec: opts.followTimeoutSec || 120 }
                });

                if (followResult.ok) {
                    ui.ok(`followed: detected ${followResult.detected.type}, new prompt ready (${(followResult.promptBody.length / 1024).toFixed(1)} KB)`);
                    audit.skip(runDir, { phase: 'paste', name, url: targetUrlForVerdict, reason: `inline follow -> ${verdict.suggestedUrl}` });
                    hop++;
                    didFollow = true;
                    ui.blank();
                    continue;
                }

                ui.fail(`inline follow failed: ${followResult.reason}`);
                manualFollow.push({ name, url: verdict.suggestedUrl, reason: followResult.reason });
                audit.skip(runDir, { phase: 'paste', name, url: targetUrlForVerdict, reason: `inline follow failed: ${followResult.reason}` });
                siteDone = true;
                break;
            }

            if (verdict.known && verdict.type === 'NOT_CAREERS_PAGE') {
                const reason = verdict.evidence || '(no reason given)';
                ui.warn(`verdict NOT_CAREERS_PAGE: ${reason}`);
                notCareers.push({ name, reason });
                fs.writeFileSync(path.join(p.redirects, `${name}.json`), JSON.stringify({
                    type: 'NOT_CAREERS_PAGE', reason, hopCount: hop, updatedAt: new Date().toISOString()
                }, null, 2));
                audit.skip(runDir, { phase: 'paste', name, url: targetUrlForVerdict, reason: `llm-verdict NOT_CAREERS: ${reason}` });
                siteDone = true;
                break;
            }

            if (verdict.known && verdict.type === 'CAREERS_PAGE') {
                ui.ok(`verdict CAREERS_PAGE${verdict.evidence ? ' -- ' + verdict.evidence : ''}`);
            }

            const finalCode = stripVerdictLine(code);
            if (!looksLikeExtractorCode(finalCode)) {
                ui.fail(`reply does not look like an extractor (${finalCode.length} chars)`);
                ui.info('first 200 chars:');
                ui.plain(finalCode.slice(0, 200).replace(/\n/g, '\n  '));
                failed++;
                siteDone = true;
                break;
            }
            const parsed = validateJs(finalCode);
            if (!parsed.ok) {
                // Write the broken code so verify + refine handle it. Log
                // to parse-fails.jsonl for diagnostics. User is not forced
                // to fix syntax manually -- refine retries with the error.
                const outPathBroken = path.join(p.generated, `${name}.js`);
                fs.writeFileSync(outPathBroken, finalCode);
                try {
                    const parseFailLog = path.join(runDir, 'parse-fails.jsonl');
                    fs.appendFileSync(parseFailLog, JSON.stringify({
                        name,
                        at: new Date().toISOString(),
                        error: parsed.reason.slice(0, 300),
                        bytes: finalCode.length
                    }) + '\n');
                } catch (e) { /* best-effort */ }
                audit.llmWrite(runDir, { name, lineCount: finalCode.split('\n').length, bytes: finalCode.length });
                ui.warn(`wrote generated/${name}.js (parse failed: ${parsed.reason.slice(0, 80)})`);
                ui.info('verify will catch, refine will retry with specific error');
                failed++;
                siteDone = true;
                break;
            }

            // Defense-in-depth identity check. The poller already gated
            // on this, but if the paste mode was --no-poll (Enter-driven)
            // or the poll path short-circuited on a negative verdict that
            // turned out to be a false-positive, we still want to catch
            // wrong-site content before writing.
            if (!looksLikeRightSite(finalCode, name, targetUrlForVerdict)) {
                ui.fail(`extractor does not reference "${name}" -- wrong clipboard?`);
                ui.info(`expected to see "${name}" or the site's hostname in the code`);
                ui.info('first 200 chars:');
                ui.plain(finalCode.slice(0, 200).replace(/\n/g, '\n  '));
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

    writeClasses(runDir, classes);

    ui.blank();
    ui.divider('Summary');
    ui.blank();
    const headline = failed === 0 ? ui.tag('pass') : ui.tag('warn');
    ui.line(`  ${headline}  paste complete`);
    ui.blank();
    ui.summary([
        ['written', String(written)],
        ['followed inline', String(redirected)],
        ['not-a-careers-page', String(notCareers.length)],
        ['failed', String(failed)],
        ['manual follow needed', String(manualFollow.length)],
        ['already present', String(already.length)]
    ]);
    ui.blank();

    if (notCareers.length > 0) {
        ui.warn('LLM says these URLs are NOT careers pages -- fix or remove from urls.txt:');
        for (const nc of notCareers) ui.plain(`  ${nc.name.padEnd(22)} ${nc.reason}`);
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
        ui.info('To retry via the batch follow path (rare -- usually means a browser crash):');
        ui.plain(`  pulchowk-events batch follow --run ${path.basename(runDir)} --only ${onlyArg}`);
        ui.blank();
    }

    if (failed === 0 && manualFollow.length === 0) {
        ui.action('next: pulchowk-events batch verify');
    } else if (failed > 0) {
        ui.action('re-run `batch paste` to retry failed items');
    }
    ui.blank();

    return { written, redirected, skipped: already.length + terminal.length, failed, manualFollow, notCareers };
}

module.exports = { runPaste, parseArgs, validateJs, normalizeForCompare, extractCodeFromClipboard, looksLikeRightSite, pickRunDir, stripVerdictLine };

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    runPaste(opts).catch((e) => {
        ui.fail(`paste failed: ${e.message}`);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    });
}
