// scripts/batch/lib/llm-header.js
// Parse the LLM extractor's top comment for a VERDICT line. Every wizard
// prompt now asks the LLM to declare what it found before writing code,
// so the batch can react when the entry URL isn't actually a careers page.
//
// Three verdict types:
//
//   CAREERS_PAGE                    -- proceed to verify
//   NOT_CAREERS_PAGE -- <reason>    -- skip verify, mark bucket LLM-NOT-CAREERS
//   CAREERS_PAGE_REDIRECT -- <url>  -- paste.js follows the URL (bounded,
//                                      domain-checked), re-dumps, re-prompts,
//                                      loops until CAREERS_PAGE or depth limit
//
// Backward-compat: no verdict line at all (old prompts, LLM ignored the
// instruction) behaves exactly like CAREERS_PAGE. Zero regression for
// existing extractors.
//
// Pure function. No I/O. Unit-testable against canned sources.

const KNOWN_TYPES = new Set([
    'CAREERS_PAGE',
    'NOT_CAREERS_PAGE',
    'CAREERS_PAGE_REDIRECT'
]);

// Only search the first ~5KB. The verdict belongs in the top comment
// block; if it's buried in code the LLM didn't follow the format, and a
// random string deep in a regex would be misread as a verdict.
const SEARCH_WINDOW_BYTES = 5000;

// Match "VERDICT: TYPE" optionally followed by " — evidence" or " - evidence".
const VERDICT_RE = /VERDICT\s*:\s*([A-Z_]+)(?:\s*[—–-]+\s*([^\n\r]+))?/i;

// Bare URL inside the evidence string (redirect target).
const URL_IN_EVIDENCE_RE = /(https?:\/\/[^\s)\]>'"`]+)/i;

/**
 * Parse the verdict from an extractor source string.
 *
 * @returns {{
 *   type: string,                 // KNOWN_TYPES member or 'UNSPECIFIED'
 *   known: boolean,
 *   evidence: string|null,
 *   suggestedUrl: string|null,    // absolute URL for REDIRECT verdicts
 *   raw: string|null
 * }}
 */
function parseVerdict(jsSource) {
    const out = { type: 'UNSPECIFIED', known: false, evidence: null, suggestedUrl: null, raw: null };
    if (typeof jsSource !== 'string' || jsSource.length === 0) return out;

    const head = jsSource.slice(0, SEARCH_WINDOW_BYTES);
    const m = head.match(VERDICT_RE);
    if (!m) return out;

    const type = m[1].toUpperCase();
    const evidence = m[2] ? m[2].trim().slice(0, 500) : null;

    out.type = KNOWN_TYPES.has(type) ? type : 'UNSPECIFIED';
    out.known = KNOWN_TYPES.has(type);
    out.evidence = evidence;
    out.raw = m[0].slice(0, 500);

    if (out.type === 'CAREERS_PAGE_REDIRECT' && evidence) {
        const urlMatch = evidence.match(URL_IN_EVIDENCE_RE);
        if (urlMatch) out.suggestedUrl = urlMatch[1];
    }
    return out;
}

/**
 * Domain safety check: redirect is allowed only if it stays within the
 * original site's registrable domain. Prevents the LLM from suggesting
 * a redirect to a competitor or an unrelated site. Subdomains are OK
 * (careers.daraz.com redirects to daraz.com/careers -- same registrable
 * domain). Protocol must be https or http.
 *
 * @param {string} originalUrl  The site's requested/target URL
 * @param {string} redirectUrl  The LLM's suggested URL
 * @returns {boolean}
 */
function isSameDomainRedirect(originalUrl, redirectUrl) {
    try {
        const a = new URL(originalUrl);
        const b = new URL(redirectUrl);
        if (b.protocol !== 'http:' && b.protocol !== 'https:') return false;

        // Strip leading "www." for comparison -- www.foo.com === foo.com.
        const strip = (host) => host.replace(/^www\./i, '').toLowerCase();

        // Registrable domain heuristic: last two labels. Doesn't handle
        // multi-part TLDs (co.uk, com.np) precisely but is close enough --
        // a redirect from foo.co.uk to bar.co.uk would be caught since
        // both strip to "co.uk", which is too permissive... so instead:
        // compare the FULL hostname OR the last-2-label suffix.
        const hostA = strip(a.hostname);
        const hostB = strip(b.hostname);
        if (hostA === hostB) return true;
        if (hostB.endsWith('.' + hostA)) return true;   // subdomain of original
        if (hostA.endsWith('.' + hostB)) return true;   // original is subdomain of redirect

        // Last resort: last-2-labels match. Catches foo.com -> careers.foo.com
        // and foo.com -> foo.co.uk (rare but not impossible). Tighter than
        // "any URL the LLM says", looser than exact hostname.
        const last2 = (h) => h.split('.').slice(-2).join('.');
        if (last2(hostA) === last2(hostB) && last2(hostA).includes('.')) return true;

        return false;
    } catch (e) {
        return false;
    }
}

/**
 * Should verify skip this site entirely? True for NOT_CAREERS_PAGE and
 * CAREERS_PAGE_REDIRECT verdicts that ran out of retry budget or were
 * rejected for domain safety. False for CAREERS_PAGE and UNSPECIFIED.
 */
function shouldSkipVerify(verdict) {
    if (!verdict || !verdict.known) return false;
    return verdict.type === 'NOT_CAREERS_PAGE' || verdict.type === 'CAREERS_PAGE_REDIRECT';
}

/**
 * Human-readable bucket name for the report. Null for verdicts that
 * don't produce a skip (CAREERS_PAGE, UNSPECIFIED, or unknown types).
 */
function verdictBucket(verdict) {
    if (!verdict || !verdict.known) return null;
    if (verdict.type === 'NOT_CAREERS_PAGE') return 'LLM-NOT-CAREERS';
    if (verdict.type === 'CAREERS_PAGE_REDIRECT') return 'LLM-REDIRECT';
    return null;
}

module.exports = {
    parseVerdict,
    isSameDomainRedirect,
    shouldSkipVerify,
    verdictBucket,
    KNOWN_TYPES
};
