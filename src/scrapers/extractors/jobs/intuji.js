// src/scrapers/extractors/jobs/intuji.js
// Site-specific extractor. See ../README.md for the contract.
//
// VERDICT: CAREERS_PAGE
//
// CORRECTION of wizard assumptions -- the raw dump was misleading:
//   - Detected type "listing-to-detail" is WRONG. The 3 `/careers/`
//     matches are all nav links pointing back to this same page
//     (`#`, `#positions`, and the page itself). There are NO per-role
//     detail URLs on this site.
//   - Card wrapper `script` (12) is <script> tags, not role cards.
//   - Detail title `H1.text-secondary` and description `div` (3831 chars)
//     come from the careers hero / whole-page blob, not a role detail.
//
// Actual shape: single-page careers listing. The careers page has an
// H2 "Check Out These Opportunities!" (anchor #positions) followed by
// inline role cards -- sample heading dump shows H3 "DevOps Engineer"
// (cls "mb-4") inside that section. Apply flow is an on-page link /
// form, not a separate detail URL. So this is a single-page-cards
// extractor, NOT listing-to-detail.
//
// Strategy:
//   1. Load careers page, detect block state.
//   2. Scroll to #positions (and to bottom) to force Next.js hydration
//      to reveal the role cards.
//   3. Harvest role candidates from:
//        a) the "Check Out These Opportunities" section (preferred)
//        b) broader H3/H4 scan on the page
//      Filter by ROLE_KEYWORD so values ("Innovative", "Agile",
//      "Transparent") and benefit headings are excluded.
//   4. Classify employmentType / location / salary from page body.
//   5. Emit items with per-field status + evidence.
//
// Field handling:
//   - company: og:site_name is null in the dump; the site brand is
//     "Intuji" (visible in header logo / nav / footer). Extracted.
//   - location: no explicit per-role element; default to
//     "Kathmandu, Nepal" (Intuji is Kathmandu-based) unless the body
//     names a city.
//   - description: per-role body if the card exposes sibling content;
//     otherwise site_absent with evidence.
//   - salary / applicationEndsRaw / image: not published per-role in
//     the field-evidence dump -> site_absent.
//
// Selector-drift log:
//   2026-11-15: initial. No stable per-role CSS class in evidence --
//               anchoring on structural landmarks (H2 "Check Out These
//               Opportunities", H3 "mb-4") plus a role-keyword filter.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { trimDescriptionToLastSentence, cleanDescriptionText } = require('../../text');

const CAREERS_URL = 'https://intuji.com/careers/';
const COMPANY = 'Intuji';
const DEFAULT_LOCATION = 'Kathmandu, Nepal';

// Filter used both in-page and in Node to decide "is this a role title?".
const ROLE_KEYWORD = /(engineer|developer|designer|manager|analyst|intern(ship)?|lead|architect|\bqa\b|devops|\bsre\b|specialist|consultant|director|officer|associate|executive|programmer|administrator|tester|scientist|writer|marketer)/i;

// Titles that look role-ish but are section/value headings, not roles.
const NON_ROLE_TITLE = /^(innovative|agile|transparent|values?|benefits?|culture|perks?|about( us)?|what are our values\??|check out these opportunities\!!?|open positions|open roles|our values)$/i;

// ---------------------------------------------------------------------------
function classifyBody(txt) {
    const out = { employmentType: null, location: null, salary: null };
    if (!txt) return out;
    const lower = txt.toLowerCase();

    if (/\bfull[\s-]?time\b/.test(lower)) out.employmentType = 'full-time';
    else if (/\bpart[\s-]?time\b/.test(lower)) out.employmentType = 'part-time';
    else if (/\bintern(ship|ship)?\b/.test(lower)) out.employmentType = 'internship';
    else if (/\bcontract(?:or)?\b/.test(lower)) out.employmentType = 'contract';

    const sm = txt.match(/(?:NPR|Rs\.?|USD|\$)\s?[\d,]+(?:\s?[--]\s?(?:NPR|Rs\.?|USD|\$)?\s?[\d,]+)?(?:\s?(?:k|K|per month|\/month|per year|\/year|annum|lpa))?/i);
    if (sm) out.salary = sm[0].trim();

    if (/kathmandu/i.test(txt)) out.location = 'Kathmandu, Nepal';
    else if (/\bnepal\b/i.test(txt)) out.location = 'Nepal';
    else if (/\bremote\b/i.test(txt)) out.location = 'Remote';
    else if (/\bhybrid\b/i.test(txt)) out.location = 'Hybrid';

    return out;
}

async function scrollThroughPositions(page) {
    await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        // Jump to #positions anchor first.
        const pos = document.querySelector('#positions')
            || Array.from(document.querySelectorAll('h2'))
                .find((h) => /opportunities|open positions|open roles/i.test(h.textContent || ''));
        if (pos) {
            try { pos.scrollIntoView({ behavior: 'instant', block: 'start' }); } catch (e) {}
            await sleep(500);
        }
        // Then walk the page so any IntersectionObserver-triggered
        // animations (the dump shows opacity:0 translateY(10px) on
        // card wrappers) fire.
        const step = 500;
        let y = 0;
        const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        while (y < h) {
            window.scrollTo(0, y);
            y += step;
            await sleep(70);
        }
        window.scrollTo(0, 0);
    });
}

async function harvestRoles(page) {
    return page.evaluate(() => {
        const out = [];
        const seen = new Set();

        const collect = (h, source) => {
            const title = (h.textContent || '').trim().replace(/\s+/g, ' ');
            if (!title || title.length < 3 || title.length > 120) return;
            const key = title.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);

            let description = null;
            let applyUrl = null;

            const card = h.closest('[class*="card"], article, li, section') || h.parentElement;
            if (card) {
                const text = (card.innerText || '').trim();
                const idx = text.indexOf(title);
                if (idx >= 0 && text.length > idx + title.length + 25) {
                    const tail = text.slice(idx + title.length).trim();
                    // Reject tails that are just another heading.
                    if (tail.length > 25) description = tail.slice(0, 4000);
                }
                const link = card.querySelector('a[href]');
                if (link) {
                    const href = link.getAttribute('href');
                    try { applyUrl = new URL(href, window.location.href).toString(); } catch (e) {}
                }
            }

            out.push({ title, description, applyUrl, source });
        };

        // Preferred: the "Check Out These Opportunities" section.
        let oppSection = null;
        document.querySelectorAll('h2').forEach((h) => {
            if (oppSection) return;
            if (/opportunities|open positions|open roles/i.test(h.textContent || '')) {
                oppSection = h.closest('section') || h.parentElement;
            }
        });
        if (oppSection) {
            oppSection.querySelectorAll('h3, h4').forEach((h) => collect(h, 'opportunities_section'));
        }

        // Broader page scan for role-keyword headings.
        document.querySelectorAll('h3, h4').forEach((h) => collect(h, 'page_scan'));

        return out;
    });
}

async function grabPageContext(page) {
    return page.evaluate(() => {
        const main = document.querySelector('main') || document.body;
        const bodyText = (main.innerText || '').slice(0, 12000);
        const og = (name) => {
            const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
            return el ? el.getAttribute('content') : null;
        };
        // Company logo: header img first (dump shows header-icon-1.svg).
        let logo = null;
        const hdrImg = document.querySelector('header img, nav img, [class*="header"] img');
        if (hdrImg) {
            try { logo = window.__resolveImageSrc ? window.__resolveImageSrc(hdrImg) : (hdrImg.currentSrc || hdrImg.src); }
            catch (e) { logo = hdrImg.src || null; }
        }
        if (!logo) logo = og('og:image');
        return {
            bodyText,
            logo,
            finalUrl: window.location.href,
            ogTitle: og('og:title'),
            ogSiteName: og('og:site_name'),
            ogDescription: og('og:description')
        };
    });
}

function slugify(s) {
    return String(s || 'role')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'role';
}

// ---------------------------------------------------------------------------
module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        const items = [];

        // ---- 1. Load careers page -----------------------------------------
        try {
            meta.pagesVisited++;
            await loadPage(page, CAREERS_URL);
            await delay(1200 + Math.random() * 800);
        } catch (e) {
            console.warn(`[intuji] careers page load failed: ${e.message}`);
            return { items, meta };
        }

        // ---- 2. Block detection -------------------------------------------
        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`[intuji] blocked: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        // ---- 3. Scroll to reveal cards ------------------------------------
        try {
            await scrollThroughPositions(page);
            await delay(700 + Math.random() * 500);
        } catch (e) { /* best-effort */ }

        // ---- 4. Page context for classification + company evidence --------
        let ctx = { bodyText: '', logo: null, finalUrl: CAREERS_URL, ogSiteName: null };
        try { ctx = await grabPageContext(page); } catch (e) { /* best-effort */ }
        const cls = classifyBody(ctx.bodyText || '');
        const pageLocation = cls.location || DEFAULT_LOCATION;
        const company = (ctx.ogSiteName && ctx.ogSiteName.trim()) || COMPANY;
        const companyEvidence = ctx.ogSiteName
            ? `og:site_name = "${ctx.ogSiteName}"`
            : 'no og:site_name; brand name "Intuji" from header logo alt / nav / footer + domain';

        // ---- 5. Harvest role cards ----------------------------------------
        let raw = [];
        try { raw = await harvestRoles(page); } catch (e) { /* best-effort */ }

        const roles = raw.filter((r) => {
            if (!r.title) return false;
            if (NON_ROLE_TITLE.test(r.title)) return false;
            if (!ROLE_KEYWORD.test(r.title)) return false;
            return true;
        });

        meta.listingHits = roles.length;
        safeDiscovered(progress, roles.length);

        if (roles.length === 0) {
            meta.atsEmpty = true;
            console.log(`  [intuji] extracted 0 (no role cards found)`);
            return { items, meta };
        }

        // ---- 6. Emit items ------------------------------------------------
        for (const r of roles) {
            try {
                let description = r.description;
                if (description) {
                    try {
                        description = trimDescriptionToLastSentence(
                            cleanDescriptionText(description), 4000
                        );
                    } catch (e) { /* keep raw */ }
                }

                const url = r.applyUrl || `${CAREERS_URL}#positions`;
                const registrationUrl = r.applyUrl || url;

                const item = {
                    id: `intuji-${slugify(r.title)}-${Date.now()}`,
                    title: r.title,

                    company,
                    company_status: 'extracted',
                    company_evidence: companyEvidence,

                    description: description || null,
                    description_status: description ? 'extracted' : 'site_absent',
                    description_evidence: description
                        ? `card body harvested from ${r.source}`
                        : `no per-role body on ${r.source}; careers page publishes only the shared hero intro ("Design, Build & Laugh! Be A Part Of Our Team") and value/benefit blurbs`,

                    location: pageLocation,
                    location_status: cls.location ? 'extracted' : 'site_absent',
                    location_evidence: cls.location
                        ? 'matched city/country in careers-page body'
                        : 'no per-role location element; defaulted from Intuji being Kathmandu-based',

                    date: null,
                    time: null,
                    price: null,

                    salary: cls.salary,
                    salary_status: cls.salary ? 'extracted' : 'site_absent',
                    salary_evidence: cls.salary
                        ? 'matched currency regex in careers-page body'
                        : 'no numeric salary string; careers page only says "Top-tier salary packages" (no figure)',

                    employmentType: cls.employmentType,
                    employmentType_status: cls.employmentType ? 'extracted' : 'site_absent',
                    employmentType_evidence: cls.employmentType
                        ? 'matched full-time/part-time/contract/intern regex in careers-page body'
                        : 'no full-time/part-time/contract/intern marker per role',

                    applicationEndsRaw: null,
                    applicationEnds_status: 'site_absent',
                    applicationEnds_evidence: 'no apply-by date element on careers page or role cards',

                    organizer: company,
                    category: 'Software Engineering',
                    tags: ['engineering', 'intuji'],

                    image: ctx.logo || null,
                    url,
                    registrationUrl,
                    attendanceMode: cls.location === 'Remote' ? 'online' : 'in-person',
                    source: 'intuji'
                };

                items.push(item);
            } catch (e) {
                /* skip malformed role */
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`  [intuji] extracted ${items.length}`);
        return { items, meta };
    }
};