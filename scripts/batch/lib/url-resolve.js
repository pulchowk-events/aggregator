// scripts/batch/lib/url-resolve.js
// Uses preflight.analyzePage to decide what URL the batch should actually
// point an extractor at, following career-page links from homepages when
// necessary.
//
// This is the gate that prevents silent errors of the "wizard built an
// extractor for a homepage" kind. Every URL in urls.txt flows through here
// before it reaches the wizard or the ATS template.
//
// Resolution model:
//
//   listing              -> use as-is. name derived from the listing URL.
//   homepage-with-careers -> follow the top urlCandidate (highest confidence
//                            >= 0.7); re-preflight that page. Depth limit 2.
//                            Final target is the deeper page.
//   homepage-no-careers  -> reject. Record reason. No LLM paste wasted.
//   spa-shell            -> accept as target, flag needs-browser. Wizard
//                            can still work (Puppeteer renders JS), just
//                            won't be fast.
//   blocked              -> reject. Nothing to build until profile configured.
//   error                -> reject. HTTP failure or error-page-200.
//   fetch-empty          -> reject. Empty body, no content to scrape.
//   unknown              -> accept as target, flag needs-review. Caller can
//                            decide to send to LLM-fallback or skip.
//
// Resolution is deterministic per (url, html) -- no network here. Network
// fetches are done by the caller (discover.js) which passes fresh
// { html, finalUrl, httpStatus } into each preflight. This function may ask
// the caller to fetch a follow-up URL via a returned instruction rather
// than fetching internally, so this file stays pure.

const { analyzePage } = require('./preflight');

const MAX_FOLLOW_DEPTH = 2;
const MIN_FOLLOW_CONFIDENCE = 0.7;

// Decide what to do with the current page, given its preflight analysis
// and the chain of URLs already followed.
//
// Returns one of:
//   { action: 'accept', url, pageShape, reasoning, preflight, chain }
//   { action: 'follow', url, pageShape, reasoning, preflight, chain }  // caller fetches url, re-calls resolve
//   { action: 'reject', pageShape, reasoning, preflight, chain }
//
// `chain` is the ordered list of URLs visited to reach this decision.
// Caller appends the follow target when action==='follow'.
function decideStep({ requestedUrl, finalUrl, httpStatus, html, bytes, contentType, chain }) {
    const pf = analyzePage({ requestedUrl, finalUrl, httpStatus, html, bytes, contentType });
    const chainOut = (chain || []).concat([requestedUrl]);

    switch (pf.pageShape) {
        case 'listing':
            return { action: 'accept', url: finalUrl || requestedUrl, pageShape: 'listing', reasoning: pf.reasoning, preflight: pf, chain: chainOut };

        case 'homepage-with-careers': {
            if (chainOut.length >= MAX_FOLLOW_DEPTH) {
                return {
                    action: 'reject',
                    pageShape: 'homepage-with-careers',
                    reasoning: `follow depth limit (${MAX_FOLLOW_DEPTH}) reached; this page has ${pf.urlCandidates.length} candidate link(s) but following them did not produce a listing`,
                    preflight: pf,
                    chain: chainOut
                };
            }
            const candidates = pf.urlCandidates || [];
            // Rule: high-confidence candidate always wins. A single
            // low-confidence candidate still gets followed -- it's better to
            // try and fail at verify than reject a working site. Only when
            // multiple low-confidence candidates exist do we decline, because
            // picking one at random has ~50% odds of being wrong.
            let best = candidates.find((c) => c.confidence >= MIN_FOLLOW_CONFIDENCE);
            if (!best && candidates.length === 1 && candidates[0].confidence >= 0.5) {
                best = candidates[0];
            }
            if (!best) {
                return {
                    action: 'reject',
                    pageShape: 'homepage-with-careers',
                    reasoning: `no confident career link (${candidates.length} candidate(s): ${candidates.map((c) => c.confidence.toFixed(2)).join(', ') || 'none'})`,
                    preflight: pf,
                    chain: chainOut
                };
            }
            return { action: 'follow', url: best.href, pageShape: 'homepage-with-careers', reasoning: `following candidate "${best.text}" (conf ${best.confidence.toFixed(2)}) -> ${best.href}`, preflight: pf, chain: chainOut };
        }

        case 'homepage-no-careers':
            return {
                action: 'reject',
                pageShape: 'homepage-no-careers',
                reasoning: pf.reasoning + ' -- check urls.txt: this looks like a marketing page, not a careers listing',
                preflight: pf,
                chain: chainOut
            };

        case 'spa-shell':
            // Accept -- the wizard uses Puppeteer, which renders JS. But
            // flag that the eventual extractor must handle client-side
            // rendering. Only reject if it's also the follow depth limit.
            return {
                action: 'accept',
                url: finalUrl || requestedUrl,
                pageShape: 'spa-shell',
                reasoning: pf.reasoning + ' -- wizard will need Puppeteer to render; extractor must not rely on initial HTML',
                preflight: pf,
                chain: chainOut
            };

        case 'blocked':
            return {
                action: 'reject',
                pageShape: 'blocked',
                reasoning: pf.reasoning + ' -- set BROWSER_EXECUTABLE_PATH + BROWSER_USER_DATA_DIR and run on Windows with warm profile',
                preflight: pf,
                chain: chainOut
            };

        case 'error':
            return {
                action: 'reject',
                pageShape: 'error',
                reasoning: pf.reasoning,
                preflight: pf,
                chain: chainOut
            };

        case 'fetch-empty':
            return {
                action: 'reject',
                pageShape: 'fetch-empty',
                reasoning: pf.reasoning,
                preflight: pf,
                chain: chainOut
            };

        case 'unknown':
        default:
            return {
                action: 'accept',
                url: finalUrl || requestedUrl,
                pageShape: 'unknown',
                reasoning: pf.reasoning + ' -- handed to wizard with needs-review flag',
                preflight: pf,
                chain: chainOut
            };
    }
}

// Convenience: given a chain of (url, html, httpStatus) tuples, walk the
// decision tree until accept/reject. Caller is responsible for fetching
// each `url` the helper asks for. This is the function discover.js calls.
//
// Signature:
//   await resolveWithFetcher(initialUrl, async (url) => ({ finalUrl, httpStatus, html, bytes, contentType }))
//
// Returns the last decideStep() result, with `.chain` listing every URL
// visited and `.followedUrls` listing only the ones actually fetched.
async function resolveWithFetcher(initialUrl, fetchFn) {
    let currentUrl = initialUrl;
    let chain = [];
    const followedUrls = [];

    for (let depth = 0; depth <= MAX_FOLLOW_DEPTH; depth++) {
        followedUrls.push(currentUrl);
        const fetched = await fetchFn(currentUrl);
        const step = decideStep({
            requestedUrl: currentUrl,
            finalUrl: fetched.finalUrl,
            httpStatus: fetched.httpStatus,
            html: fetched.html,
            bytes: fetched.bytes,
            contentType: fetched.contentType,
            chain
        });
        chain = step.chain;
        if (step.action !== 'follow') {
            return { ...step, followedUrls };
        }
        currentUrl = step.url;
    }

    // Only reachable if MAX_FOLLOW_DEPTH was misconfigured above.
    return {
        action: 'reject',
        pageShape: 'follow-depth-exceeded',
        reasoning: `hit MAX_FOLLOW_DEPTH=${MAX_FOLLOW_DEPTH} without a decision`,
        preflight: null,
        chain,
        followedUrls
    };
}

module.exports = {
    decideStep,
    resolveWithFetcher,
    MAX_FOLLOW_DEPTH,
    MIN_FOLLOW_CONFIDENCE
};
