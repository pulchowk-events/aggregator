// src/scrapers/extractors/jobs/skybase.js
// Site-specific extractor. See ../README.md for the contract.
//
// VERDICT: CAREERS_PAGE
//
// CONFIRMED shape (real evidence, no correction needed this time):
//   - 5 open roles listed as `a.careers-job[href]` cards with
//     `href="/careers/<slug>"`. This IS listing-to-detail.
//   - Card title: `.careers-job-title` (h2).
//   - Card meta block: `.careers-job-meta` / `.careers-job-tag`
//     (INTERNSHIPS / MARKETING) plus optional "N OPENINGS" line.
//   - Filter chips: `button.careers-chip[data-filter]` (with counts).
//   - Company chrome: og:site_name = "Skybase Innovations";
//     og:title / og:description say "Pokhara, Nepal"; body line
//     "Pokhara, Nepal � On-site & hybrid".
//   - Detail page: H1 (wizard's detail title hint) + description
//     container `div.container.text-white.pt-5.pb-3.mt-5` (3842 chars,
//     per wizard's longest-description candidate).
//
// Card wrapper `script` (16) is <script> tags -- ignore. The wizard's
// "detail-link pattern `/`" was a false lead (logo + nav anchors); the
// real per-job pattern is `/careers/<slug>`, visible in cardCandidates.
//
// Strategy:
//   1. Load /careers, block-check, scroll past the openings section
//      so any lazy filter chips settle (server-rendered, so this is
//      mostly a safety step).
//   2. Harvest `a.careers-job[href]` cards with title, tag, openings.
//   3. Per-card: navigate to `/careers/<slug>`, extract H1 +
//      description from div.container.text-white.pt-5.pb-3.mt-5
//      (fallback: main, [class*="content"], [class*="job-body"]).
//      If the detail load fails or H1 is missing, fall back to the
//      card title and leave description_status = extraction_failed
//      only if an element was actually present on the detail page.
//   4. Classify employmentType from the card tag and detail body:
//      INTERNSHIPS -> internship; MARKETING / DESIGN / QA /
//      DEVELOPMENT / MANAGEMENT -> keep tag as category, not type;
//      full/part/contract detected in prose when present.
//   5. Location: try detail-page `[class*="location"]`; else the
//      careers-page "Pokhara, Nepal" hint; default "Pokhara, Nepal".
//   6. Company = "Skybase Innovations" (og:site_name).
//
// Selector-drift log:
//   2026-11-15: initial. Card class `.careers-job` + title `.careers-job-title`
//               confirmed in evidence; category via `data-category`
//               attribute and `.careers-job-tag`.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { trimDescriptionToLastSentence, cleanDescriptionText } = require('../../text');

const CAREERS_URL = 'https://www.skybase.com.np/careers';
const SOURCE = 'skybase';
const COMPANY = 'Skybase Innovations';
const COMPANY_EVIDENCE =
    'og:site_name = "Skybase Innovations"';
const DEFAULT_LOCATION = 'Pokhara, Nepal';

// Detail-page description container per wizard's longest-description
// candidate. Only used as one of several fallbacks.
const SEL = {
    listingCard: ['a.careers-job[href]'],
    cardTitle: ['.careers-job-title', '[class*="job-title"]', 'h2'],
    cardTag: ['.careers-job-tag', '[class*="job-tag"]'],
    cardMeta: ['.careers-job-meta', '[class*="job-meta"]'],
    detailTitle: ['h1', '.careers-job-title', 'main h1'],
    detailBody: [
        'div.container.text-white.pt-5.pb-3.mt-5',
        'main [class*="content"]',
        '[class*="job-body"]',
        'main',
        'article'
    ],
    detailLocation: [
        '[class*="location"]',
        '[class*="job-location"]',
        '[class*="job-meta"]'
    ]
};

function classifyEmploymentFromText(txt) {
    if (!txt) return null;
    const l = txt.toLowerCase();
    if (/\bintern(ship)?s?\b/.test(l)) return 'internship';
    if (/\bfull[\s-]?time\b/.test(l)) return 'full-time';
    if (/\bpart[\s-]?time\b/.test(l)) return 'part-time';
    if (/\bcontract(?:or)?\b/.test(l)) return 'contract';
    return null;
}

function classifySalary(txt) {
    if (!txt) return null;
    const m = txt.match(
        /(?:NPR|Rs\.?|USD|\$)\s?[\d,]+(?:\s?[--]\s?(?:NPR|Rs\.?|USD|\$)?\s?[\d,]+)?(?:\s?(?:k|K|per month|\/month|per year|\/year|annum))?/i
    );
    return m ? m[0].trim() : null;
}

function slugify(s) {
    return String(s || 'role')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'role';
}

async function harvestCards(page) {
    return page.evaluate(() => {
        const out = [];
        const seen = new Set();
        document.querySelectorAll('a.careers-job[href]').forEach((a) => {
            const href = a.getAttribute('href');
            if (!href) return;
            let abs;
            try { abs = new URL(href, window.location.href); } catch (e) { return; }
            if (abs.host !== window.location.host) return;
            if (!/^\/careers\//i.test(abs.pathname)) return;

            const titleEl = a.querySelector('.careers-job-title, [class*="job-title"], h2, h3');
            const title = titleEl ? (titleEl.textContent || '').trim().replace(/\s+/g, ' ') : null;
            if (!title) return;

            const tagEl = a.querySelector('.careers-job-tag, [class*="job-tag"]');
            const tag = tagEl ? (tagEl.textContent || '').trim() : null;

            const metaEl = a.querySelector('.careers-job-meta, [class*="job-meta"]');
            const metaText = metaEl ? (metaEl.innerText || '').trim() : null;

            const dataCategory = a.getAttribute('data-category') || null;

            // Look for "N OPENINGS" inside the meta block.
            let openings = null;
            if (metaText) {
                const m = metaText.match(/(\d+)\s+OPENINGS?/i);
                if (m) openings = parseInt(m[1], 10) || null;
            }

            const key = abs.pathname + '|' + title.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);

            out.push({
                url: abs.toString(),
                title,
                tag,
                metaText,
                dataCategory,
                openings
            });
        });
        return out;
    });
}

async function readDetail(page) {
    return page.evaluate((detailBodySelectors) => {
        const main = document.querySelector('main') || document.body;
        const h1 = main.querySelector('h1') || document.querySelector('h1');
        const title = h1 ? (h1.textContent || '').trim() : null;

        let description = null;
        let matchedSelector = null;
        for (const sel of detailBodySelectors) {
            try {
                const el = document.querySelector(sel);
                if (!el) continue;
                const t = (el.innerText || el.textContent || '').trim();
                if (t.length > 200) {
                    description = t;
                    matchedSelector = sel;
                    break;
                }
            } catch (e) { /* invalid selector */ }
        }
        if (!description) {
            const ps = Array.from(main.querySelectorAll('p'));
            const joined = ps.map((p) => (p.innerText || '').trim()).filter(Boolean).join('\n\n');
            if (joined.length > 150) description = joined;
        }

        let location = null;
        const locEl = main.querySelector(
            '[class*="location"], [class*="job-location"]'
        );
        if (locEl) {
            const t = (locEl.textContent || '').trim();
            if (t && t.length < 100) location = t;
        }

        let logo = null;
        const hdrImg = document.querySelector('header img, .navbar-brand img, .site-header-brand img');
        if (hdrImg) {
            try {
                logo = window.__resolveImageSrc
                    ? window.__resolveImageSrc(hdrImg)
                    : (hdrImg.currentSrc || hdrImg.src);
            } catch (e) { logo = hdrImg.src || null; }
        }

        return {
            title,
            description,
            matchedSelector,
            location,
            bodyText: (main.innerText || '').slice(0, 10000),
            logo,
            finalUrl: window.location.href
        };
    }, SEL.detailBody);
}

module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        const items = [];

        // ---- 1. Load listing ---------------------------------------------
        try {
            meta.pagesVisited++;
            await loadPage(page, CAREERS_URL);
            await delay(900 + Math.random() * 700);
        } catch (e) {
            console.warn(`[${SOURCE}] careers page load failed: ${e.message}`);
            return { items, meta };
        }

        // ---- 2. Block detection ------------------------------------------
        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`[${SOURCE}] blocked: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        // ---- 3. Gentle scroll to settle the filter chips -----------------
        try {
            await page.evaluate(async () => {
                const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
                let y = 0;
                while (y < h) {
                    window.scrollTo(0, y);
                    y += 600;
                    await sleep(70);
                }
                window.scrollTo(0, 0);
            });
            await delay(400 + Math.random() * 300);
        } catch (e) { /* best-effort */ }

        // ---- 4. Harvest cards --------------------------------------------
        let cards = [];
        try { cards = await harvestCards(page); } catch (e) { /* best-effort */ }
        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);

        if (cards.length === 0) {
            meta.atsEmpty = true;
            console.log(`  [${SOURCE}] extracted 0 (no careers-job cards)`);
            return { items, meta };
        }

        // ---- 5. Per-card detail extraction ------------------------------
        for (const c of cards) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await loadPage(page, c.url);
                await delay(600 + Math.random() * 500);

                let d = null;
                try { d = await readDetail(page); } catch (e) { d = null; }

                const detailTitle = d && d.title ? d.title : null;
                const finalTitle = detailTitle || c.title;

                // Skip the page's own h1 if it accidentally reads "Open positions".
                const cleanTitle =
                    finalTitle && /^open positions?$/i.test(finalTitle)
                        ? c.title
                        : finalTitle;

                if (!cleanTitle) {
                    meta.detailParseFailures++;
                    continue;
                }

                let description = d && d.description ? d.description : null;
                let descriptionStatus;
                let descriptionEvidence;
                if (description) {
                    try {
                        description = trimDescriptionToLastSentence(
                            cleanDescriptionText(description), 6000
                        );
                    } catch (e) { /* keep raw */ }
                    descriptionStatus = 'extracted';
                    descriptionEvidence =
                        `detail page prose block matched selector: ${d.matchedSelector || 'p paragraphs'}`;
                } else {
                    descriptionStatus = 'extraction_failed';
                    descriptionEvidence =
                        'detail page reached but no prose block > 200 chars in '
                        + SEL.detailBody.join(' | ');
                }

                const combined = [
                    d && d.bodyText,
                    description,
                    c.metaText,
                    c.tag
                ].filter(Boolean).join(' ');

                // Employment type: prefer card tag INTERNSHIPS, else regex in body.
                let employmentType = null;
                let employmentTypeEvidence = null;
                if (c.tag && /intern/i.test(c.tag)) {
                    employmentType = 'internship';
                    employmentTypeEvidence =
                        'card careers-job-tag "' + c.tag + '"';
                }
                if (!employmentType) {
                    const fromBody = classifyEmploymentFromText(combined);
                    if (fromBody) {
                        employmentType = fromBody;
                        employmentTypeEvidence =
                            'full/part/contract/intern regex in detail body';
                    }
                }

                // Category: data-category on card, else the tag.
                const rawCategory = c.dataCategory || c.tag || null;
                const category = rawCategory ? rawCategory.toLowerCase() : null;

                // Location
                const location =
                    (d && d.location) || DEFAULT_LOCATION;
                const locationStatus = d && d.location ? 'extracted' : 'site_absent';
                const locationEvidence = d && d.location
                    ? '[class*="location"] on detail page'
                    : 'careers page body: "Pokhara, Nepal � On-site & hybrid"; '
                      + 'no per-role location element on detail page';

                // Salary: from prose only
                const salary = classifySalary(combined);
                const salaryStatus = salary ? 'extracted' : 'site_absent';
                const salaryEvidence = salary
                    ? 'currency regex in detail body'
                    : 'no salary string on careers card or detail page';

                // Openings: from card metaText, else null
                const openings = c.openings || null;

                // Image: careers chips use SVG category icons, not per-role images
                const logo = (d && d.logo) || null;

                items.push({
                    id: `${SOURCE}-${slugify(cleanTitle)}-${Date.now()}-`
                        + Math.random().toString(36).slice(2, 6),

                    title: cleanTitle,
                    company: COMPANY,
                    company_status: 'extracted',
                    company_evidence: COMPANY_EVIDENCE,

                    description: description || null,
                    description_status: descriptionStatus,
                    description_evidence: descriptionEvidence,

                    location,
                    location_status: locationStatus,
                    location_evidence: locationEvidence,

                    employmentType,
                    employmentType_status: employmentType ? 'extracted' : 'site_absent',
                    employmentType_evidence: employmentType
                        ? employmentTypeEvidence
                        : 'careers card tag and detail body publish no full/part/contract marker',

                    salary,
                    salary_status: salaryStatus,
                    salary_evidence: salaryEvidence,

                    applicationEndsRaw: null,
                    applicationEnds_status: 'site_absent',
                    applicationEnds_evidence:
                        'no apply-by / closing-date element on careers card or detail page',

                    image: logo,
                    image_status: logo ? 'extracted' : 'site_absent',
                    image_evidence: logo
                        ? 'header site logo on detail page'
                        : 'careers cards show SVG category icons, not per-role images',

                    openings,
                    openings_status: openings ? 'extracted' : 'site_absent',
                    openings_evidence: openings
                        ? 'careers-job-meta "N OPENINGS"'
                        : 'card meta did not publish an openings count',

                    date: null,
                    time: null,
                    price: null,
                    organizer: COMPANY,
                    category: category || 'engineering',
                    tags: [category, 'skybase', 'pokhara']
                        .filter(Boolean)
                        .map((t) => String(t).toLowerCase()),
                    url: (d && d.finalUrl) || c.url,
                    registrationUrl: (d && d.finalUrl) || c.url,
                    attendanceMode: 'in-person',
                    source: SOURCE
                });
            } catch (e) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        if (items.length === 0) meta.atsEmpty = true;

        console.log(`  [${SOURCE}] extracted ${items.length}`);
        return { items, meta };
    }
};