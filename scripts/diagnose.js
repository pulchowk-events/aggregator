#!/usr/bin/env node
// scripts/diagnose.js
//
// Drift diagnosis CLI. Loads a source extractor's target page in a fresh
// browser and reports:
//   1. Page state (blocked by Cloudflare? empty? content present?)
//   2. Every CSS-selector-looking string extracted from the extractor source
//   3. Count + first-match sample for each selector
//   4. For each broken (0-match) selector, common variations that DO match
//   5. Optional: run the actual extractor and correlate its verdict
//   6. Optional: --fix prints a suggested patch; --apply writes it
//
// Modes:
//   node scripts/diagnose.js sathijob                     # fast: selectors only
//   node scripts/diagnose.js sathijob --full              # also run extractor
//   node scripts/diagnose.js sathijob --url <url>         # override target
//   node scripts/diagnose.js sathijob --json              # machine-readable
//   node scripts/diagnose.js sathijob --fix               # print suggested patch
//   node scripts/diagnose.js sathijob --fix --apply       # write the patch
//   node scripts/diagnose.js --all                        # sweep every source
//
// Never mutates files without --apply AND --fix together. The default run is
// read-only. The tool always exits 0 unless it crashes — drift is a valid
// finding, not a failure.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'src');

const { withPage, closeBrowser } = require(path.join(SRC, 'scrapers', 'browser'));
const { delay } = require(path.join(SRC, 'scrapers', 'page'));
const { detectPageState } = require(path.join(SRC, 'scrapers', 'diagnostics'));

// ---------- ANSI ----------
const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;
const esc = (c) => (supportsColor ? `\x1b[${c}m` : '');
const R = esc('0'), B = esc('1'), D = esc('2');
const RED = esc('31'), GREEN = esc('32'), YELLOW = esc('33'), CYAN = esc('36');

// ---------- args ----------
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const hasFlag = (f) => args.includes(f);
const argValue = (f) => {
    const i = args.indexOf(f);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
};

const ALL_MODE = hasFlag('--all');
const FULL_MODE = hasFlag('--full');
const FIX_MODE = hasFlag('--fix');
const APPLY_MODE = hasFlag('--apply');
const JSON_OUTPUT = hasFlag('--json');
const URL_OVERRIDE = argValue('--url');
const REPORT_OUT = argValue('--report-out');

if (!ALL_MODE && positional.length === 0) {
    console.error('Usage: node scripts/diagnose.js <source> [--full] [--url <url>] [--json] [--fix [--apply]]');
    console.error('       node scripts/diagnose.js --all');
    process.exit(1);
}

// ---------- source discovery ----------
const SOURCE_TYPES = ['events', 'jobs', 'scholarships'];

function findExtractor(name) {
    for (const type of SOURCE_TYPES) {
        const p = path.join(SRC, 'scrapers', 'extractors', type, `${name}.js`);
        if (fs.existsSync(p)) return { type, path: p };
    }
    return null;
}

// ---------- selector extraction ----------
// Heuristic: strings that look like CSS selectors, not prose, not URLs, not
// constant names. Deliberately over-inclusive — false positives are cheap
// (they just show 0 matches and get filtered from the report); misses are
// expensive (we can't suggest a fix for a selector we never tried).
function extractSelectors(src) {
    const found = new Set();
    const re = /['"`]([^'"`\n]{3,200})['"`]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const s = m[1].trim();
        if (!s) continue;
        if (/^https?:\/\//i.test(s)) continue;
        if (s.includes('://')) continue;
        if (/^[A-Z_][A-Z0-9_]+$/.test(s)) continue;
        if (!/^[a-zA-Z.#\[\]]/.test(s)) continue;
        // Must have at least one selector-specific character
        if (!/[.#\[\]>*:]/.test(s)) continue;
        // Reject plain sentences (multiple words + no selector punctuation beyond spaces)
        if (/\s/.test(s) && !/[.#\[\]>*]/.test(s)) continue;
        // Reject strings that look like prose (contains "the", "and", etc. as full words and no . # [ )
        found.add(s);
    }
    return Array.from(found).sort();
}

// ---------- selector variations ----------
// Given a broken selector, produce plausible alternates that catch common
// forms of drift. Only generates alternatives that are strictly more
// permissive in a well-understood way — never invents new classes.
function* variations(selector) {
    // href^= → href*= and href$=
    let m = selector.match(/\[href\^=(["'])([^'"]+)\1\]/);
    if (m) {
        yield selector.replace(`[href^=${m[1]}${m[2]}${m[1]}]`, `[href*=${m[1]}${m[2]}${m[1]}]`);
        yield selector.replace(`[href^=${m[1]}${m[2]}${m[1]}]`, `[href$=${m[1]}${m[2]}${m[1]}]`);
    }
    // href$= → href*=
    m = selector.match(/\[href\$=(["'])([^'"]+)\1\]/);
    if (m) {
        yield selector.replace(`[href$=${m[1]}${m[2]}${m[1]}]`, `[href*=${m[1]}${m[2]}${m[1]}]`);
    }
    // [class="foo"] → [class*="foo"]
    m = selector.match(/\[class=(["'])([^'"]+)\1\]/);
    if (m) {
        yield selector.replace(`[class=${m[1]}${m[2]}${m[1]}]`, `[class*=${m[1]}${m[2]}${m[1]}]`);
    }
    // .a.b → .a (drop last class)
    m = selector.match(/^(.*)\.([\w-]+)$/);
    if (m && m[1]) yield m[1];
    // Strip :pseudo
    const noPseudo = selector.replace(/::?[\w-]+(\([^)]*\))?/g, '');
    if (noPseudo !== selector) yield noPseudo;
    // a.foo > b.bar → a.foo
    if (selector.includes('>')) {
        const head = selector.split('>')[0].trim();
        if (head) yield head;
    }
    // Replace first .exact with [class*="exact"]
    m = selector.match(/\.([\w-]+)/);
    if (m) {
        yield selector.replace(`.${m[1]}`, `[class*="${m[1]}"]`);
    }
}

// ---------- page probe ----------
async function testSelectors(page, selectors) {
    const results = [];
    for (const sel of selectors) {
        const r = { selector: sel, count: 0, sample: null, invalid: false, alternates: [] };
        try {
            const probe = await page.evaluate((s) => {
                try {
                    const els = document.querySelectorAll(s);
                    if (els.length === 0) return { count: 0, sample: null };
                    const first = els[0];
                    return { count: els.length, sample: (first.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100) };
                } catch (e) {
                    return { invalid: true };
                }
            }, sel);
            if (probe.invalid) { r.invalid = true; results.push(r); continue; }
            r.count = probe.count;
            r.sample = probe.sample;
        } catch (e) {
            r.invalid = true;
        }
        results.push(r);
    }
    // Variations for broken (non-invalid, 0-count) selectors
    for (const r of results) {
        if (r.invalid || r.count > 0) continue;
        for (const alt of variations(r.selector)) {
            if (alt === r.selector) continue;
            try {
                const probe = await page.evaluate((s) => {
                    try {
                        const els = document.querySelectorAll(s);
                        if (els.length === 0) return { count: 0 };
                        const first = els[0];
                        return { count: els.length, sample: (first.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100) };
                    } catch (e) {
                        return { count: 0, invalid: true };
                    }
                }, alt);
                if (probe.count > 0) r.alternates.push({ selector: alt, count: probe.count, sample: probe.sample });
            } catch (e) { /* skip */ }
        }
    }
    return results;
}

// ---------- extractor run (optional, --full) ----------
async function runExtractor(name, type) {
    const { loadExtractor } = require(path.join(SRC, 'scrapers', 'extractors'));
    const { ScrapeProgressTracker } = require(path.join(SRC, 'scrapers', 'progress'));
    const { classifyOutcome } = require(path.join(SRC, 'scrapers', 'diagnostics'));

    const { extractor, isStub } = loadExtractor(type, name);
    if (isStub) return { error: 'stub — only .example.js present' };

    const progress = new ScrapeProgressTracker();
    progress.start([name]);
    const meta = { pagesVisited: 0, listingHits: 0, detailPagesVisited: 0, detailParseFailures: 0, looksBlocked: false };
    const start = Date.now();
    try {
        const result = await withPage((page) => extractor.extract(page, { progress, meta }));
        return {
            verdict: classifyOutcome(result),
            itemCount: result.items.length,
            meta,
            durationMs: Date.now() - start
        };
    } catch (e) {
        return { error: e.message, durationMs: Date.now() - start };
    }
}

// ---------- url discovery ----------
function guessUrl(extractorSource) {
    // Strategy 1: template LIST_URL = `${BASE_URL}/path` — most specific,
    // and the shape used by every per-link source (sathijob, internsathi,
    // merojob, kumarijob, katajaam, nepvents). Must be tried BEFORE the
    // BASE_URL fallback or we diagnose the homepage instead of the listing.
    const baseMatch = extractorSource.match(/(?:BASE_URL|ROOT_URL)\s*=\s*['"`]([^'"`\n]+)['"`]/);
    const baseUrl = baseMatch ? baseMatch[1] : null;

    let m = extractorSource.match(/(?:LIST_URL|CATEGORY_URL|_URL)\s*=\s*`\$\{[^}]+\}([^`]+)`/);
    if (m && baseUrl) {
        // Trim a trailing ?/& or bare slash the source adds after BASE_URL
        let suffix = m[1];
        if (suffix.startsWith('?')) suffix = '/' + suffix;
        return `${baseUrl}${suffix}`;
    }

    // Strategy 2: plain literal LIST_URL / CATEGORY_URL — a fully-formed
    // absolute URL, e.g. khalti's KHALTI_EVENTS_URL or scholarshipsads'
    // SCHOLARSHIPSADS_CATEGORIES[0].path.
    m = extractorSource.match(/(?:LIST_URL|CATEGORY_URL|_URL)\s*=\s*['"`](https?:\/\/[^'"`\n]+)['"`]/);
    if (m) return m[1];

    // Strategy 3: array-of-objects literal, e.g. scholarshipsads'
    // SCHOLARSHIPSADS_CATEGORIES = [{ key, label, path: 'https://...' }]
    m = extractorSource.match(/path\s*:\s*['"`](https?:\/\/[^'"`\n]+)['"`]/);
    if (m) return m[1];

    // Strategy 4: bare BASE_URL (homepage) — last resort. Only useful for
    // single-page sources that don't have a separate listing path.
    if (baseUrl) return baseUrl;

    return null;
}

// ---------- diagnose one source ----------
async function diagnoseSource(name) {
    const found = findExtractor(name);
    if (!found) {
        console.log(`${RED}✗ ${name}${R}: extractor not found in any source type`);
        return { name, error: 'extractor_not_found' };
    }
    const { type, path: extPath } = found;
    const extractorSource = fs.readFileSync(extPath, 'utf8');

    const url = URL_OVERRIDE || guessUrl(extractorSource);
    if (!url) {
        console.log(`${RED}✗ ${name}${R}: could not infer target URL from extractor — pass --url`);
        return { name, type, error: 'no_url' };
    }

    const report = { name, type, url, pageState: null, selectors: [], extractor: null, error: null };

    if (!JSON_OUTPUT) {
        console.log('');
        console.log(`${CYAN}▶ Diagnose${R} ${B}${name}${R} ${D}(${type})${R}`);
        console.log(`  target: ${url}`);
        console.log('');
    }

    // Step 1 — page state
    if (!JSON_OUTPUT) console.log(`${B}[1/3]${R} Page state`);
    await withPage(async (page) => {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(2500);
        const state = await detectPageState(page);
        report.pageState = state;

        if (state.looksBlocked) {
            if (!JSON_OUTPUT) {
                console.log(`  ${RED}BLOCKED${R} — Cloudflare / captcha challenge`);
                console.log(`  snippet: ${JSON.stringify((state.bodySnippet || '').slice(0, 160))}`);
            }
            return;
        }
        if (!JSON_OUTPUT) {
            console.log(`  ${GREEN}loaded${R} — no challenge detected`);
            console.log(`  body snippet: ${JSON.stringify((state.bodySnippet || '').slice(0, 120))}`);
        }

        // Step 2 — selector analysis
        const selectors = extractSelectors(extractorSource);
        if (!JSON_OUTPUT) {
            console.log('');
            console.log(`${B}[2/3]${R} Testing ${selectors.length} selector(s) from extractor source`);
        }
        const results = await testSelectors(page, selectors);
        report.selectors = results;

        if (!JSON_OUTPUT) {
            const working = results.filter(r => !r.invalid && r.count > 0);
            const broken = results.filter(r => !r.invalid && r.count === 0);
            const invalid = results.filter(r => r.invalid);

            console.log('');
            console.log(`  ${GREEN}✓ working${R}: ${working.length}`);
            for (const r of working.slice(0, 8)) {
                console.log(`    [${String(r.count).padStart(3)}] ${r.selector}`);
                if (r.sample) console.log(`          ↳ ${D}"${r.sample}"${R}`);
            }
            if (working.length > 8) console.log(`    … +${working.length - 8} more`);

            if (broken.length > 0) {
                console.log('');
                console.log(`  ${RED}✗ broken${R}: ${broken.length}`);
                for (const r of broken) {
                    console.log(`    [  0] ${r.selector}`);
                    for (const alt of r.alternates.slice(0, 3)) {
                        console.log(`          ${GREEN}try:${R} ${alt.selector} → ${alt.count} match${alt.count === 1 ? '' : 'es'}`);
                        if (alt.sample) console.log(`               ↳ ${D}"${alt.sample}"${R}`);
                    }
                    if (r.alternates.length === 0) console.log(`          ${D}(no working alternates found)${R}`);
                }
            }

            if (invalid.length > 0) {
                console.log('');
                console.log(`  ${YELLOW}⚠ invalid${R}: ${invalid.length} (not a valid CSS selector — probably not a selector at all)`);
                for (const r of invalid.slice(0, 5)) console.log(`    ${D}${r.selector}${R}`);
            }
        }
    });

    // Step 3 — extractor run (only with --full)
    if (FULL_MODE && !report.pageState?.looksBlocked) {
        if (!JSON_OUTPUT) {
            console.log('');
            console.log(`${B}[3/3]${R} Running actual extractor (may take minutes for per-link sources)`);
        }
        report.extractor = await runExtractor(name, type);
        if (!JSON_OUTPUT) {
            if (report.extractor.error) {
                console.log(`  ${RED}✗ crashed${R}: ${report.extractor.error}`);
            } else {
                const dur = Math.round((report.extractor.durationMs || 0) / 1000);
                const v = report.extractor.verdict;
                const ok = v.status === 'ok';
                console.log(`  verdict: ${ok ? GREEN : RED}${v.status}${R}  items: ${report.extractor.itemCount}  duration: ${dur}s`);
                if (!ok) {
                    // Correlate with selector results
                    const working = report.selectors.filter(r => !r.invalid && r.count > 0);
                    if (working.length > 0 && report.extractor.itemCount === 0) {
                        console.log(`  ${YELLOW}⚠ selectors work but extractor returns 0${R} — the problem is NOT the selector, it's downstream logic (filter / map / pagination)`);
                    }
                    if (dur > 120 && report.extractor.itemCount === 0) {
                        console.log(`  ${YELLOW}⚠ long runtime with 0 items${R} — the scroll/pagination loop may be spinning without finding anything`);
                    }
                }
            }
        }
    } else if (!JSON_OUTPUT) {
        console.log('');
        console.log(`${D}[3/3] Extractor run skipped (pass --full to include)${R}`);
    }

    // Step 4 — fix suggestion
    if (FIX_MODE) {
        const fixCandidates = [];
        for (const r of report.selectors) {
            if (r.invalid || r.count > 0) continue;
            // Candidate = broken with exactly 1 alternate (unambiguous fix)
            if (r.alternates.length === 1) {
                fixCandidates.push({ from: r.selector, to: r.alternates[0].selector });
            }
        }
        if (!JSON_OUTPUT) {
            console.log('');
            console.log(`${B}--- Fix candidates ---${R}`);
            if (fixCandidates.length === 0) {
                console.log(`  none — no broken selector had exactly one unambiguous alternate`);
            } else {
                for (const f of fixCandidates) {
                    console.log(`  replace: ${D}${f.from}${R} → ${GREEN}${f.to}${R}`);
                }
                if (!APPLY_MODE) {
                    console.log('');
                    console.log(`  ${YELLOW}not applied${R} — pass --apply to write changes`);
                } else {
                    let source = fs.readFileSync(extPath, 'utf8');
                    let applied = 0;
                    for (const f of fixCandidates) {
                        const quotedForms = [`'${f.from}'`, `"${f.from}"`, `\`${f.from}\``];
                        for (const qf of quotedForms) {
                            if (source.includes(qf)) {
                                source = source.replace(qf, qf.replace(f.from, f.to));
                                applied++;
                                break;
                            }
                        }
                    }
                    if (applied > 0) {
                        fs.writeFileSync(extPath, source);
                        console.log(`  ${GREEN}✓ applied ${applied} fix${applied === 1 ? '' : 'es'} to ${path.relative(REPO, extPath)}${R}`);
                        console.log(`  ${D}verify with: node scripts/verify-source.js ${name}${R}`);
                    }
                }
            }
        }
        report.fixCandidates = fixCandidates;
    }

    if (REPORT_OUT) {
        try { fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2)); }
        catch (e) { console.warn(`⚠️ could not write --report-out file: ${e.message}`); }
    }
    if (JSON_OUTPUT) console.log(JSON.stringify(report, null, 2));
    return report;
}

// ---------- entry ----------
(async () => {
    try {
        if (ALL_MODE) {
            const registry = require(path.join(SRC, 'scrapers', 'registry'));
            const all = registry.getAllSources();
            console.log(`${CYAN}▶ Diagnose ALL${R} — ${all.length} source(s)`);
            const results = [];
            for (const s of all) {
                const r = await diagnoseSource(s.name);
                results.push({ name: s.name, type: s.type, verdict: r.extractor?.verdict?.status || null, error: r.error || null });
            }
            await closeBrowser();
            console.log('');
            console.log('========== SUMMARY ==========');
            for (const r of results) {
                const status = r.error ? `${RED}ERROR${R}` : r.verdict === 'ok' ? `${GREEN}ok${R}` : `${YELLOW}${r.verdict || 'not-run'}${R}`;
                console.log(`  ${r.name.padEnd(20)} (${r.type}) — ${status}`);
            }
        } else {
            await diagnoseSource(positional[0]);
            await closeBrowser();
        }
    } catch (e) {
        console.error(`${RED}❌ diagnose failed:${R}`, e.message);
        if (e.stack) console.error(e.stack);
        try { await closeBrowser(); } catch (_) { /* ignore */ }
        process.exit(1);
    }
})();
