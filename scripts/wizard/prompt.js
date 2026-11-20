// scripts/wizard/prompt.js
// Generates the paste-ready LLM prompt. Embeds the dump, the site-type
// detection, the extractor contract, the field requirements, per-field
// DOM evidence, and one full reference extractor.

const fs = require('fs');
const path = require('path');
const { fitHtmlToBudget } = require('./dump');

const REPO = path.resolve(__dirname, '..', '..');

const REFERENCE_EXAMPLES = {
    'single-page-cards': 'src/scrapers/extractors/events/khalti.js',
    'listing-to-detail': 'src/scrapers/extractors/events/katajaam.js',
    'jsonld-first':      'src/scrapers/extractors/events/nepvents.js',
    'unknown':           'src/scrapers/extractors/events/katajaam.js'
};

// Per-type overrides. REFERENCE_EXAMPLES above is the events table and is also
// the final fallback. A type listed here resolves detected.type within its own
// domain first (then that domain's 'unknown'), so a jobs/scholarships prompt is
// never handed an events extractor as its worked example. Types with no entry
// here (events) use REFERENCE_EXAMPLES unchanged.
// Known gap: jobs/listing-to-detail -> kumarijob has no _status/_evidence
// reporting (growbydata/adex do). Swap the entry when a better one is vetted.
const TYPE_REFERENCE_EXAMPLES = {
    jobs: {
        'single-page-cards': 'src/scrapers/extractors/jobs/growbydata.js',
        'listing-to-detail': 'src/scrapers/extractors/jobs/kumarijob.js',
        'jsonld-first':      'src/scrapers/extractors/jobs/lftechnology.js',
        'single-posting':    'src/scrapers/extractors/jobs/lftechnology.js',
        'hub':               'src/scrapers/extractors/jobs/growbydata.js',
        'unknown-shape':     'src/scrapers/extractors/jobs/growbydata.js',
        'unknown':           'src/scrapers/extractors/jobs/growbydata.js'
    },
    scholarships: {
        'single-page-cards': 'src/scrapers/extractors/scholarships/scholarshipsads.js',
        'listing-to-detail': 'src/scrapers/extractors/scholarships/erasmusmundus.js',
        'unknown':           'src/scrapers/extractors/scholarships/scholarshipsads.js'
    }
};

function resolveReferencePath(type, detectedType) {
    const byType = TYPE_REFERENCE_EXAMPLES[type];
    if (byType) {
        const hit = byType[detectedType] || byType.unknown;
        if (hit) return hit;
    }
    return REFERENCE_EXAMPLES[detectedType] || REFERENCE_EXAMPLES.unknown;
}

function loadReference(type, detectedType) {
    const ref = resolveReferencePath(type, detectedType);
    try {
        return { path: ref, code: fs.readFileSync(path.join(REPO, ref), 'utf8') };
    } catch (e) {
        return { path: ref, code: '// Reference example not found -- read src/scrapers/extractors/README.md instead.' };
    }
}

function formatFieldEvidenceForPrompt(listing, detail) {
    try {
        const { formatEvidenceForPrompt } = require('./fieldEvidence');
        const parts = [];
        if (listing && listing.fieldEvidence) {
            parts.push('### From the listing page');
            parts.push(formatEvidenceForPrompt(listing.fieldEvidence, 'listing'));
        }
        if (detail && detail.fieldEvidence) {
            parts.push('### From the sample detail page (authoritative for per-item fields)');
            parts.push(formatEvidenceForPrompt(detail.fieldEvidence, 'detail'));
        }
        if (parts.length === 0) {
            return 'No field evidence captured (dump predates field-evidence scan). Fall back to DOM reasoning from the evidence dump below.';
        }
        return parts.join('\n\n');
    } catch (e) {
        return 'Field evidence unavailable: ' + e.message;
    }
}

// Universal warnings distilled from 33 self-diagnosing extractors. Every
// bullet here is a real failure an LLM-corrected extractor documented:
// the wizard claimed X, reality was Y. Feeding these to future prompts
// stops the same class of mistake from shipping.
const ANTI_PATTERNS_SECTION = `## Wizard evidence warnings -- read before trusting the dump

The DOM scanner (wizard) has known false-positive patterns. These
are VERIFIED from past extractor corrections. When you see any of
these in the evidence below, IGNORE the wizard evidence and reason
from the raw HTML instead.

### Card wrapper false positives

Reject any cardCandidates selector matching these -- they are HTML
chrome, not job cards:
- script, link, meta, style, noscript, svg, path
- div.swiper-slide* (carousel image slides, no text content)
- [class*="logo"], [class*="cookie"], [class*="breadcrumb"]

If every cardCandidate is one of these, there are NO real job cards
in the dump. Use raw HTML to find the actual structure.

### Detail-link pattern false positives

These are NOT per-job detail routes:
- Bare / (matches every nav anchor)
- tel:, mailto:, javascript:, #fragment
- /home, /about, /contact, /blog
- /services/*, /solutions/*, /products/*, /news/*, /resources/*
- Social media: facebook, twitter, x.com, linkedin, instagram,
  whatsapp, youtube
- URLs pointing back to the same page

If detailLinkCandidates is dominated by any of the above, the site
has NO per-role detail pages. Treat as SINGLE-PAGE-CARDS. Extract
from listing cards directly.

### Sample detail page may be wrong

If the "sample detail page" URL is:
- A social media site (facebook/twitter/x/linkedin/instagram/whatsapp)
- A marketing, services, or solutions page
- A homepage or hero page
- The same URL as the listing (wizard misresolved)

...then DISCARD the wizard detail-page evidence entirely. Any
H1.*, div.*, or "longest description" selector from that page is
noise. Reason only from the listing-page raw HTML.

### Longest-description candidate is often wrong

The wizard's "longest description candidate" frequently wraps the
whole page (div.container, main, body). Do NOT use it as the
description selector when:
- Its char count is > 4000
- The selector is a generic container class
- Its sample text starts with site nav / hero copy

Instead:
1. Read the raw detail HTML below, find the actual role-body region
2. Prefer specific classes: [class*="job-description"],
   [class*="role-body"], [class*="job-detail"], article p
3. Fall back to card <p> excerpt if no detail body exists
4. If nothing role-specific exists: description_status: site_absent

### Empty-state detection (do this FIRST)

Before extracting anything, search the raw HTML for:
- "no open positions", "no current openings", "no job openings"
- "no vacancies", "no any vacancy"
- "we are always hiring", "always on the lookout", "not hiring"
- "check back soon", "there are no (open|current)"
- "sorry, no positions available at this time"

If ANY appear AND no role-shaped cards exist, return
{ items: [], meta } with meta.atsEmpty = true.
Do NOT invent items from marketing or hero content.

### Structural patterns to prefer

- Accordions (Bootstrap div.collapse, div.accordion-*): content is
  in DOM even when collapsed. Read directly; expand defensively only
  if reading the collapsed content produces empty.
- Hub pages (/jobs/ lists departments): traverse ONE level deeper.
  Real job cards live inside the department pages.
- ATS JSON-LD (Workable, Personio, SmartRecruiters, Recruitee):
  application/ld+json JobPosting blocks are AUTHORITATIVE for
  title/company/location/description/employmentType/dates.
  Prefer JSON-LD over DOM selectors when present.

### Extraction self-checks -- run BEFORE writing code

If any check fails, your planned extractor has a structural bug.
Fix the selector logic before returning items:

1. Are all description values UNIQUE per item? If all identical,
   you grabbed the listing page as each item's description.
2. Are url / registrationUrl values distinct per item? All same +
   different titles = single-page board (OK). All same + same
   descriptions = page-dump bug (not OK).
3. Is every location under 80 chars and place-shaped? Longer means
   prose (company HQ copy) leaked into location.
4. Is every salary either null OR under 60 chars with a numeric/
   currency token? Long prose = bug.
5. Is every company short (site name, not a paragraph)?
`;

const FIELD_REQUIREMENTS_SECTION = [
    '## Field requirements',
    '',
    'The extractor MUST attempt each field below. Verify rejects extractors',
    'that produce items missing required fields -- a source returning 8 items',
    'where 0 have a company is a failed extraction, not a passing one.',
    '',
    '### Tier 1 -- MANDATORY',
    '',
    '- **title**: the role name. No title = the item is rejected. Every item MUST have a title.',
    '- **company**: the employer name. Almost always present in the DOM -- site chrome (header logo, og:site_name meta, footer copyright), employment cards, or detail page breadcrumbs. Only mark as `site_absent` when the SITE genuinely does not name the employer anywhere (rare -- check first).',
    '- **url**: the detail page URL, apply URL, or listing-card link. Must be absolute. If the site has no per-item URL, use the listing URL.',
    '- **location**: the job\u2019s physical location. Most sites publish this in a card or detail-page header. Nepal-based sources auto-pass empty locations through the geo filter, but the extractor should still attempt to grab it.',
    '- **description**: the role body. Usually the largest prose block on the detail page or a dedicated card section. If the site genuinely publishes no role body (rare -- check the detail page before claiming), the description can be null but the extractor must still attempt the query.',
    '',
    '### Tier 2 -- EXPECTED',
    '',
    '- **employmentType**: full-time / part-time / contract / internship.',
    '- **applicationEndsRaw**: the raw apply-by date string. The orchestrator parses it into ISO and drops expired jobs -- if you don\u2019t set this and the site publishes it, expired jobs will be queued.',
    '- **image**: per-item image URL. If the site has no per-item image, skip -- the orchestrator will synthesize a placeholder.',
    '- **salary**: any salary/compensation string.',
    '',
    '### Tier 3 -- OPTIONAL',
    '',
    '`experience`, `level`, `openings`, `responsibilities`, `requirements`, `skills`, `publishedAt`, `companyUrl`, `companyLogoUrl`, `companyDescription`, `companyLocation`, `companyAddress`, `attendanceMode`.',
    '',
    '### How to report each field\u2019s extraction status',
    '',
    'For every Tier 1 / Tier 2 field that comes out null on a given item, include a sibling field with status + evidence:',
    '',
    '```js',
    '{',
    '    title: "Senior Engineer",',
    '    company: null,',
    '    company_status: "site_absent",',
    '    company_evidence: "searched [class*=\'company\'], [class*=\'employer\'], header logo, og:site_name -- no employer name found on listing or detail page",',
    '}',
    '```',
    '',
    'Valid values for `<field>_status`:',
    '- `extracted` -- value present, nothing more needed',
    '- `site_absent` -- site genuinely does not publish this field; evidence must describe what you searched',
    '- `extraction_failed` -- element IS in the DOM but you could not select it cleanly; evidence should include the selector you tried',
    '',
    'Verify rejects `extraction_failed` on Tier 1 fields and warns on `site_absent` if the field-evidence block below shows an element that matches.',
    '',
    '### Traversal strategy (important)',
    '',
    '- If the detected site type is `single-page-cards` AND the cards contain full role bodies, extract from cards -- that\u2019s faster.',
    '- If cards contain only titles / apply CTAs / vacancy counts (no description, no company), DO NOT extract from cards alone -- follow each card\u2019s link to the detail page and extract there. The `info_starved_cards` site type means cards are pointers, not data; navigate to detail pages.',
    '- For `listing-to-detail` sites, always fetch detail pages -- the listing card is not the data.',
    '',
].join('\n');

const FIELD_EVIDENCE_HEADER = [
    '## Field evidence from this site',
    '',
    'Field-oriented DOM evidence -- where each field lives on THIS site,',
    'found by the wizard\u2019s per-field scan (JSON-LD JobPosting if present,',
    'OpenGraph meta, and selector hints). Use this to write selectors that',
    'actually target the right element. If a field is NOT listed below,',
    'the wizard found no matching element -- that\u2019s the site\u2019s genuine',
    'structure, and it\u2019s evidence you can cite when setting',
    '`<field>_status: "site_absent"`.',
    '',
].join('\n');

function buildPrompt({ name, type, url, listing, detail, detected }) {
    const ref = loadReference(type, detected.type);
    const rawCard = fitRawHtmlForPrompt(listing && listing.rawCardHtml, 'rawCardHtml');
    const rawDetail = fitRawHtmlForPrompt(detail && detail.rawDetailHtml, 'rawDetailHtml');

    const parts = [];

    parts.push(`# Extractor task: ${name} (${type})`);
    parts.push('');
    parts.push('You are generating a scraper extractor for a Puppeteer-based Discord bot.');
    parts.push('The extractor\u2019s job is to visit the given site through a headless browser');
    parts.push('and return a structured array of items. Everything else (browser');
    parts.push('lifecycle, retry, sanitization, progress reporting, diagnostics) is');
    parts.push('handled by the bot\u2019s orchestration layer -- you write ONLY the extract()');
    parts.push('function body.');
    parts.push('');
    parts.push('## Target');
    parts.push('');
    parts.push(`- Name: \`${name}\``);
    parts.push(`- Type: \`${type}\``);
    parts.push(`- Entry URL: ${url}`);
    parts.push('');
    parts.push(`## Detected site type: \`${detected.type}\``);
    parts.push('');
    parts.push(describeSiteType(detected));
    parts.push('');
    parts.push('## Before you write code -- confirm these assumptions');
    parts.push('');
    parts.push(buildAssumptionsSection(detected, listing, detail));
    parts.push('');
    parts.push('If ANY assumption above is wrong, **correct it first**, then proceed.');
    parts.push('Do not write code against a wrong assumption.');
    parts.push('');
    parts.push('## The contract');
    parts.push('');
    parts.push('```js');
    parts.push('module.exports = {');
    parts.push('    preprocessItem(item) { return item; },');
    parts.push('    async extract(page, { progress, meta }) {');
    parts.push('        // meta.pagesVisited / listingHits / detailPagesVisited / detailParseFailures / looksBlocked');
    parts.push('        // progress: safeDiscovered(progress, n), safeUnitDone(progress)');
    parts.push('        return { items, meta };');
    parts.push('    }');
    parts.push('};');
    parts.push('```');
    parts.push('');
    parts.push('## Available helpers');
    parts.push('');
    parts.push('```js');
    parts.push("const { delay, loadPage } = require('../../page');");
    parts.push("const { safeDiscovered, safeUnitDone } = require('../../progress');");
    parts.push("const { pickOne, pickAll } = require('../../selectors');");
    parts.push("const { detectPageState } = require('../../diagnostics');");
    parts.push("const { sanitizeScrapedEvent, sanitizeImageUrl } = require('../../sanitize');");
    parts.push("const { trimDescriptionToLastSentence, cleanDescriptionText } = require('../../text');");
    parts.push('```');
    parts.push('');
    parts.push('- `loadPage(page, url)` -- navigates with env-driven wait/timeout defaults. Override per call with `loadPage(page, url, { waitUntil, timeout })`.');
    parts.push('- `pickOne(page, [selector1, selector2, ...], { label })` -- tries each selector in order, returns the first non-empty match.');
    parts.push('- `pickAll(page, [selector1, ...], { label, attr = \'href\' })` -- same for lists.');
    parts.push('- `detectPageState(page)` -- `{ looksBlocked, bodySnippet }` -- call once on first load.');
    parts.push('- `__resolveImageSrc(imgEl)` -- injected on every page; handles lazy-load and placeholder stripping.');
    parts.push('');
    parts.push('## Item shape (what each object should look like)');
    parts.push('');
    parts.push('```js');
    parts.push('{');
    parts.push('    id: string,');
    parts.push('    title: string,');
    parts.push('    description: string,');
    parts.push('    date: string|null,');
    parts.push('    time: string|null,');
    parts.push('    location: string|null,');
    parts.push('    price: string|null,');
    parts.push('    organizer: string|null,');
    parts.push('    category: string|null,');
    parts.push('    tags: string[],');
    parts.push('    image: string|null,');
    parts.push('    url: string,');
    parts.push('    registrationUrl: string|null,');
    parts.push('    attendanceMode: string|null,');
    parts.push(`    source: '${name}'`);
    parts.push('}');
    parts.push('```');
    parts.push('');
    parts.push(`For \`${type}\` items that map to a different domain shape (jobs,`);
    parts.push('scholarships), see `src/scrapers/jobs.js` and');
    parts.push('`src/scrapers/scholarships.js` for the additional fields.');
    parts.push('');
    parts.push(ANTI_PATTERNS_SECTION);
    parts.push('');
    parts.push(FIELD_REQUIREMENTS_SECTION);
    parts.push(`## Reference example -- a working ${detected.type} extractor`);
    parts.push('');
    parts.push('```js');
    parts.push(`// ${ref.path}`);
    parts.push(ref.code);
    parts.push('```');
    parts.push('');
    parts.push('## Evidence dump (listing page)');
    parts.push('');
    parts.push('```json');
    parts.push(JSON.stringify(compactListingEvidence(listing, rawCard), null, 1));
    parts.push('```');
    parts.push('');
    if (detail) {
        parts.push('## Evidence dump (sample detail page)');
        parts.push('');
        parts.push('```json');
        parts.push(JSON.stringify(compactDetailEvidence(detail), null, 1));
        parts.push('```');
        parts.push('');
    }
    // Raw HTML evidence -- the primary structural signal for the LLM.
    // Wizard heuristics can be wrong; raw HTML is always right.
    if (rawCard && rawCard.html) {
        parts.push('## Raw HTML (one representative listing card)');
        parts.push('');
        parts.push('Actual HTML of ONE card from the listing. Use this to');
        parts.push('identify the correct selector structure instead of trusting');
        parts.push('wizard heuristics that may be wrong.');
        parts.push('');
        if (rawCard.qualityWarning === 'no_job_signal') {
            parts.push('WARNING: the raw HTML below does NOT contain any job-related keywords (job, role, position, apply, hiring). It may be the wrong DOM element (nav/hero/footer that slipped past chrome-strip) or a genuinely empty careers page. Before writing selectors, check the HTML for real content. If you find no job cards here, look at the evidence dump and consider whether the source is empty.');
            parts.push('');
        }
        if (rawCard.removed && rawCard.removed.length > 0) {
            const truncated = rawCard.removed.find((r) => r.step === 'truncated');
            const stripped = rawCard.removed.filter((r) => r.step !== 'truncated').map((r) => `${r.step}(-${r.delta})`).join(', ');
            parts.push(`HTML budget report: ${rawCard.originalSize}B original -> ${rawCard.finalSize}B final.`);
            if (stripped) parts.push(`Stripped: ${stripped}`);
            if (truncated)             parts.push(`TRUNCATED ${truncated.delta}B -- the HTML excerpt is capped at a balanced element boundary. Use the field evidence below for values beyond the visible excerpt.`);
            parts.push('');
        }
        parts.push('```html');
        parts.push(rawCard.html);
        parts.push('```');
        parts.push('');
    }
    if (rawDetail && rawDetail.html) {
        parts.push('## Raw HTML (detail page role-body region)');
        parts.push('');
        parts.push('Actual HTML of the role-body region on a detail page.');
        parts.push('This is where description / location / salary live.');
        parts.push('Extract from here, not from main.bodyInnerText.');
        parts.push('');
        if (rawDetail.removed && rawDetail.removed.length > 0) {
            const truncated = rawDetail.removed.find((r) => r.step === 'truncated');
            const stripped = rawDetail.removed.filter((r) => r.step !== 'truncated').map((r) => `${r.step}(-${r.delta})`).join(', ');
            parts.push(`HTML budget report: ${rawDetail.originalSize}B original -> ${rawDetail.finalSize}B final.`);
            if (stripped) parts.push(`Stripped: ${stripped}`);
            if (truncated) parts.push(`TRUNCATED ${truncated.delta}B -- the HTML excerpt is capped at a balanced element boundary. Use field evidence below for values beyond the visible excerpt.`);
            parts.push('');
        }
        parts.push('```html');
        parts.push(rawDetail.html);
        parts.push('```');
        parts.push('');
    }

    parts.push(FIELD_EVIDENCE_HEADER);
    parts.push('```');
    parts.push(formatFieldEvidenceForPrompt(listing, detail));
    parts.push('```');
    parts.push('');
    parts.push('## Verdict (required)');
    parts.push('');
    parts.push('Before writing code, decide whether the Entry URL is actually a careers/jobs listing page.');
    parts.push('');
    parts.push('```');
    parts.push('VERDICT: CAREERS_PAGE');
    parts.push('VERDICT: NOT_CAREERS_PAGE -- <one-line reason>');
    parts.push('VERDICT: CAREERS_PAGE_REDIRECT -- <absolute URL>');
    parts.push('```');
    parts.push('');
    parts.push('Rules:');
    parts.push('- CAREERS_PAGE -- entry URL is a jobs listing, or leads to one via normal navigation on the same site.');
    parts.push('- NOT_CAREERS_PAGE -- entry URL is a homepage, marketing page, login wall, or 404. Reason <= 120 chars. Skip writing extractor code.');
    parts.push('- CAREERS_PAGE_REDIRECT -- entry URL is not the listing, but the listing exists elsewhere on the SAME site. Provide absolute URL. Batch follows (max 3 hops, same-domain only), re-dumps, re-prompts.');
    parts.push('');
    parts.push('## What to output');
    parts.push('');
    parts.push(`One code block, ready to paste over \`src/scrapers/extractors/${type}/${name}.js\`. Nothing else. No explanation before or after. The full module body including all requires.`);
    parts.push('');
    parts.push('## Edge cases to handle');
    parts.push('');
    parts.push('- **Empty result** -- return `{ items: [], meta }` with `meta.listingHits = 0` or `meta.atsEmpty = true`. Don\u2019t throw.');
    parts.push('- **Cloudflare / captcha** -- call `detectPageState` on first load. If `looksBlocked`, set `meta.looksBlocked = true` and return early.');
    parts.push('- **Missing fields** -- populate whatever the page gives you, use `<field>_status` + `<field>_evidence` per field requirements above.');
    parts.push('- **Paginated listings** -- follow the site\u2019s own pagination. Cap at 10 pages.');
    parts.push('- **Virtualized/infinite scroll** -- scroll in steps, harvest after each. See katajaam.js or sathijob.js.');
    parts.push('- **JSON-LD present but incomplete** -- prefer JSON-LD where it exists, fall back to HTML selectors for missing fields.');
    parts.push('- **Multi-stage navigation** -- if entry URL leads to a category or homepage, navigate through it first.');
    parts.push('- **Retries** -- orchestrator retries the whole extract(). Do NOT add per-page retry inside extract().');
    parts.push('- **Keep lines under 120 chars** -- long single-line regex literals over ~200 chars get truncated by clipboard tools. Break alternations with comments, use named constants for repeated patterns, or split into a chain of .replace() calls. If a regex has more than 8 alternations, split it into two variables.');
    parts.push(`- **Logging** -- log ONCE at the end of extract(), e.g. \`console.log('  [${name}] extracted ' + items.length)\`. Do NOT log inside per-item loops.`);
    parts.push('');
    parts.push('Do not invent selectors you have not seen in the field evidence. If a field cannot be extracted with confidence, use `<field>_status: "extraction_failed"` with the selector you tried.');
    parts.push('');

    // Hard total budget (MAX_PROMPT_BYTES, 52KB). Under budget this returns the
    // assembled prompt untouched and the trimmer is never called. Over budget,
    // trimPartsToBudget walks the sacrifice ladder documented below. REQUIRED
    // sections (scripts/batch/lib/prompt-structure.js) are truncated, never deleted.
    const assembled = parts.join('\n');
    if (Buffer.byteLength(assembled, 'utf8') <= MAX_PROMPT_BYTES) return assembled;
    return trimPartsToBudget(parts, { max: MAX_PROMPT_BYTES, minEvidence: MIN_EVIDENCE_BYTES });
}

// ---- Prompt budget trimmer -------------------------------------------------
// Read-only import: the trimmer consults the validator's REQUIRED_SECTIONS so
// it can never delete a section the validator demands. (prompt-structure.js
// only requires fs, so there is no import cycle.)
const promptStructure = require('../batch/lib/prompt-structure');

const MAX_PROMPT_BYTES = 52000;
const MIN_EVIDENCE_BYTES = 2048;
const MARKER_RESERVE = 300;
const SAMPLE_DETAIL_HEADER = '## Evidence dump (sample detail page)';
const LISTING_DUMP_HEADER = '## Evidence dump (listing page)';
const TRUNC_PREFIX = '\u2026truncated ';
const TRUNC_SUFFIX = ' bytes';

function compactPromptValue(value, depth) {
    if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) + '\u2026' : value;
    if (!value || typeof value !== 'object' || depth > 4) return value;
    if (Array.isArray(value)) {
        return value.slice(0, 8).map((item) => compactPromptValue(item, depth + 1));
    }

    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (/^(?:raw.*html|fieldEvidence|sampleHtml)$/i.test(key)) continue;
        const compacted = compactPromptValue(item, depth + 1);
        result[key] = compacted;
        if (Array.isArray(item) && item.length > 8) result[key + 'OmittedCount'] = item.length - 8;
    }
    return result;
}

function compactListingEvidence(listing, rawCard) {
    if (!listing || typeof listing !== 'object') return listing;

    const result = {};
    for (const key of ['url', 'title', 'jsonLdTypes', 'pagination', 'categoryChips', 'bodySnippet']) {
        if (listing[key] !== undefined) result[key] = compactPromptValue(listing[key], 0);
    }
    if (Array.isArray(listing.anchorGroups)) {
        result.anchorGroups = compactPromptValue(listing.anchorGroups.slice(0, 8), 0);
        if (listing.anchorGroups.length > 8) result.anchorGroupsOmittedCount = listing.anchorGroups.length - 8;
    }
    for (const key of ['cardCandidates', 'cardCandidatesWeak', 'detailLinkCandidates']) {
        if (!Array.isArray(listing[key])) continue;
        const candidates = listing[key].slice(0, 8).map((candidate, index) => {
            const compacted = compactPromptValue(candidate, 0);
            if (candidate && Array.isArray(candidate.hrefs)) {
                const limit = index === 0 ? 8 : 3;
                compacted.hrefs = candidate.hrefs.slice(0, limit);
                if (candidate.hrefs.length > limit) compacted.hrefsOmittedCount = candidate.hrefs.length - limit;
            }
            return compacted;
        });
        result[key] = candidates;
        if (listing[key].length > 8) result[key + 'OmittedCount'] = listing[key].length - 8;
    }
    if (rawCard && typeof rawCard === 'object') {
        const raw = rawCard;
        result.rawCardHtml = {};
        for (const key of ['label', 'originalSize', 'finalSize', 'truncated', 'jobSignalHits', 'qualityWarning']) {
            if (raw[key] !== undefined) result.rawCardHtml[key] = raw[key];
        }
    }
    return result;
}

function compactDetailEvidence(detail) {
    if (!detail || typeof detail !== 'object') return detail;
    return compactPromptValue(detail, 0);
}

function fitRawHtmlForPrompt(raw, label) {
    if (!raw || typeof raw.html !== 'string') return raw;
    const fitted = fitHtmlToBudget(raw.html, 6000, label);
    const originalSize = Number(raw.originalSize) || fitted.originalSize;
    const removed = Array.isArray(raw.removed)
        ? raw.removed.filter((entry) => entry.step !== 'truncated')
        : [];
    if (originalSize > fitted.finalSize) {
        removed.push({ step: 'truncated', delta: originalSize - fitted.finalSize });
    }
    return {
        ...raw,
        html: fitted.html,
        originalSize,
        finalSize: fitted.finalSize,
        removed,
        truncated: originalSize > fitted.finalSize,
        label: raw.label || label
    };
}

function isRequiredHeader(header) {
    return promptStructure.REQUIRED_SECTIONS.some((spec) =>
        spec.match === 'exact' ? header === spec.text : header.startsWith(spec.text));
}

function isSectionHeader(p) {
    return typeof p === 'string' && p.startsWith('## ');
}

// Delete a whole section (header through the next ## header). Refuses any
// REQUIRED section; only OPTIONAL sections may be deleted outright.
function dropSectionByHeader(parts, header, dropped) {
    if (isRequiredHeader(header)) return false;
    const start = parts.findIndex((p) => p === header);
    if (start < 0) return false;
    let end = start + 1;
    while (end < parts.length && !isSectionHeader(parts[end])) end++;
    parts.splice(start, end - start);
    dropped.push(header);
    return true;
}

// Shrink the largest body block of a section in place. The header element and
// code fences remain untouched. Returns the number of UTF-8 bytes removed.
function truncateSectionBody(parts, header, need, minKeep) {
    const start = parts.findIndex((p) => p === header);
    if (start < 0) return 0;
    let end = start + 1;
    while (end < parts.length && !isSectionHeader(parts[end])) end++;

    let idx = -1;
    let longest = 0;
    for (let i = start + 1; i < end; i++) {
        const p = parts[i];
        if (typeof p !== 'string' || p.startsWith('```')) continue;
        if (p.length > longest) { longest = p.length; idx = i; }
    }
    if (idx < 0) return 0;

    const payload = parts[idx];
    const payloadBytes = Buffer.byteLength(payload, 'utf8');
    let keepBytes = Math.max(minKeep, payloadBytes - need - 1 - 40);
    if (keepBytes >= payloadBytes) return 0;
    let keep = Math.min(payload.length, keepBytes);
    while (keep > 0 && Buffer.byteLength(payload.slice(0, keep), 'utf8') > keepBytes) keep--;
    if (keep > 0 && payload.charCodeAt(keep - 1) >= 0xd800 && payload.charCodeAt(keep - 1) <= 0xdbff) keep--;

    const keptBytes = Buffer.byteLength(payload.slice(0, keep), 'utf8');
    const removed = payloadBytes - keptBytes;
    const note = TRUNC_PREFIX + removed + TRUNC_SUFFIX;
    parts[idx] = payload.slice(0, keep) + '\n' + note;
    return removed;
}

function listingJsonPayloadIndex(parts) {
    const start = parts.findIndex((p) => p === LISTING_DUMP_HEADER);
    if (start < 0) return -1;
    const fence = parts.indexOf('```json', start);
    return fence >= 0 && typeof parts[fence + 1] === 'string' ? fence + 1 : -1;
}

function reduceJsonEvidence(value, arrayLimit, stringLimit) {
    if (typeof value === 'string') return value.length > stringLimit ? value.slice(0, stringLimit) + '\u2026' : value;
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.slice(0, arrayLimit).map((item) =>
        reduceJsonEvidence(item, arrayLimit, stringLimit));

    const result = {};
    for (const [key, item] of Object.entries(value)) {
        if (/OmittedCount$/.test(key) && Array.isArray(value[key.slice(0, -'OmittedCount'.length)])) continue;
        const reduced = Array.isArray(item)
            ? item.slice(0, arrayLimit).map((entry) => reduceJsonEvidence(entry, arrayLimit, stringLimit))
            : reduceJsonEvidence(item, arrayLimit, stringLimit);
        result[key] = reduced;
        if (Array.isArray(item) && item.length > arrayLimit) {
            const countKey = key + 'OmittedCount';
            result[countKey] = (Number(value[countKey]) || 0) + item.length - arrayLimit;
        }
    }
    return result;
}

function compactListingJsonSection(parts, maxBytes) {
    const payloadIndex = listingJsonPayloadIndex(parts);
    if (payloadIndex < 0) return false;
    let evidence;
    try {
        evidence = JSON.parse(parts[payloadIndex]);
    } catch (e) {
        return false;
    }

    let compact = JSON.stringify(evidence);
    const limit = Number.isFinite(maxBytes) ? Math.max(0, maxBytes) : Infinity;
    for (const [arrayLimit, stringLimit] of [[4, 400], [2, 200], [1, 100]]) {
        if (Buffer.byteLength(compact, 'utf8') <= limit) break;
        compact = JSON.stringify(reduceJsonEvidence(evidence, arrayLimit, stringLimit));
    }
    if (Buffer.byteLength(compact, 'utf8') > limit) {
        const candidates = Array.isArray(evidence.cardCandidates) ? evidence.cardCandidates
            : Array.isArray(evidence.cardCandidatesWeak) ? evidence.cardCandidatesWeak
                : [];
        compact = JSON.stringify({
            url: evidence.url,
            title: evidence.title,
            jsonLdTypes: evidence.jsonLdTypes,
            evidenceOmittedForBudget: true,
            cardCandidates: candidates.slice(0, 3).filter((candidate) =>
                candidate && typeof candidate === 'object').map((candidate) => ({
                selector: candidate.selector,
                count: candidate.count,
                jobTitleRatio: candidate.jobTitleRatio,
                looksLikeSectionWrapper: candidate.looksLikeSectionWrapper
            }))
        });
    }
    parts[payloadIndex] = compact;
    return true;
}

function buildTrimMarker(dropped, truncated, budget, before, overBy) {
    let m = '\n\n<!-- prompt trimmed: dropped [' + dropped.join(', ') + ']';
    if (truncated.length > 0) m += ' truncated [' + truncated.join(', ') + ']';
    m += ' to fit ' + budget + 'B budget (was ' + before + 'B)';
    if (overBy > 0) m += ' -- STILL OVER BUDGET by ' + overBy + 'B (before this marker)';
    return m + ' -->';
}

// Sacrifice ladder, applied only when the assembled prompt is over budget:
//   1. Drop "Evidence dump (sample detail page)" -- the only OPTIONAL section.
//   2. Compact valid listing JSON while preserving its evidence structure.
//   3. If the listing fixture is not JSON, truncate its body while preserving
//      the required header and code fence.
//   4. Reduce any still-oversized content, keeping every required header.
// If fixed prompt structure alone exceeds the budget, fail explicitly instead
// of returning malformed Markdown or JSON.
// Mutates `parts`. All limits and reports use UTF-8 bytes.
function trimPartsToBudget(parts, opts) {
    const o = opts || {};
    const budget = o.max || MAX_PROMPT_BYTES;
    const minEvidence = o.minEvidence === undefined ? MIN_EVIDENCE_BYTES : o.minEvidence;
    const warn = o.warn || console.warn;

    let total = Buffer.byteLength(parts.join('\n'), 'utf8');
    if (total <= budget) return parts.join('\n');

    const before = total;
    const target = budget - MARKER_RESERVE;
    const dropped = [];
    const truncated = [];

    // 1. Drop sample-detail evidence dump
    if (total > target) {
        dropSectionByHeader(parts, SAMPLE_DETAIL_HEADER, dropped);
        total = Buffer.byteLength(parts.join('\n'), 'utf8');
    }

    // 2. Compact valid listing JSON structurally, retaining evidence types.
    if (total > target) {
        const listingIndex = listingJsonPayloadIndex(parts);
        const listingBytes = listingIndex >= 0 ? Buffer.byteLength(parts[listingIndex], 'utf8') : 0;
        compactListingJsonSection(parts, target - (total - listingBytes));
        total = Buffer.byteLength(parts.join('\n'), 'utf8');
    }

    // 3. Non-JSON fixtures can only be shortened as plain text.
    if (total > target) {
        const validListing = listingJsonPayloadIndex(parts) >= 0 &&
            (() => {
                try { JSON.parse(parts[listingJsonPayloadIndex(parts)]); return true; }
                catch (e) { return false; }
            })();
        const removed = validListing ? 0 :
            truncateSectionBody(parts, LISTING_DUMP_HEADER, total - target, minEvidence);
        if (removed > 0) truncated.push(LISTING_DUMP_HEADER + ' -' + removed + 'B');
        total = Buffer.byteLength(parts.join('\n'), 'utf8');
    }

    // 4. If still over, reduce oversized blocks in place.
    if (total > target) {
        const listingIndex = listingJsonPayloadIndex(parts);
        const trimmed = parts.map((p, index) => {
            if (index !== listingIndex && typeof p === 'string' && Buffer.byteLength(p, 'utf8') > 30000) {
                return p.slice(0, 15000) + '\n<!-- truncated -->';
            }
            return p;
        });
        parts.length = 0;
        parts.push(...trimmed);
        total = Buffer.byteLength(parts.join('\n'), 'utf8');
        dropped.push('truncated-oversized-blocks');
    }

    let base = parts.join('\n');
    let marker = buildTrimMarker(dropped, truncated, budget, before, 0);
    while (Buffer.byteLength(base + marker, 'utf8') > budget) {
        const overBy = Buffer.byteLength(base + marker, 'utf8') - budget;
        const removable = Math.max(1, overBy);
        const lines = base.split('\n');
        let bodyIndex = -1;
        const listingBody = listingJsonPayloadIndex(parts);
        const listingPayload = listingBody >= 0 ? parts[listingBody] : null;
        for (let i = 0; i < lines.length; i++) {
            if (listingPayload !== null && lines[i] === listingPayload) continue;
            if (!lines[i].startsWith('## ') && !lines[i].startsWith('```') && lines[i].length > 0 &&
                (bodyIndex < 0 || lines[i].length > lines[bodyIndex].length)) bodyIndex = i;
        }
        if (bodyIndex < 0) {
            const message = '[prompt] required prompt structure exceeds the ' + budget + 'B budget.';
            warn(message);
            throw new Error(message);
        }
        const line = lines[bodyIndex];
        const keepBytes = Math.max(0, Buffer.byteLength(line, 'utf8') - removable - 1);
        let keep = Math.min(line.length, keepBytes);
        while (keep > 0 && Buffer.byteLength(line.slice(0, keep), 'utf8') > keepBytes) keep--;
        if (keep > 0 && line.charCodeAt(keep - 1) >= 0xd800 && line.charCodeAt(keep - 1) <= 0xdbff) keep--;
        lines[bodyIndex] = line.slice(0, keep);
        base = lines.join('\n');
        marker = buildTrimMarker(dropped, truncated, budget, before, 0);
    }
    return base + marker;
}

function describeSiteType(detected) {
    switch (detected.type) {
        case 'jsonld-first':
            return `The detail pages ship well-formed JSON-LD (\`${detected.evidence.jsonLdType || detected.evidence.eventJsonLdType}\`). Extract every field from JSON-LD first, fall back to HTML selectors only for fields JSON-LD omits. This is the fastest, most reliable path -- a single \`page.evaluate\` per detail page suffices.`;
        case 'listing-to-detail':
            return `The listing page exposes distinct detail links matching \`${detected.evidence.detailLinkPattern}\` (${detected.evidence.detailLinkCount} matches). Detail pages have no usable JSON-LD -- HTML extraction per page. Standard two-stage scrape: harvest listing links, then per-link navigate + extract.`;
        case 'single-page-cards':
            return `All data lives on the listing cards themselves (\`${detected.evidence.cardSelector}\`, ${detected.evidence.cardCount} matches). No detail navigation required. One \`page.evaluate\` harvests everything. Fastest pattern.`;
        case 'info_starved_cards':
            return `The cards exist (\`${detected.evidence.cardSelector}\`, ${detected.evidence.cardCount} matches) but are POINTERS, not data -- they carry title + link, but no description / company / location on the card itself. You MUST navigate to each card\u2019s detail page and extract there. Treat this like listing-to-detail even though the card structure looks single-page.`;
        case 'hub':
            return `This page is a hub: its card group (\`${detected.evidence.cardSelector}\`, ${detected.evidence.cardCount} matches, labels: ${(detected.evidence.labels || []).join(' / ')}) lists categories or departments, not individual items. If those are job departments, traverse ONE level deeper and extract from the category pages; if every category says "No Jobs", return { items: [], meta } with meta.atsEmpty = true. If they are product, service or marketing categories, answer VERDICT: NOT_CAREERS_PAGE (or CAREERS_PAGE_REDIRECT if a real listing exists elsewhere on the site). Never treat category labels as job titles. The reference example below is a structural reference only, not a hub extractor.`;
        case 'single-posting':
            return `The entry page has no repeating card list, and its JSON-LD (${((detected.evidence && detected.evidence.jsonLdTypes) || []).join(', ')}) describes a single posting. Extract exactly ONE item from this page, JSON-LD first, with url set to the entry URL. Do not invent a list. If the page is a company or product page rather than one posting, answer VERDICT: NOT_CAREERS_PAGE. The reference example below is JSON-LD driven; adapt it to return one item.`;
        case 'unknown-shape':
            return `No card list, no distinct detail links and no usable JSON-LD were found. The page shape is unknown; do not assume a listing-to-detail or single-page-cards layout. Run the empty-state check first, then extract only what the raw HTML actually shows. If nothing role-shaped exists, return { items: [], meta } with meta.atsEmpty = true, or answer VERDICT: NOT_CAREERS_PAGE. The reference example below is a structural reference only.${detected.evidence && detected.evidence.emptyState ? ' The page text contains an empty-state phrase (for example "no positions available").' : ''}`;
        default:
            return `No clear pattern detected. Consider whether the entry URL needs a stage transition first (home -> category -> listing), or whether the site needs scrolling to reveal cards. Read the evidence dump carefully and confirm what you\u2019re looking at before writing code.`;
    }
}

function buildAssumptionsSection(detected, listing, detail) {
    const lines = [];
    const s = detected.signals || {};

    lines.push(`- **Site type:** \`${detected.type}\``);
    if (s.hasJsonLd) lines.push(`- **JSON-LD on listing:** yes`);
    if (s.hasDetailJsonLd) lines.push(`- **JSON-LD on detail:** yes`);
    // Card wrapper comes from cardCandidates (chrome-filtered heuristic).
    // cardGroups is deliberately NOT consulted: it includes script/link/style
    // and contradicted the anti-patterns section (bug 2). No candidates,
    // no line.
    const topCandidate = (listing && Array.isArray(listing.cardCandidates)) ? listing.cardCandidates[0] : null;
    if (topCandidate && topCandidate.selector) {
        let cardLine = '- **Card wrapper:** `' + topCandidate.selector + '` (' + topCandidate.count + ' instances';
        if (typeof topCandidate.jobTitleRatio === 'number') cardLine += ', jobTitleRatio ' + topCandidate.jobTitleRatio;
        cardLine += ')';
        if (topCandidate.looksLikeSectionWrapper) cardLine += ' -- verify, may be a section wrapper';
        lines.push(cardLine);
    }
    if (detected.evidence && detected.evidence.detailLinkPattern) {
        lines.push(`- **Detail-link pattern:** \`${detected.evidence.detailLinkPattern}\` (${detected.evidence.detailLinkCount} matches)`);
    }
    if (detail) {
        if (detail.headings && detail.headings[0]) {
            lines.push(`- **Detail title element:** \`${detail.headings[0].tag}${detail.headings[0].cls ? '.' + detail.headings[0].cls.split(/\s+/)[0] : ''}\``);
        }
        if (detail.descriptionSelector) {
            lines.push(`- **Longest description candidate:** \`${detail.descriptionSelector}\` (${detail.descriptionSampleLength} chars)`);
        }
    }

    return lines.join('\n');
}

module.exports = { buildPrompt, loadReference, trimPartsToBudget, MAX_PROMPT_BYTES, MIN_EVIDENCE_BYTES };
