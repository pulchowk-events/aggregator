// scripts/batch/refine.js
// Two-way loop, verify-failure half. For every LLM-origin site that
// failed verify, append the failure evidence to its original prompt and
// delete its generated extractor so paste re-prompts it with context.
// Bounded: 3 attempts per site, then terminal.
//
// Reads:  verify-summary.json + results/<name>.json + prompts/<name>.md
// Writes: prompts/<name>.md (rewritten with retry section)
//         deletes generated/<name>.js
//         classes.json gains llmAttempts counter
//
// Skips:
//   - template/ATS sites (isTemplate truthy) -- those go through
//     `promote`, not refine. Template fails mean "wrong card group or
//     wrong ATS shape" and need LLM from scratch, not LLM-with-retry.
//   - sites with llmAttempts >= MAX_ATTEMPTS -- terminal.
//   - sites that passed verify.
//   - sites that aren't in prompts/ (rejected, ATS-only, etc.).
//
// The retry prompt content:
//   - original prompt unchanged
//   - appended section "## Prior attempts" with the failure summary
//   - verbatim stderrTail excerpt from results/<name>.json (last 40
//     lines: item count, verdict, sample rejects, extractor warnings)
//   - instruction: "the previous attempt failed with the above. Fix the
//     specific failure before writing new code."
//
// This mirrors how a human would brief the LLM: "your last try said it
// navigated to categories but returned 0 items; here's the log; try again."
// Same prompt shape -> same reply quality bar as attempt 1.

const fs = require('fs');
const path = require('path');

const { paths, readClasses, writeClasses, readLatest, resolveRunDir, ensureRunLayout } = require('./lib/paths');
const { audit } = require('./lib/audit');
const ui = require('./lib/ui');

const MAX_ATTEMPTS = 3;
const STDERR_TAIL_LINES = 40;
const RETRY_MARKER = '## Prior attempts';
const RETRY_HEADER = '\n\n---\n\n';

function parseArgs(argv) {
    const args = { runId: null, only: null, force: false, maxAttempts: MAX_ATTEMPTS };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--run' && argv[i + 1]) { args.runId = argv[++i]; }
        else if (a === '--only' && argv[i + 1]) { args.only = argv[++i].split(',').map((s) => s.trim()); }
        else if (a === '--force') { args.force = true; }
        else if (a === '--max-attempts' && argv[i + 1]) { args.maxAttempts = Math.max(1, parseInt(argv[++i], 10) || MAX_ATTEMPTS); }
    }
    return args;
}

function pickRunDir(runId) {
    if (runId) return resolveRunDir(runId);
    const latest = readLatest();
    if (!latest) throw new Error('no --run and no latest pointer; run discover first');
    return resolveRunDir(latest);
}

function loadJson(p, fallback) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

// Strip the previous "## Prior attempts" block so re-refining doesn't
// stack sections. Always reconstructs from the base prompt + one new
// failure block.
function stripPriorAttempts(promptBody) {
    // Only match the specific marker line. Do NOT fall back to the '---'
    // separator -- any horizontal rule or code block in the base prompt
    // would trigger it and truncate legitimate content.
    const idx = promptBody.indexOf('\n' + RETRY_MARKER);
    if (idx > 0) return promptBody.slice(0, idx).trimEnd();
    return promptBody.trimEnd();
}

// Build the retry section. Runs on every refine for this site, replacing
// any prior attempt section with the accumulated attempt list.
function buildPriorAttemptsSection(attempts) {
    const lines = [];
    lines.push(RETRY_HEADER.trim());
    lines.push('');
    lines.push(RETRY_MARKER);
    lines.push('');
    lines.push('The batch system ran a previous extractor against this site and it');
    lines.push('failed. Fix the specific failure shown below before writing new code.');
    lines.push('Do NOT re-emit the same extractor. Read the failure carefully:');
    lines.push('');
    if (attempts.length === 0) {
        lines.push('(no attempts recorded -- this should not happen)');
    } else {
        for (let i = 0; i < attempts.length; i++) {
            const a = attempts[i];
            lines.push('### Attempt ' + (i + 1) + ' -- verdict: ' + (a.verdict || 'unknown'));
            lines.push('');
            if (a.items !== null && a.items !== undefined) {
                lines.push('- items returned: ' + a.items);
            }
            if (a.listingHits !== null && a.listingHits !== undefined) {
                lines.push('- listingHits (post-selector card count): ' + a.listingHits);
            }
            if (a.reason) {
                lines.push('- batch classification: ' + a.reason);
            }
            if (a.durationSec !== null && a.durationSec !== undefined) {
                lines.push('- duration: ' + a.durationSec + 's');
            }
            if (a.stderrTail) {
                lines.push('');
                lines.push('Extractor stderr (verbatim, last ~' + STDERR_TAIL_LINES + ' lines):');
                lines.push('```');
                lines.push(a.stderrTail.slice(-4000));
                lines.push('```');
            }
            if (a.stdoutTail) {
                lines.push('');
                lines.push('Extractor stdout (verbatim, tail):');
                lines.push('```');
                lines.push(a.stdoutTail.slice(-2000));
                lines.push('```');
            }
            lines.push('');
        }
    }
    lines.push('Address the failure above in your new extractor. If the site requires');
    lines.push('multi-level navigation (listing -> category -> detail), do that. If');
    lines.push('the selectors do not match, use the ones shown in the evidence dump.');
    lines.push('If the site is genuinely empty, return { items: [], meta } with');
    lines.push('meta.listingHits = 0 -- but only if the dump truly shows no items.');
    lines.push('');
    return lines.join('\n');
}

// Read prior attempts from an existing prompt body (for accumulation).
// Returns array of { verdict, items, listingHits, reason, durationSec,
// stderrTail, stdoutTail } parsed out of the "## Prior attempts" block,
// OR [] if none present. We don't parse structured data out of the
// prose -- we just count how many "### Attempt N" subheaders exist so
// the numbering is correct. The actual attempt content is re-sourced
// from results/<name>.json on each refine, NOT accumulated from text.
function countPriorAttemptHeaders(promptBody) {
    const idx = promptBody.indexOf(RETRY_MARKER);
    if (idx === -1) return 0;
    const tail = promptBody.slice(idx);
    const re = /### Attempt \d+/g;
    let n = 0;
    while (re.exec(tail) !== null) n++;
    return n;
}

function runRefine(opts) {
    const runDir = pickRunDir(opts.runId);
    const p = ensureRunLayout(runDir);
    const classes = readClasses(runDir) || {};
    const verifySummary = loadJson(path.join(runDir, 'verify-summary.json'), null);
    if (!verifySummary) {
        throw new Error(`verify-summary.json not found in ${runDir}; run \`batch verify\` first`);
    }

    ui.banner({
        title: 'Batch Refine (verify-failure -> retry prompt)',
        sub: `max ${opts.maxAttempts} attempts per site`
    });

    const candidates = [];
    const skipped = {
        passed: 0,
        notLlmOrigin: 0,
        exhausted: 0,
        noPrompt: 0,
        noResult: 0
    };

    for (const [name, result] of Object.entries(verifySummary)) {
        if (opts.only && !opts.only.includes(name)) continue;
        if (result.pass) { skipped.passed++; continue; }

        // Only LLM-origin sites get refined. ATS/template sites go through
        // `promote` (delete template, write fresh prompt, paste once). Refining
        // a template's output is conceptually wrong: the template's failure
        // is structural, not a tweak-away bug.
        const cls = classes[name] || {};
        const isTemplateOrigin = Boolean(
            (cls.classResult && cls.classResult.template) ||
            cls.templatedBy
        );
        if (isTemplateOrigin && !opts.force) { skipped.notLlmOrigin++; continue; }

        // Prompt required for re-paste.
        const promptPath = path.join(p.prompts, `${name}.md`);
        if (!fs.existsSync(promptPath)) { skipped.noPrompt++; continue; }

        // Attempt cap.
        const currentAttempts = (cls.llmAttempts || 0) + 1;
        if (currentAttempts > opts.maxAttempts && !opts.force) {
            skipped.exhausted++;
            audit.skip(runDir, { phase: 'refine', name, url: cls.targetUrl || cls.url, reason: `attempt cap (${cls.llmAttempts || 0}/${opts.maxAttempts})` });
            continue;
        }

        // Per-site result file (has stderrTail + stdoutTail). If missing,
        // fall back to the summary entry, which lacks stderrTail.
        const resPath = path.join(p.results, `${name}.json`);
        const detailed = loadJson(resPath, null) || result;

        candidates.push({ name, result: detailed, cls, promptPath, currentAttempts });
    }

    ui.info(`candidates: ${candidates.length}`);
    if (skipped.passed) ui.info(`  skipped ${skipped.passed} passed`);
    if (skipped.notLlmOrigin) ui.info(`  skipped ${skipped.notLlmOrigin} template-origin (use \`batch promote\` for those)`);
    if (skipped.exhausted) ui.info(`  skipped ${skipped.exhausted} attempt cap reached (${opts.maxAttempts})`);
    if (skipped.noPrompt) ui.info(`  skipped ${skipped.noPrompt} no prompt file`);
    ui.blank();

    if (candidates.length === 0) {
        ui.ok('nothing to refine');
        ui.blank();
        return { refined: 0, skipped };
    }

    let refined = 0;
    for (const c of candidates) {
        // Read original prompt, strip any prior attempt section.
        const original = fs.readFileSync(c.promptPath, 'utf8');
        const base = stripPriorAttempts(original);

        // Build attempts array: 1 entry per prior attempt, plus the current
        // failure. Prior attempts are placeholders (we don't have their
        // stderrTail anymore -- results/<name>.json was overwritten each
        // verify); the current failure carries full evidence. That's fine
        // for the LLM: what matters is "here's the most recent failure".
        const priorCount = countPriorAttemptHeaders(original);
        const attempts = [];
        for (let i = 0; i < priorCount; i++) {
            attempts.push({
                verdict: '(prior attempt -- details not preserved)',
                items: null,
                listingHits: null,
                reason: 'earlier retry, results overwritten',
                durationSec: null,
                stderrTail: null,
                stdoutTail: null
            });
        }
        attempts.push({
            verdict: c.result.verdict,
            items: c.result.items,
            listingHits: (c.result.stdoutTail || '').match(/^listingHits:\s*(\d+)/m)
                ? parseInt((c.result.stdoutTail || '').match(/^listingHits:\s*(\d+)/m)[1], 10)
                : null,
            reason: c.result.reason,
            durationSec: c.result.durationSec,
            stderrTail: c.result.stderrTail,
            stdoutTail: c.result.stdoutTail
        });

        const newPrompt = base + '\n' + buildPriorAttemptsSection(attempts);
        fs.writeFileSync(c.promptPath, newPrompt);

        // Delete the failed extractor so paste re-picks this site.
        const genPath = path.join(p.generated, `${c.name}.js`);
        if (fs.existsSync(genPath)) fs.unlinkSync(genPath);

        // Increment attempt counter.
        if (!classes[c.name]) classes[c.name] = {};
        classes[c.name].llmAttempts = c.currentAttempts;

        audit.wizardPrompt(runDir, {
            name: c.name,
            url: c.result.url || c.cls.targetUrl || c.cls.url || null,
            siteType: c.cls.wizardDetectedType || null,
            ok: true,
            error: null
        });
        const tag = c.currentAttempts === opts.maxAttempts ? ui.tag('warn') : ui.tag('pass');
        ui.line(`  ${tag}  ${c.name.padEnd(22)}  attempt ${c.currentAttempts}/${opts.maxAttempts} · was ${c.result.reason} (${c.result.items ?? '?'} items)`);
        refined++;
    }

    writeClasses(runDir, classes);

    ui.blank();
    ui.divider('Summary');
    ui.blank();
    ui.summary([
        ['refined', String(refined)],
        ['next step', refined > 0 ? 'batch paste (retries with failure evidence)' : 'none']
    ]);
    ui.blank();
    if (refined > 0) ui.action('next: pulchowk-events batch paste');
    ui.blank();

    return { refined, skipped };
}

module.exports = { runRefine, parseArgs, MAX_ATTEMPTS };

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    try {
        runRefine(opts);
    } catch (e) {
        console.error('✗ refine failed:', e.message);
        if (e.stack) console.error(e.stack);
        process.exit(1);
    }
}
