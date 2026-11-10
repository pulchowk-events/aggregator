// scripts/wizard/prompt.js
// Generates the paste-ready LLM prompt. Embeds the dump, the site-type
// detection, the extractor contract, and one full reference extractor
// (whichever matches the detected site type) so the LLM has both the
// evidence and a worked example.

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
        return { path: ref, code: '// Reference example not found — read src/scrapers/extractors/README.md instead.' };
    }
}

function buildPrompt({ name, type, url, listing, detail, detected }) {
    const ref = loadReference(detected.type);

    return `# Extractor task: ${name} (${type})

You are generating a scraper extractor for a Puppeteer-based Discord bot.
The extractor's job is to visit the given site through a headless browser
and return a structured array of items. Everything else (browser
lifecycle, retry, sanitization, progress reporting, diagnostics) is
handled by the bot's orchestration layer — you write ONLY the extract()
function body.

## Target

- Name: \`${name}\`
- Type: \`${type}\`
- Entry URL: ${url}

## Detected site type: \`${detected.type}\`

${describeSiteType(detected)}

## Before you write code — confirm these assumptions

${buildAssumptionsSection(detected, listing, detail)}

If ANY assumption above is wrong, **correct it first**, then proceed.
Do not write code against a wrong assumption.

## The contract

\`\`\`js
module.exports = {
    // Optional. Runs once per item after extraction, before common
    // sanitization. Return the possibly-mutated item.
    preprocessItem(item) { return item; },

    // Required. Do all browser work here. Return { items, meta }.
    async extract(page, { progress, meta }) {
        // meta fields to mutate as you go:
        //   meta.pagesVisited          — every page.goto() call
        //   meta.listingHits           — total anchor matches across listings
        //   meta.detailPagesVisited    — subset of pages that were detail pages
        //   meta.detailParseFailures   — detail pages that yielded no title
        //   meta.looksBlocked          — set true if the page looks captcha'd
        //
        // progress fields to report:
        //   safeDiscovered(progress, n)   — after finding n links on a listing
        //   safeUnitDone(progress)        — inside the finally block per item
        //
        // Always call safeUnitDone in finally so a failed item still
        // advances the ETA.
        return { items, meta };
    }
};
\`\`\`

## Available helpers

\`\`\`js
const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne, pickAll } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');
const { sanitizeScrapedEvent, sanitizeImageUrl } = require('../../sanitize');
const { trimDescriptionToLastSentence, cleanDescriptionText } = require('../../text');
\`\`\`

- \`pickOne(page, [selector1, selector2, ...], { label })\` — tries each
  selector in order, returns the first non-empty \`{ value, selector, fellBack }\`.
  Use for every field extraction so selector drift is caught early.
- \`pickAll(page, [selector1, ...], { label, attr = 'href' })\` — same,
  but returns \`{ values, count, selector, fellBack }\` for lists of matches.
- \`detectPageState(page)\` — returns \`{ looksBlocked, bodySnippet }\`. Call
  once on the FIRST page load (Cloudflare/captcha check).
- \`__resolveImageSrc(imgEl)\` — already injected into every page. Handles
  lazy-load (data-src, srcset, etc.) and strips placeholders. Call it
  inside \`page.evaluate\` on any \`<img>\` element.

## Item shape (what each object should look like)

\`\`\`js
{
    id: string,              // unique; pattern '<name>-<timestamp>-<rand>'
    title: string,           // required, or the item is dropped
    description: string,     // trimmed later by orchestrator, but strip HTML here
    date: string|null,       // ISO preferred; any parseable format is OK
    time: string|null,       // e.g. "18:00" or "6 PM"
    location: string|null,
    price: string|null,      // "Free", "Rs. 500", "TBD" if unknown
    organizer: string|null,
    category: string|null,   // site's category, not the bot's classified one
    tags: string[],          // free-form tags from the site
    image: string|null,      // absolute URL
    url: string,             // the page you scraped
    registrationUrl: string|null,  // separate register link if the site has one
    attendanceMode: string|null,   // 'online' | 'in-person' | 'hybrid'
    source: '${name}'
}
\`\`\`

For \`${type}\` items that map to a different domain shape (jobs,
scholarships), see \`src/scrapers/jobs.js\` and
\`src/scrapers/scholarships.js\` for the additional fields.

## Reference example — a working ${detected.type} extractor

\`\`\`js
// ${ref.path}
${ref.code}
\`\`\`

## Evidence dump (listing page)

\`\`\`json
${JSON.stringify(listing, null, 2)}
\`\`\`

${detail ? `## Evidence dump (sample detail page)

\`\`\`json
${JSON.stringify(detail, null, 2)}
\`\`\`
` : ''}

## What to output

One code block, ready to paste over
\`src/scrapers/extractors/${type}/${name}.js\`. Nothing else. No
explanation before or after. The full module body including all requires.

## Edge cases to handle

- **Empty result** — if the listing genuinely has no items, return
  \`{ items: [], meta }\` with \`meta.listingHits = 0\`. Don't throw.
- **Cloudflare / captcha** — call \`detectPageState(page)\` on the first
  page load. If \`looksBlocked\`, set \`meta.looksBlocked = true\` and
  return early.
- **Missing detail fields** — populate whatever the page gives you;
  leave the rest null. The orchestrator + sanitizer will flag
  suspicious values.
- **Paginated listings** — follow the site's own pagination (Next link
  or ?page=N). Cap at 10 pages unless you have strong reason to go further.
- **Virtualized/infinite scroll** — scroll the scroll-container in steps
  and harvest after each. See katajaam.js or sathijob.js for reference.
- **JSON-LD present but incomplete** — prefer JSON-LD where it exists,
  fall back to HTML selectors for missing fields.
- **Multi-stage navigation** — if the entry URL leads to a category
  selector or a homepage (not a direct listing), navigate through it
  first, then proceed. Detect the stage transition and note it in
  comments.
- **Retries** — the orchestrator already retries the whole extract() call
  on failure. Do NOT add per-page retry inside extract(). Use plain
  \`page.goto(url, { timeout: 30000 })\`.

Do not invent selectors you have not seen in the evidence dump. If a
field cannot be extracted with confidence, leave it null and note the
limitation in a comment above the extraction line.
`;
}

function describeSiteType(detected) {
    switch (detected.type) {
        case 'jsonld-first':
            return `The detail pages ship well-formed JSON-LD (\`${detected.evidence.eventJsonLdType}\`). Extract every field from JSON-LD first, fall back to HTML selectors only for fields JSON-LD omits. This is the fastest, most reliable path — a single \`page.evaluate\` per detail page suffices.`;
        case 'listing-to-detail':
            return `The listing page exposes distinct detail links matching \`${detected.evidence.detailLinkPattern}\` (${detected.evidence.detailLinkCount} matches). Detail pages have no usable JSON-LD — HTML extraction per page. Standard two-stage scrape: harvest listing links, then per-link navigate + extract.`;
        case 'single-page-cards':
            return `All data lives on the listing cards themselves (\`${detected.evidence.cardSelector}\`, ${detected.evidence.cardCount} matches). No detail navigation required. One \`page.evaluate\` harvests everything. Fastest pattern.`;
        default:
            return `No clear pattern detected. Consider whether the entry URL needs a stage transition first (home → category → listing), or whether the site needs scrolling to reveal cards. Read the evidence dump carefully and confirm what you're looking at before writing code.`;
    }
}

function buildAssumptionsSection(detected, listing, detail) {
    const lines = [];
    const s = detected.signals;

    lines.push(`- **Site type:** \`${detected.type}\``);
    if (s.hasJsonLd) lines.push(`- **JSON-LD on listing:** yes (${listing.jsonLdTypes.join(', ')})`);
    if (s.hasDetailJsonLd) lines.push(`- **JSON-LD on detail:** yes`);
    if (s.hasCardWrapper) lines.push(`- **Card wrapper:** \`${listing.cardGroups[0].selector}\` (${listing.cardGroups[0].count} instances)`);
    if (detected.evidence.detailLinkPattern) lines.push(`- **Detail-link pattern:** \`${detected.evidence.detailLinkPattern}\` (${detected.evidence.detailLinkCount} matches)`);
    if (s.isPaginated) lines.push(`- **Pagination:** yes (${listing.pagination.hasNextRel ? 'Next link, ' : ''}${listing.pagination.pageParamCount > 0 ? `${listing.pagination.pageParamCount} page-param links, ` : ''}${listing.pagination.hasNextRel || listing.pagination.pageParamCount > 0 ? 'real pagination' : 'detected'})`);
    if (s.isVirtualized) lines.push(`- **Virtualized/infinite scroll:** yes (Load more button present)`);
    if (s.hasCategories) lines.push(`- **Category chips:** ${listing.categoryChips.length} detected — sample: ${listing.categoryChips.slice(0, 3).map(c => `"${c.text}"`).join(', ')}`);

    if (detail) {
        if (detail.headings && detail.headings[0]) {
            lines.push(`- **Detail title element:** \`${detail.headings[0].tag}${detail.headings[0].cls ? '.' + detail.headings[0].cls.split(/\s+/)[0] : ''}\``);
        }
        if (detail.descriptionSelector) {
            lines.push(`- **Longest description candidate:** \`${detail.descriptionSelector}\` (${detail.descriptionSampleLength} chars)`);
        }
        if (detail.images && detail.images[0]) {
            lines.push(`- **First non-logo image:** \`${detail.images[0].src.slice(0, 80)}\``);
        }
    }

    return lines.join('\n');
}

module.exports = { buildPrompt };
