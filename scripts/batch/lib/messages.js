// scripts/batch/lib/messages.js
// Central human-readable messages for every code that appears anywhere in
// the batch pipeline. Codes like `dom_drift_unknown_shape` or
// `low_precision` are concise for logs and machine decisions but useless
// to a human reading the terminal or report.
//
// Every code that appears in user-facing output has an entry here:
//   {
//     label:       short human name (2-5 words, no jargon)
//     explanation: what it actually means (1-2 sentences, assumes zero
//                  knowledge of the codebase)
//     fix:         what the user should do next, in copy-pasteable form,
//                  or null if no action is possible
//     severity:    'pass' | 'warn' | 'fail' | 'info'
//   }
//
// Consumers:
//   verify per-site compact line: messages.label(reason)
//   verify failure list:          messages.label + messages.fix
//   report row:                   messages.label + messages.explanation
//   report verbose / detailed:    all four fields
//
// Fallback: unknown codes return { label: code, explanation:
// 'no documentation for this code', severity: 'warn' }. Adding a new code
// to the pipeline without adding an entry here means users see the raw
// code -- an acceptable debug fallback, not acceptable as a shipping state.
//
// Never duplicate message text outside this file. If the same explanation
// needs to appear in two phases, both call messages.render(). This file
// is the single source of truth for "how to explain X to a human".

// Severity -> display tag kind. Pass/warn/fail map to ui.tag categories.
// Info isn't rendered with a tag (informational only).

const MESSAGES = {
    // ============ PASSING STATES ============
    'ok': {
        label: 'Working',
        explanation: 'The extractor ran cleanly and returned job postings. Everything is behaving as designed.',
        fix: null,
        severity: 'pass'
    },
    'empty-ats': {
        label: 'No jobs right now',
        explanation: 'The site uses a recognized job-board service, and the service currently reports zero open positions. This is normal -- companies open and close roles all the time.',
        fix: null,
        severity: 'pass'
    },
    'empty-wizard': {
        label: 'No jobs right now',
        explanation: 'The extractor ran, found no job cards, and reported no errors. The discovery snapshot also saw no job-shaped content on the page, so this most likely means the company has no open roles at the moment. Nothing is broken.',
        fix: 'If you believe the company is hiring, visit the page manually and confirm. Otherwise no action is needed.',
        severity: 'pass'
    },
    'empty': {
        label: 'No items returned',
        explanation: 'The extractor completed without errors and returned zero items. Depending on the site this means either "no current postings" or "the page is empty of the content we expected".',
        fix: null,
        severity: 'pass'
    },

    // ============ PAGE STRUCTURE / EXTRACTION ISSUES ============
    'low_precision': {
        label: 'Mostly non-job content',
        explanation: 'The extractor found several cards on the page and pulled text from them, but the batch title-filter decided most were marketing copy, culture blurbs, or product names rather than job titles. It returned a few "jobs" but they look wrong.',
        fix: 'Run `pulchowk-events batch refine --only <site>` to have the LLM take another pass with the failure details in front of it.',
        severity: 'fail'
    },
    'dom_drift_listing': {
        label: 'Could not find the job listing',
        explanation: 'The page loaded fine, but the extractor\'s CSS selectors matched zero elements. The site probably restructured its HTML, or the extractor was written against a page shape that no longer exists.',
        fix: 'Run `pulchowk-events batch refine --only <site>` to retry with the failure log visible to the LLM.',
        severity: 'fail'
    },
    'dom_drift_detail': {
        label: 'Job details would not parse',
        explanation: 'The extractor found the listing page fine, but when it visited individual job pages it could not extract the title or details from any of them. The detail-page structure has probably changed.',
        fix: 'Run `pulchowk-events batch refine --only <site>` to retry with the failure log visible to the LLM.',
        severity: 'fail'
    },
    'dom_drift_unknown_shape': {
        label: 'Page layout not recognized',
        explanation: 'When discovery first visited this page, it could not confidently identify a list of job postings -- the page looked like something else (a homepage, marketing page, or a JavaScript-only shell). The extractor was written against this uncertain evidence, so its zero-result outcome is expected until we have better page evidence.',
        fix: 'Run `pulchowk-events batch refine --only <site>` to retry, or open the site manually to confirm the correct careers URL.',
        severity: 'fail'
    },
    'dom_drift_spa_needs_js': {
        label: 'JavaScript-rendered content',
        explanation: 'The job listings on this site are rendered by client-side JavaScript. The extractor was probably written assuming the HTML would already contain the job cards, so it found nothing on the initial server response.',
        fix: 'Run `pulchowk-events batch refine --only <site>`. The refined prompt tells the LLM to add a `waitForSelector` call so it waits for the JS to finish rendering.',
        severity: 'fail'
    },
    'empty-wizard-suspicious': {
        label: 'Likely a selector miss',
        explanation: 'The page seems to have job anchors or job-postings metadata, but the extractor returned zero items. That contradiction usually means the extractor\'s selector is looking in the wrong place.',
        fix: 'Run `pulchowk-events batch refine --only <site>` or `pulchowk-events diagnose <site>` for selector-level detail.',
        severity: 'fail'
    },

    // ============ EXTRACTOR BROKEN ============
    'parse_failed': {
        label: 'Extractor crashed',
        explanation: 'The extractor threw an exception while running. This is a real code bug in the extractor -- not a site change. The exception is logged in the per-site result file (results/<site>.json).',
        fix: 'Run `pulchowk-events batch refine --only <site>`. The refined prompt includes the crash log so the LLM can write a correct version.',
        severity: 'fail'
    },
    'not_implemented': {
        label: 'Extractor not filled in',
        explanation: 'The source wrapper exists, but the extractor module is still a placeholder stub that throws "not implemented" when it runs. This happens when generate wrote a stub and paste was not run.',
        fix: 'Run `pulchowk-events batch paste --only <site>` to fill in the extractor.',
        severity: 'fail'
    },
    'load_failed': {
        label: 'Extractor would not load',
        explanation: 'Node could not load the extractor file. Usually a syntax error -- e.g. a stray VERDICT line left in the file, or unbalanced braces from a bad LLM reply.',
        fix: 'Delete generated/<site>.js and run `pulchowk-events batch paste --only <site>` again.',
        severity: 'fail'
    },
    'stage_failed': {
        label: 'Could not stage files',
        explanation: 'The verify step could not copy the generated extractor into the src/scrapers/ directory. Usually a filesystem permission issue or a leftover .batchbak orphan.',
        fix: 'Run `find src/scrapers -name "*.batchbak"` and delete any orphans, then retry verify.',
        severity: 'fail'
    },

    // ============ NETWORK / EXTERNAL ============
    'blocked': {
        label: 'Site blocking automated access',
        explanation: 'The site served a captcha or Cloudflare challenge instead of the actual content. This is not a code bug -- it is the site defending itself against scraping.',
        fix: 'Run on the Windows host with BROWSER_EXECUTABLE_PATH and BROWSER_USER_DATA_DIR pointing at a warm browser profile that has solved the challenge once.',
        severity: 'fail'
    },
    'timeout': {
        label: 'Took too long',
        explanation: 'The extractor did not finish within the per-site timeout. This usually means the site is slow, the extractor is doing too many page loads, or the extractor is stuck in a loop.',
        fix: 'Run `pulchowk-events batch refine --only <site>`. The refined prompt shows the LLM the timeout so it can reduce the amount of per-page work.',
        severity: 'warn'
    },

    // ============ URL / RESOLUTION ISSUES (from discover) ============
    'rejected': {
        label: 'Not a careers page',
        explanation: 'During discovery, this URL was rejected before any extractor was built. The reason is in the resolution field -- usually a homepage with no visible careers section, a marketing page, an empty response, or a broken URL.',
        fix: 'Check the resolution reason in the batch report. If the site is a real careers page, put the correct URL in urls.txt and re-run discover.',
        severity: 'fail'
    },
    'fetch-failed': {
        label: 'Could not fetch the URL',
        explanation: 'The discovery step could not even download the page. The server returned an error, or the request timed out, or the connection was reset. Nothing about the site\'s content was seen.',
        fix: 'Verify the URL is correct (paste it into a browser). If it loads for you but not the bot, the site may be blocking known scrapers.',
        severity: 'fail'
    },
    'homepage-no-careers': {
        label: 'Homepage with no careers link',
        explanation: 'The URL points at a marketing or company homepage that has no visible link to a careers page. Either this company does not have a public careers page, or the URL is wrong.',
        fix: 'Find the correct careers URL manually and put it in urls.txt, or remove this site.',
        severity: 'fail'
    },
    'homepage-with-careers': {
        label: 'Homepage, careers link found but not followed',
        explanation: 'The URL points at a homepage that has a careers link, but following that link (up to two hops) did not produce a real listing page.',
        fix: 'Open the careers link manually. If the sub-page is a real listing, put that URL in urls.txt and re-discover.',
        severity: 'fail'
    },
    'follow-depth-exceeded': {
        label: 'Too many redirect hops',
        explanation: 'The LLM\'s verdict suggested following a new URL, but the batch already followed the maximum number of hops and did not arrive at a real listing.',
        fix: 'Open the last suggested URL manually. If it is the real careers page, put it directly in urls.txt.',
        severity: 'fail'
    },
    'spa-shell': {
        label: 'JavaScript-only page',
        explanation: 'The page returned almost no visible content in the raw HTML -- everything is loaded by client-side JavaScript. Not a bug, just means the extractor must wait for the JS to render.',
        fix: null,
        severity: 'info'
    },
    'error': {
        label: 'HTTP error',
        explanation: 'The server responded with an HTTP error status (4xx or 5xx), or the page content looked like an error page. The page does not exist or the site is refusing to serve it.',
        fix: 'Check the URL in a browser. If the URL is wrong, fix it in urls.txt.',
        severity: 'fail'
    },
    'fetch-empty': {
        label: 'Empty response',
        explanation: 'The server returned a response with zero (or almost zero) bytes. Some sites do this for bots -- they return success but no content. Others are genuinely empty.',
        fix: 'Check the URL in a browser. If it loads for you, the site may be blocking automated fetches.',
        severity: 'fail'
    },
    'unknown': {
        label: 'Page type unclear',
        explanation: 'Discovery could not confidently classify the page. It was handed to the extractor with a "needs review" flag -- the extractor may or may not work depending on what is actually on the page.',
        fix: null,
        severity: 'info'
    },
    'listing': {
        label: 'Job listing page',
        explanation: 'Discovery confidently identified this as a page with job postings. Extractor should work cleanly.',
        fix: null,
        severity: 'info'
    },

    // ============ LLM VERDICT BUCKETS ============
    'LLM-NOT-CAREERS': {
        label: 'LLM says not a careers page',
        explanation: 'When the LLM read the page evidence, it concluded this URL is not a jobs listing page -- it is a homepage, marketing page, or a page with no visible job postings. It declined to write an extractor and suggested fixing the URL.',
        fix: 'Read the reason in the report. Either find the correct careers URL and put it in urls.txt, or remove this site from the batch.',
        severity: 'warn'
    },
    'LLM-REDIRECT': {
        label: 'LLM found careers page elsewhere',
        explanation: 'The LLM identified that this URL is not the careers listing, but told us where the real listing lives on the same site. The batch is waiting to follow that suggestion.',
        fix: 'Run `pulchowk-events batch follow --run <run-id>` to jump to the suggested URL.',
        severity: 'warn'
    },

    // ============ PIPELINE STATES ============
    'NOT-GENERATED': {
        label: 'Extractor not written yet',
        explanation: 'A prompt is ready for this site, but nobody has pasted the LLM\'s reply back into the batch. The extractor does not exist yet.',
        fix: 'Run `pulchowk-events batch paste --run <run-id>`.',
        severity: 'info'
    },
    'SKIP-FETCH': {
        label: 'Skipped -- discovery failed',
        explanation: 'Discovery could not fetch this URL at all, so no extractor will be attempted for it.',
        fix: 'Verify the URL in a browser. If it loads for you but not the bot, the site may be blocking scrapers.',
        severity: 'info'
    },

    // ============ REPORT BUCKETS (map to underlying reasons above) ============
    'REJECT-URL': {
        label: 'URL rejected',
        explanation: 'Discovery rejected this URL before any extractor work began (not a listing page, HTTP error, empty response, or similar). See the specific reason in the row.',
        fix: 'Fix the URL in urls.txt or remove the site.',
        severity: 'fail'
    },
    'REJECT-BLOCKED': {
        label: 'Blocked by site',
        explanation: 'The site blocked automated access (captcha, Cloudflare challenge). No code fix is possible without a warm browser profile.',
        fix: 'Run on the Windows host with a warm browser profile configured.',
        severity: 'fail'
    },
    'FAIL-DRIFT': {
        label: 'Extraction broken',
        explanation: 'The extractor ran cleanly but found no items. Same class as "Could not find the job listing".',
        fix: 'Run `pulchowk-events batch refine --only <site>`.',
        severity: 'fail'
    },
    'FAIL-DRIFT-SPA': {
        label: 'Needs JavaScript rendering',
        explanation: 'The page loads its job listings via JavaScript. Extractor must wait for the JS to finish.',
        fix: 'Run `pulchowk-events batch refine --only <site>`.',
        severity: 'fail'
    },
    'FAIL-DRIFT-UNKWN': {
        label: 'Page layout not recognized',
        explanation: 'Same as dom_drift_unknown_shape -- discovery could not confidently identify a listing page.',
        fix: 'Run `pulchowk-events batch refine --only <site>` or open the site to confirm the URL.',
        severity: 'fail'
    },
    'FAIL-EMPTY-SUSP': {
        label: 'Likely a selector miss',
        explanation: 'Page evidence suggests jobs exist, but extractor returned zero. Contradiction implies a selector bug.',
        fix: 'Run `pulchowk-events batch refine --only <site>`.',
        severity: 'fail'
    },
    'FAIL-LOW-PREC': {
        label: 'Mostly non-job content',
        explanation: 'Extractor kept only a few items and they look like marketing copy, not real job titles.',
        fix: 'Run `pulchowk-events batch refine --only <site>`.',
        severity: 'fail'
    },
    'FAIL-PARSE': {
        label: 'Extractor crashed',
        explanation: 'Extractor threw an exception. Bug in the extractor, not the site.',
        fix: 'Run `pulchowk-events batch refine --only <site>`.',
        severity: 'fail'
    },
    'FAIL-TIMEOUT': {
        label: 'Extractor timed out',
        explanation: 'Extractor ran past the per-site timeout. Often means the site is slow or the extractor is doing too much per-page work.',
        fix: 'Run `pulchowk-events batch refine --only <site>` or increase verify timeout.',
        severity: 'warn'
    },
    'FAIL-OTHER': {
        label: 'Unclassified failure',
        explanation: 'Verify reported a failure that does not match a known category. Check the per-site result file for details.',
        fix: 'Read results/<site>.json for the raw stderr.',
        severity: 'fail'
    },
    'NOT-IMPL': {
        label: 'Extractor not implemented',
        explanation: 'Extractor module is a stub that throws when run. Paste did not fill it in.',
        fix: 'Run `pulchowk-events batch paste --only <site>`.',
        severity: 'fail'
    },

    // ============ WARNING-LEVEL VERDICTS ============
    'warn': {
        label: 'Warning',
        explanation: 'The pipeline completed but flagged something that may need attention.',
        fix: null,
        severity: 'warn'
    }
};

// Fallback for codes with no entry. Renders the code verbatim so a user
// at least sees *what* failed and can grep for it. Better than an empty
// string; worse than a proper entry.
function fallback(code) {
    return {
        label: String(code || 'unknown'),
        explanation: 'No detailed explanation for this code yet. The code itself is shown so it can be looked up.',
        fix: null,
        severity: 'warn'
    };
}

// Main lookup. Returns the full structured entry.
function lookup(code) {
    if (!code) return fallback(code);
    return MESSAGES[code] || fallback(code);
}

// Convenience accessors.
function label(code) { return lookup(code).label; }
function explanation(code) { return lookup(code).explanation; }
function fix(code) { return lookup(code).fix; }
function severity(code) { return lookup(code).severity; }

// Multi-line render for detailed contexts (report verbose, verify failure
// list). Options:
//   { indent: 4 }     leading spaces per line
//   { includeFix: true }  include the "fix:" line
//   { includeExplanation: true } include the explanation paragraph
//   { prefix: '' }    optional prefix on first line (e.g. site name)
//
// Output is a single string with newlines. Callers split and print each
// line through their own line printer for consistent styling.
function render(code, { indent = 4, includeFix = true, includeExplanation = true, prefix = '' } = {}) {
    const m = lookup(code);
    const pad = ' '.repeat(indent);
    const lines = [];
    const head = prefix ? `${prefix} ${m.label}` : m.label;
    lines.push(head);
    if (includeExplanation && m.explanation) {
        // Wrap explanation at ~70 chars for readability.
        const words = m.explanation.split(/\s+/);
        let cur = '';
        for (const w of words) {
            if ((cur + ' ' + w).trim().length > 70) {
                lines.push(pad + cur);
                cur = w;
            } else {
                cur = (cur ? cur + ' ' : '') + w;
            }
        }
        if (cur) lines.push(pad + cur);
    }
    if (includeFix && m.fix) {
        lines.push(pad + 'Next step: ' + m.fix);
    }
    return lines.join('\n');
}

module.exports = {
    MESSAGES,
    lookup,
    label,
    explanation,
    fix,
    severity,
    render,
    fallback
};
