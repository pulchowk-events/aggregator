// scripts/wizard/prompt.js
// Generates the paste-ready LLM prompt. Embeds the dump, the site-type
// detection, the extractor contract, the field requirements, per-field
// DOM evidence, and one full reference extractor.

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

const REFERENCE_EXAMPLES = {
    'single-page-cards': 'src/scrapers/extractors/events/khalti.js',
    'listing-to-detail': 'src/scrapers/extractors/events/katajaam.js',
    'jsonld-first':      'src/scrapers/extractors/events/nepvents.js',
    'unknown':           'src/scrapers/extractors/events/katajaam.js'
};

function loadReference(detectedType) {
    const ref = REFERENCE_EXAMPLES[detectedType] || REFERENCE_EXAMPLES.unknown;
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
    const ref = loadReference(detected.type);

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
    parts.push(JSON.stringify(listing, null, 2));
    parts.push('```');
    parts.push('');
    if (detail) {
        parts.push('## Evidence dump (sample detail page)');
        parts.push('');
        parts.push('```json');
        parts.push(JSON.stringify(detail, null, 2));
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
    parts.push(`- **Logging** -- log ONCE at the end of extract(), e.g. \`console.log('  [${name}] extracted ' + items.length)\`. Do NOT log inside per-item loops.`);
    parts.push('');
    parts.push('Do not invent selectors you have not seen in the field evidence. If a field cannot be extracted with confidence, use `<field>_status: "extraction_failed"` with the selector you tried.');
    parts.push('');

    return parts.join('\n');
}

function describeSiteType(detected) {
    switch (detected.type) {
        case 'jsonld-first':
            return `The detail pages ship well-formed JSON-LD (\`${detected.evidence.eventJsonLdType}\`). Extract every field from JSON-LD first, fall back to HTML selectors only for fields JSON-LD omits. This is the fastest, most reliable path -- a single \`page.evaluate\` per detail page suffices.`;
        case 'listing-to-detail':
            return `The listing page exposes distinct detail links matching \`${detected.evidence.detailLinkPattern}\` (${detected.evidence.detailLinkCount} matches). Detail pages have no usable JSON-LD -- HTML extraction per page. Standard two-stage scrape: harvest listing links, then per-link navigate + extract.`;
        case 'single-page-cards':
            return `All data lives on the listing cards themselves (\`${detected.evidence.cardSelector}\`, ${detected.evidence.cardCount} matches). No detail navigation required. One \`page.evaluate\` harvests everything. Fastest pattern.`;
        case 'info_starved_cards':
            return `The cards exist (\`${detected.evidence.cardSelector}\`, ${detected.evidence.cardCount} matches) but are POINTERS, not data -- they carry title + link, but no description / company / location on the card itself. You MUST navigate to each card\u2019s detail page and extract there. Treat this like listing-to-detail even though the card structure looks single-page.`;
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
    if (s.hasCardWrapper && listing.cardGroups && listing.cardGroups[0]) {
        lines.push(`- **Card wrapper:** \`${listing.cardGroups[0].selector}\` (${listing.cardGroups[0].count} instances)`);
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

module.exports = { buildPrompt };
