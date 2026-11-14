// scripts/batch/classify.js
// Curl-time classification. Pure function: takes (url, html) from a plain
// HTTP fetch and returns a fingerprint verdict. The point is to split an
// input URL list into "can be done via API, no browser needed" versus
// "needs the wizard flow", before any Puppeteer work starts.
//
// Empty-is-not-broken is a first-class rule here. An ATS fingerprint is a
// contract: "this endpoint exists and is queryable." If the endpoint
// currently returns 0 jobs, that's still a passing template -- the site
// has no current openings, not that the code is wrong. The generator must
// produce code that succeeds on empty, and the verifier must accept it
// (meta.atsEmpty = true). Same semantic as a listing-to-detail extractor
// whose listing genuinely had 0 items today. Additions/removals/
// modifications between runs are the normal case, not an error case.
//
// Never imported by src/. Batch-only. No dependencies beyond node core.

// ATS endpoint fingerprints. Order matters -- first match wins. Each
// pattern captures the account slug the API URL needs. Excludes are
// subdomains that look like the family but are not a single tenant
// (careers-analytics.recruitee.com serves many companies, not one).
const ATS_PATTERNS = [
    {
        family: 'workable',
        re: /apply\.workable\.com\/([a-z0-9_-]+)/i,
        api: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`
    },
    {
        family: 'personio',
        re: /([a-z0-9-]+)\.jobs\.personio\.([a-z]+)/i,
        api: (slug, tld) => `https://${slug}.jobs.personio.${tld}/xml?language=en`
    },
    {
        family: 'smartrecruiters',
        // Case-sensitive on the slug -- SR uses Verisk (mixed), not verisk.
        re: /careers\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/,
        api: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings`
    },
    {
        family: 'recruitee',
        re: /([a-z0-9-]+)\.recruitee\.com/i,
        exclude: (slug) => slug === 'careers-analytics' || slug === 'captcha' || slug === 'recruitee-main',
        api: (slug) => `https://${slug}.recruitee.com/api/offers/`
    },
    {
        family: 'greenhouse',
        re: /(?:boards|boards-api)\.greenhouse\.io\/(?:v1\/boards\/)?([a-z0-9_-]+)/i,
        api: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`
    },
    {
        family: 'lever',
        re: /(?:jobs|api)\.lever\.co\/(?:v0\/postings\/)?([a-z0-9_-]+)/i,
        api: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`
    },
    {
        family: 'ashby',
        re: /(?:jobs\.ashbyhq\.com|api\.ashbyhq\.com\/posting-api\/job-board)\/([a-z0-9_-]+)/i,
        api: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`
    }
];

// SSR framework markers. Not templates -- these hint at where the item
// data lives (a JSON blob in the HTML) so the wizard can pick the right
// reference extractor. Still routed to the wizard flow.
const SSR_MARKERS = [
    { type: 'ssr-next', re: /__NEXT_DATA__/ },
    { type: 'ssr-nuxt', re: /__NUXT__/ }
];

// Cheap JSON-LD presence check. Job posting JSON-LD lives on detail pages,
// not listings, so this cannot confirm "has JobPosting schema" -- only
// "some JSON-LD exists somewhere on this page." The wizard checks the
// detail page later. Still worth recording as a hint.
function hasJsonLd(html) {
    return /<script type="application\/ld\+json"/i.test(html);
}

function matchAts(url, html) {
    for (const p of ATS_PATTERNS) {
        // URL first -- cheaper, and the slug is usually right there.
        // Fall back to HTML scan because some careers pages embed the
        // ATS URL in a <script> block rather than linking it directly.
        const urlMatch = url.match(p.re);
        const htmlMatch = !urlMatch && html.match(p.re);
        const m = urlMatch || htmlMatch;
        if (!m) continue;
        const slug = m[1];
        const tld = m[2] || null;
        if (p.exclude && p.exclude(slug)) continue;
        return {
            family: p.family,
            slug,
            tld,
            api: p.api(slug, tld),
            evidence: { matchedFrom: urlMatch ? 'url' : 'html', raw: m[0] }
        };
    }
    return null;
}

// Main entry. Returns one of:
//   { type: 'ats-<family>', template, slug, tld, apiUrl, evidence }
//   { type: 'ssr-next'|'ssr-nuxt', template: null, evidence }
//   { type: 'jsonld-present', template: null, evidence }
//   { type: 'wizard', template: null, evidence }   (fallback)
//   { type: 'fetch-failed', template: null, evidence }
//
// The `template` field is the only thing the generator branches on. Null
// means "hand to wizard". Non-null means "run the corresponding template
// and skip Puppeteer entirely."
function classifyHtml(url, html) {
    if (!url) throw new Error('classifyHtml: url is required');
    if (typeof html !== 'string') {
        return { type: 'fetch-failed', template: null, evidence: { reason: 'html was not a string' } };
    }

    const ats = matchAts(url, html);
    if (ats) {
        return {
            type: `ats-${ats.family}`,
            template: ats.family,
            slug: ats.slug,
            tld: ats.tld,
            apiUrl: ats.api,
            evidence: ats.evidence
        };
    }

    for (const m of SSR_MARKERS) {
        if (m.re.test(html)) {
            return { type: m.type, template: null, evidence: { marker: m.re.toString() } };
        }
    }

    if (hasJsonLd(html)) {
        return { type: 'jsonld-present', template: null, evidence: {} };
    }

    return { type: 'wizard', template: null, evidence: {} };
}

module.exports = { classifyHtml, ATS_PATTERNS };
