// scripts/batch/lib/preflight.js
// Pure analysis of a fetched page. Answers the question: what KIND of page
// is this, and does it make sense to point an extractor at it?
//
// Replaces the silent assumption "every URL in urls.txt is a listing page".
// That assumption is wrong for homepages, for URL-typos, for SPA shells,
// for error pages served with HTTP 200, and for empty bodies. Each of those
// used to reach the LLM, produce a plausible-looking extractor, then fail
// at verify with the generic verdict `dom_drift_listing` -- indistinguishable
// from "the site changed and the selector drifted". Preflight separates
// these before any LLM tokens are spent.
//
// Output shape:
//   {
//     pageShape: 'listing' | 'homepage-with-careers' | 'homepage-no-careers'
//              | 'spa-shell' | 'blocked' | 'error' | 'fetch-empty' | 'unknown',
//     confidence: 0..1,
//     reasoning: 'one-line explanation',
//     redirected: bool,
//     finalUrl: <after HTTP redirects>,
//     urlCandidates: [ { href, text, confidence } ],  // career-page links
//     signals: {
//       httpStatus, bytes, bodyTextLength,
//       jobAnchors, jobCards, jsonLdJobPostings,
//       hasNextData, hasNuxt, framework,
//       looksBlocked, looksLikeErrorPage, careersMentioned
//     }
//   }
//
// Pure: no network, no filesystem, no LLM. Inputs only.

// Anchor hrefs that strongly suggest "this is a job listing item".
// Order matters only for reporting; any hit counts.
const JOB_ANCHOR_PATTERNS = [
    /\/jobs?\/[^\/?#]+/i,          // /job/some-slug, /jobs/some-slug
    /\/positions?\/[^\/?#]+/i,
    /\/vacanc(?:y|ies)\/[^\/?#]+/i,
    /\/openings?\/[^\/?#]+/i,
    /\/careers?\/[^\/?#]+/i,       // /career/some-slug (but NOT bare /careers)
    /\/roles?\/[^\/?#]+/i,
    /\/apply\/[^\/?#]+/i,
    /\/hiring\/[^\/?#]+/i
];

// Class names that suggest a job-card-ish container.
const JOB_CARD_CLASS_PATTERNS = [
    /job[-_]?(?:card|item|listing|post|opening|position|role)/i,
    /position[-_]?(?:card|item|listing)/i,
    /vacancy[-_]?(?:card|item|listing)/i,
    /opening[-_]?(?:card|item|listing)/i,
    /career[-_]?(?:card|item|listing|opening|job)/i,
    /role[-_]?(?:card|item)/i
];

// Link text that strongly suggests "careers page" when found on another page.
// Matched against the anchor's trimmed text content.
const CAREERS_LINK_TEXT_PATTERNS = [
    /^careers?$/i,
    /^jobs?$/i,
    /^job openings?$/i,
    /^open (?:roles?|positions?)$/i,
    /^current openings?$/i,
    /^career opportunities$/i,
    /^work with us$/i,
    /^join (?:us|our team|the team)$/i,
    /^we[''']?re hiring$/i,
    /^openings$/i
];

// Link href that suggests "careers page" when found on another page.
// The difference from JOB_ANCHOR_PATTERNS: these match bare /careers OR
// /careers/, because we're looking for the SECTION page, not an item.
const CAREERS_LINK_HREF_PATTERNS = [
    /\/(?:careers?|jobs?|openings?|vacanc(?:y|ies)|positions?|hiring|join-us|work-with-us)\/?(?:$|[?#])/i
];

// Framework / build-tool markers. Presence alone is not conclusive --
// a marketing page built with Next.js has __NEXT_DATA__ too. Combined with
// very-short body text, it's the SPA-shell signal.
const FRAMEWORK_MARKERS = [
    { name: 'next',      re: /__NEXT_DATA__/ },
    { name: 'nuxt',      re: /__NUXT__/ },
    { name: 'wordpress', re: /wp-content|wp-includes/i },
    { name: 'elementor', re: /elementor-widget/i },
    { name: 'react',     re: /<div[^>]+id=["']root["'][^>]*><\/div>/ }
];

// Block detection is split into three tiers because block markers appear
// on legitimate pages as often as on challenge pages:
//
//   - TITLE_MARKERS: exact title strings only appear on challenge pages.
//     A marketing page with a <noscript> warning that says "Please enable
//     JavaScript" doesn't have the TITLE "Just a moment...". Trust these.
//
//   - HTML_TOKENS: strings that ONLY appear when Cloudflare is actively
//     serving a challenge (challenge-platform, cf-chl-opt, /cdn-cgi/challenge).
//     These are safe even at the raw-HTML level because they're specific to
//     the challenge endpoint, not to any Cloudflare-referencing script.
//
//   - SOFT_MARKERS: strings that MIGHT indicate blocking but also appear in
//     boilerplate (noscript warnings, "access denied" in body text). Only
//     fire when body text is unusually short (a real challenge page has
//     almost no content). The 1500-char threshold is empirical: challenge
//     pages we've seen are 200-800 chars of body text; real pages are 3000+.
//
// A page is 'blocked' when any of these fire under their gating conditions.
const BLOCK_TITLE_MARKERS = [
    /^\s*just a moment\.\.\.\s*$/i,
    /^\s*attention required!?\s*(?:\|\s*cloudflare)?\s*$/i,
    /^\s*access denied\s*$/i,
    /^\s*checking your browser before accessing/i
];

const BLOCK_HTML_TOKENS = [
    /\/cdn-cgi\/challenge-platform/i,
    /cf[-_]chl[-_]opt/i,
    /__cf_chl_/i
];

const BLOCK_SOFT_MARKERS = [
    /please enable (?:cookies|javascript).*to continue/i,
    /checking your browser/i,
    /verify you are (?:a )?human/i
];

const BLOCK_SHORT_BODY_THRESHOLD = 1500;

// Signals that the served page is really an error page with HTTP 200.
const ERROR_PAGE_MARKERS = [
    /<title>[^<]*(?:404|not found|error|oops)[^<]*<\/title>/i,
    /page (?:not found|does not exist|is unavailable)/i,
    /the page you[''']?re looking for/i
];

function anchorText(a) {
    return (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function stripTags(html) {
    return String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Count anchors whose href looks like a job-item link.
function countJobAnchors(anchors) {
    let n = 0;
    const samples = [];
    for (const a of anchors) {
        const href = (a.href || '').toString();
        if (!href || href === '#' || href.startsWith('javascript:')) continue;
        for (const p of JOB_ANCHOR_PATTERNS) {
            if (p.test(href)) {
                n++;
                if (samples.length < 5) samples.push({ href, text: anchorText(a) });
                break;
            }
        }
    }
    return { count: n, samples };
}

// Count elements whose class matches a job-card-ish pattern. Heuristic --
// we don't know the site's structure, so we count any match.
function countJobCards(html) {
    const re = /class\s*=\s*["']([^"']+)["']/gi;
    let m, n = 0;
    const seen = new Set();
    while ((m = re.exec(html)) !== null) {
        const cls = m[1];
        for (const p of JOB_CARD_CLASS_PATTERNS) {
            if (p.test(cls)) {
                // Count distinct class strings, not raw matches (a container
                // may have the same class on every card, which we WANT to
                // count once per occurrence).
                n++;
                break;
            }
        }
    }
    return n;
}

// Count JSON-LD JobPosting schemas. This is the strongest single signal that
// a page is a listing of real job postings -- but only if there's at least
// one, and if the JSON parses.
function countJsonLdJobPostings(html) {
    const re = /<script\s+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m, n = 0;
    const types = new Set();
    while ((m = re.exec(html)) !== null) {
        try {
            const parsed = JSON.parse(m[1]);
            const nodes = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
            for (const node of nodes) {
                const t = node && node['@type'];
                const arr = Array.isArray(t) ? t : [t];
                for (const tt of arr) {
                    if (!tt) continue;
                    types.add(tt);
                    if (tt === 'JobPosting') n++;
                }
            }
        } catch (e) { /* ignore malformed */ }
    }
    return { count: n, types: [...types] };
}

// Extract career-page link candidates from any anchors on this page.
// Confidence 1.0 for a bare /careers or /jobs href; 0.7 for text-only match
// (e.g. "<a href='/join-us'>Careers</a>"); 0.4 for href-only match without
// matching text (e.g. "/work-with-us" with text "Learn more").
function extractCareerLinkCandidates(anchors, currentUrl) {
    const out = [];
    const seen = new Set();
    for (const a of anchors) {
        const rawHref = a.href;
        if (!rawHref || rawHref === '#' || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:')) continue;
        const text = anchorText(a).toLowerCase();
        const hrefMatches = CAREERS_LINK_HREF_PATTERNS.some((p) => p.test(rawHref));
        const textMatches = CAREERS_LINK_TEXT_PATTERNS.some((p) => p.test(text));
        if (!hrefMatches && !textMatches) continue;

        // Absolute URL, resolved against current page.
        let abs;
        try { abs = new URL(rawHref, currentUrl).href; } catch (e) { continue; }
        // Skip same-page anchors and JS-driven hrefs.
        if (abs === currentUrl) continue;
        // Skip obvious non-careers hrefs that tripped a loose match.
        if (/\/(?:privacy|terms|contact|about|blog|login|signin)\b/i.test(abs)) continue;
        if (seen.has(abs)) continue;
        seen.add(abs);

        let confidence = 0.4;
        if (hrefMatches && textMatches) confidence = 1.0;
        else if (hrefMatches) confidence = 0.7;
        else if (textMatches) confidence = 0.5;

        out.push({ href: abs, text: anchorText(a), confidence });
    }
    return out.sort((a, b) => b.confidence - a.confidence);
}

// Main entry. Returns the preflight analysis object described in the header.
// Caller passes: { requestedUrl, finalUrl, httpStatus, html, bytes, contentType }
function _analyzePageRaw({ requestedUrl, finalUrl, httpStatus, html, bytes, contentType }) {
    const safeHtml = typeof html === 'string' ? html : '';
    const safeFinal = finalUrl || requestedUrl || '';
    const redirected = Boolean(requestedUrl && finalUrl && requestedUrl !== finalUrl);

    // Cheap short-circuits before parsing.
    if (!safeHtml || safeHtml.length < 200) {
        return {
            pageShape: 'fetch-empty',
            confidence: 1.0,
            reasoning: `body is only ${safeHtml.length} bytes -- likely empty response or truncation`,
            redirected,
            finalUrl: safeFinal,
            urlCandidates: [],
            signals: {
                httpStatus, bytes: bytes || safeHtml.length, bodyTextLength: safeHtml.length,
                jobAnchors: 0, jobCards: 0, jsonLdJobPostings: 0,
                hasNextData: false, hasNuxt: false, framework: null,
                looksBlocked: false, looksLikeErrorPage: false, careersMentioned: false
            }
        };
    }

    if (typeof httpStatus === 'number' && httpStatus >= 400) {
        return {
            pageShape: 'error',
            confidence: 1.0,
            reasoning: `HTTP ${httpStatus} -- server rejected or page missing`,
            redirected,
            finalUrl: safeFinal,
            urlCandidates: [],
            signals: {
                httpStatus, bytes: safeHtml.length, bodyTextLength: safeHtml.length,
                jobAnchors: 0, jobCards: 0, jsonLdJobPostings: 0,
                hasNextData: false, hasNuxt: false, framework: null,
                looksBlocked: false, looksLikeErrorPage: true, careersMentioned: false
            }
        };
    }

    // Deeper inspection. We can't use live DOM (this is HTML string, not
    // a browser page) -- we use regex-based scanning. That's fine for
    // preflight; the wizard's Puppeteer dump is the accurate DOM reader
    // and runs later.
    const bodyText = stripTags(safeHtml);
    const bodyTextLength = bodyText.length;

    // Extract <title> content for title-based challenge detection.
    const titleMatch = safeHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const titleText = titleMatch ? stripTags(titleMatch[1]).trim() : '';

    // Block detection: title-only. HTML token patterns (__cf_chl_*,
    // cdn-cgi/challenge-platform) appear in the standard Cloudflare JS
    // bundle on EVERY Cloudflare-fronted site, not just challenge pages --
    // matching them caused 6 false positives out of 76 sites. The title is
    // the only reliable signal: a real challenge has an unmistakable title.
    const titleBlocked = BLOCK_TITLE_MARKERS.some((re) => re.test(titleText));
    const looksBlocked = titleBlocked;
    const looksLikeErrorPage = ERROR_PAGE_MARKERS.some((re) => re.test(safeHtml));

    const frameworkHits = FRAMEWORK_MARKERS.filter((m) => m.re.test(safeHtml)).map((m) => m.name);
    const framework = frameworkHits[0] || null;
    const hasNextData = frameworkHits.includes('next');
    const hasNuxt = frameworkHits.includes('nuxt');

    const jsonLd = countJsonLdJobPostings(safeHtml);

    // Parse anchors. We only need href + text, so a minimal regex pass.
    // Not the full DOM -- preflight accepts the loss in accuracy for speed
    // and for working without Puppeteer.
    const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const anchors = [];
    let am;
    while ((am = anchorRe.exec(safeHtml)) !== null) {
        anchors.push({ href: am[1], textContent: stripTags(am[2]) });
    }

    const jobAnchorInfo = countJobAnchors(anchors);
    const jobCards = countJobCards(safeHtml);
    const careersMentioned = /careers?|we[''']?re hiring|join (?:our|the) team|open positions/i.test(bodyText);
    const urlCandidates = extractCareerLinkCandidates(anchors, safeFinal);

    const signals = {
        httpStatus, bytes: bytes || safeHtml.length, bodyTextLength,
        jobAnchors: jobAnchorInfo.count,
        jobCards,
        jsonLdJobPostings: jsonLd.count,
        jsonLdTypes: jsonLd.types,
        hasNextData, hasNuxt, framework,
        looksBlocked, looksLikeErrorPage, careersMentioned
    };

    // Review flags: informational only. They don't change accept/reject
    // semantics -- they surface concerns for human review. Consumers
    // (wizard prompt writer, report renderer) may display them.
    const reviewFlags = [];
    if (hasNextData) reviewFlags.push('spa-next');
    if (hasNuxt) reviewFlags.push('spa-nuxt');
    if (bodyTextLength < 500) reviewFlags.push('short-body-may-need-js');
    if (urlCandidates.length > 0) reviewFlags.push('career-links-present');
    if (jobCards > 0 && jobAnchorInfo.count === 0) reviewFlags.push('job-cards-no-item-links');

    // If the URL itself is a careers URL (path contains /careers, /jobs,
    // /openings, /vacancy, etc.), we should never classify it as homepage-*.
    // The heuristic was reclassifying /careers pages as "homepage-with-
    // careers" because they had nav links pointing to themselves. That
    // caused 4 false rejects out of 76.
    const urlLooksCareers = /\/(?:careers?|jobs?|openings?|vacanc(?:y|ies)|positions?|hiring|join-us|work-with-us)\b/i.test(safeFinal);
    if (urlLooksCareers) reviewFlags.push('url-is-careers-page');

    // Decision tree. Order matters: strongest signals first, fallbacks after.
    // Every branch records its `reasoning` so audit.log explains the verdict.

    if (looksBlocked) {
        return { pageShape: 'blocked', confidence: 1.0, reasoning: 'captcha / challenge markers detected', redirected, finalUrl: safeFinal, urlCandidates, signals };
    }

    // Error-page detection: requires BOTH an error-title pattern AND a
    // short body. body-text-only matching fires on JS-rendered SPAs whose
    // server HTML reduces to a small text blob even though the page is
    // fully functional. The <title> is the ground truth.
    const titleLooksError = /<title[^>]*>[^<]*(?:404|not found|error|oops|unavailable|denied)[^<]*<\/title>/i.test(safeHtml);
    const isSpaShellShaped = (hasNextData || hasNuxt) && bodyTextLength < 800;
    if (titleLooksError && bodyTextLength < 3000 && !isSpaShellShaped) {
        return { pageShape: 'error', confidence: 0.9, reasoning: 'title matches error pattern + body is short', redirected, finalUrl: safeFinal, urlCandidates, signals };
    }

    // SPA shell: framework marker present but body text is very small.
    // Threshold 800 chars chosen empirically -- a real marketing page is
    // 3000+ even when JS-driven, because header/footer/nav render server-side.
    if ((hasNextData || hasNuxt) && bodyTextLength < 800) {
        return { pageShape: 'spa-shell', confidence: 0.85, reasoning: `framework=${framework} but bodyTextLength=${bodyTextLength}`, redirected, finalUrl: safeFinal, urlCandidates, signals };
    }

    // Listing page: multiple job-item signals.
    // Rule: >=3 job anchors OR (>=1 job anchor AND >=1 JSON-LD JobPosting)
    //       OR (>=3 job cards AND bodyTextLength > 500).
    const strongListing = jobAnchorInfo.count >= 3
        || (jobAnchorInfo.count >= 1 && jsonLd.count >= 1)
        || (jobCards >= 3 && bodyTextLength > 500);
    if (strongListing) {
        return {
            pageShape: 'listing', confidence: 0.95,
            reasoning: `jobAnchors=${jobAnchorInfo.count} jobCards=${jobCards} jsonLdJobPostings=${jsonLd.count}`,
            redirected, finalUrl: safeFinal, urlCandidates: [],
            signals
        };
    }

    // Homepage-with-careers: NOT a listing itself, but there's a clear path
    // to one. Skip this branch if the URL is already a careers URL -- a
    // careers page with no detectable job anchors is 'unknown' (probably
    // JS-rendered), not a homepage needing navigation.
    if (!urlLooksCareers && urlCandidates.length > 0 && (jobAnchorInfo.count === 0 || jobCards < 3)) {
        return {
            pageShape: 'homepage-with-careers', confidence: 0.8,
            reasoning: `${urlCandidates.length} career page link(s) found; this page has ${jobAnchorInfo.count} job anchor(s)`,
            redirected, finalUrl: safeFinal, urlCandidates,
            signals
        };
    }

    // Homepage or marketing page with zero career signals.
    // Skip if URL is already a careers page -- no anchors means 'unknown'
    // (likely JS-rendered), not "there's no careers page here".
    if (!urlLooksCareers && jobAnchorInfo.count === 0 && jobCards < 3 && !careersMentioned && bodyTextLength > 1000) {
        return {
            pageShape: 'homepage-no-careers', confidence: 0.7,
            reasoning: `no job anchors, no job cards, no "careers" mention in ${bodyTextLength} chars of text`,
            redirected, finalUrl: safeFinal, urlCandidates: [],
            signals
        };
    }

    // Doesn't cleanly fit any bucket. Caller must decide (usually: hand to
    // wizard, but flag for review).
    return {
        pageShape: 'unknown', confidence: 0.3,
        reasoning: `jobAnchors=${jobAnchorInfo.count} jobCards=${jobCards} bodyText=${bodyTextLength} framework=${framework}`,
        redirected, finalUrl: safeFinal, urlCandidates,
        signals
    };
}

// Public wrapper: attaches reviewFlags to every return from the raw
// analyzer without modifying each return site.
function analyzePage(args) {
    const result = _analyzePageRaw(args);
    const flags = [];
    const sig = result.signals || {};
    if (sig.hasNextData) flags.push('spa-next');
    if (sig.hasNuxt) flags.push('spa-nuxt');
    if (sig.bodyTextLength < 500) flags.push('short-body-may-need-js');
    if (sig.jobCards > 0 && sig.jobAnchors === 0) flags.push('job-cards-no-item-links');
    if (result.urlCandidates && result.urlCandidates.length > 0) flags.push('career-links-present');
    const targetUrl = result.finalUrl || (args && args.requestedUrl) || '';
    if (/\/(?:careers?|jobs?|openings?|vacanc(?:y|ies)|positions?|hiring|join-us|work-with-us)\b/i.test(targetUrl)) {
        flags.push('url-is-careers-page');
    }
    return { ...result, reviewFlags: flags };
}

module.exports = {
    analyzePage,
    // Exported for tests / callers that want to extend the heuristics.
    JOB_ANCHOR_PATTERNS,
    JOB_CARD_CLASS_PATTERNS,
    CAREERS_LINK_TEXT_PATTERNS,
    CAREERS_LINK_HREF_PATTERNS,
    FRAMEWORK_MARKERS,
    BLOCK_TITLE_MARKERS,
    BLOCK_HTML_TOKENS,
    BLOCK_SOFT_MARKERS,
    BLOCK_SHORT_BODY_THRESHOLD,
    ERROR_PAGE_MARKERS
};
