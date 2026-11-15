// src/scrapers/extractors/jobs/nimble.js
// Site-specific extractor. See ../README.md for the contract.
//
// VERDICT: CAREERS_PAGE
//
// CORRECTION of wizard assumptions -- the raw dump was misleading:
//   - "listing-to-detail" is WRONG. The 4 `/recruitment/public/index`
//     anchors are the nav brand / "Job List" / "Home" links -- they all
//     point back to the same listing page. There are no per-job detail
//     URLs surfaced.
//   - Card wrapper `meta` (17) is <meta> tags, not job cards.
//   - Longest description `div.container` is the container wrapping the
//     whole page, not a per-role body.
//   - This is a small custom PHP ATS ("Nimble Infosys Pvt. Ltd. - Job
//     Opening List" -- /recruitment/public/...). Field evidence shows
//     the CURRENT state: "[class*='vacanc']" h4 text is literally
//     "No any vacancy available at the moment, please keep in touch
//     for future vacancies." So there are ZERO open positions right now.
//
// Strategy (single-page listing; no detail URLs in evidence):
//   1. Load listing, detect block state.
//   2. Read the vacancy-message element ([class*="vacanc"] h4) and the
//      main content text; if it says "no vacancy"/"no openings"/
//      "no any vacancy" -> return items: [] with meta.atsEmpty = true.
//   3. Otherwise defensively harvest role rows/cards from the page using
//      only DOM landmarks actually seen in the dump:
//        - main content container: div.container (evidence)
//        - table rows, list items, and cards under that container
//        - anchors whose href points at /recruitment/ but is NOT
//          index/login/register/GetDocument (i.e. a per-job URL)
//      Title candidates: headings (h3/h4/h5), strong/b inside a row, or
//      anchor text matching a role keyword. Cards with no title are
//      dropped.
//   4. If per-job anchors exist, follow each once and extract fields
//      from the detail page; else emit inline-card items.
//   5. Emit per-field status + evidence. Company = "Nimble Infosys Pvt.
//      Ltd." (og:title, footer <strong>). Location defaults to Nimble's
//      published address (Kathmandu) when no per-role location is found.
//
// Selector-drift log:
//   2026-11-15: initial. No stable job-card selectors in evidence (empty
//               listing). Extractor will no-op cleanly when there are no
//               vacancies and self-activate when rows appear.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { trimDescriptionToLastSentence, cleanDescriptionText } = require('../../text');

const LISTING_URL = 'https://career.nimble.com.np/';
const SOURCE = 'nimble';
const COMPANY = 'Nimble Infosys Pvt. Ltd.';
const COMPANY_EVIDENCE =
    'og:title = "Nimble Infosys Pvt. Ltd." + footer <strong> "Nimble Infosys Pvt. Ltd."';
const DEFAULT_LOCATION = 'Kathmandu, Nepal';

// Non-job ATS paths we must never follow as "detail pages".
const NON_JOB_PATH = /\/(login|register|index|logout|GetDocument|about)\b/i;

// Paths that look like a real per-job detail.
const JOB_PATH = /\/recruitment\/(?:public\/)?(?:job|jobs|jobdetail|vacancy|position|apply|detail)/i;

// Role-title word matcher (English) -- reused in-page and in Node.
const ROLE_WORD =
    /(engineer|developer|designer|manager|analyst|intern(ship)?|lead|architect|qa|devops|sre|specialist|consultant|director|officer|associate|executive|programmer|administrator|tester|scientist|writer|marketer|accountant|sales|support|hr)/i;

// Phrases that mean "no openings right now".
const NO_VACANCY =
    /(no any vacancy|no vacancy|no vacancies|no openings|no open positions|no roles? (available|open)|keep in touch for future)/i;

function classifyBody(txt) {
    const out = { employmentType: null, location: null, salary: null };
    if (!txt) return out;
    const lower = txt.toLowerCase();

    if (/\bfull[\s-]?time\b/.test(lower)) out.employmentType = 'full-time';
    else if (/\bpart[\s-]?time\b/.test(lower)) out.employmentType = 'part-time';
    else if (/\bintern(ship)?\b/.test(lower)) out.employmentType = 'internship';
    else if (/\bcontract(?:or)?\b/.test(lower)) out.employmentType = 'contract';

    const sm = txt.match(/(?:NPR|Rs\.?|USD|\$)\s?[\d,]+(?:\s?[--]\s?(?:NPR|Rs\.?|USD|\$)?\s?[\d,]+)?(?:\s?(?:k|K|per month|\/month|per year|\/year|annum))?/i);
    if (sm) out.salary = sm[0].trim();

    if (/kathmandu/i.test(txt)) out.location = 'Kathmandu, Nepal';
    else if (/\bnepal\b/i.test(txt)) out.location = 'Nepal';
    else if (/\bremote\b/i.test(txt)) out.location = 'Remote';
    return out;
}

async function readPage(page) {
    return page.evaluate((roleSrc, nonJobSrc, jobSrc) => {
        const ROLE = new RegExp(roleSrc, 'i');
        const NON_JOB = new RegExp(nonJobSrc, 'i');
        const JOB = new RegExp(jobSrc, 'i');

        const main = document.querySelector('main, div.container, #main')
            || document.body;
        const bodyText = (main.innerText || '').slice(0, 12000);

        const vacEl = document.querySelector('[class*="vacanc"] h4, [class*="vacanc"]');
        const vacancyText = vacEl ? (vacEl.textContent || '').trim() : null;

        // ---- Job detail anchors ---------------------------------------
        const links = new Set();
        document.querySelectorAll('a[href]').forEach((a) => {
            const raw = a.getAttribute('href') || '';
            if (!raw) return;
            let abs;
            try { abs = new URL(raw, window.location.href); } catch (e) { return; }
            if (abs.host !== window.location.host) return;
            if (NON_JOB.test(abs.pathname)) return;
            if (!JOB.test(abs.pathname)) return;
            const text = (a.textContent || '').trim();
            if (!ROLE.test(text) && !ROLE.test(abs.pathname)) return;
            links.add(abs.toString());
        });

        // ---- Inline rows / cards --------------------------------------
        const cards = [];
        const seen = new Set();
        const roots = main.querySelectorAll(
            'tbody tr, article, .card, [class*="job"], [class*="vacanc"], [class*="position"], li'
        );
        roots.forEach((el) => {
            // Title from a heading first, else first anchor with a role word.
            let title = null;
            const headEl = el.querySelector('h2, h3, h4, h5, h6');
            if (headEl) {
                const t = (headEl.textContent || '').trim();
                if (ROLE.test(t) && t.length >= 3 && t.length <= 140) title = t;
            }
            if (!title) {
                el.querySelectorAll('a[href]').forEach((a) => {
                    if (title) return;
                    const t = (a.textContent || '').trim();
                    if (ROLE.test(t) && t.length >= 3 && t.length <= 140) title = t;
                });
            }
            if (!title) return;
            const key = title.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);

            let applyUrl = null;
            const linkEl = el.querySelector('a[href]');
            if (linkEl) {
                try { applyUrl = new URL(linkEl.getAttribute('href'), window.location.href).toString(); }
                catch (e) { applyUrl = null; }
            }

            const fullText = (el.innerText || '').trim();
            const idx = fullText.indexOf(title);
            const description =
                idx >= 0 && fullText.length > idx + title.length + 20
                    ? fullText.slice(idx + title.length).trim().slice(0, 4000)
                    : null;

            cards.push({ title, description, applyUrl });
        });

        let logo = null;
        const hdrImg = document.querySelector('header img, nav img, .navbar-brand img');
        if (hdrImg) {
            try {
                logo = window.__resolveImageSrc
                    ? window.__resolveImageSrc(hdrImg)
                    : (hdrImg.currentSrc || hdrImg.src);
            } catch (e) { logo = hdrImg.src || null; }
        }

        return {
            bodyText,
            vacancyText,
            links: Array.from(links),
            cards,
            logo,
            finalUrl: window.location.href
        };
    }, ROLE_WORD.source, NON_JOB_PATH.source, JOB_PATH.source);
}

async function readDetail(page) {
    return page.evaluate(() => {
        const main = document.querySelector('main, div.container, #main')
            || document.body;
        const h = main.querySelector('h1, h2, h3');
        const title = h ? (h.textContent || '').trim() : null;
        const paragraphs = Array.from(main.querySelectorAll('p'))
            .map((p) => (p.innerText || '').trim())
            .filter(Boolean);
        const description = paragraphs.length
            ? paragraphs.join('\n\n').slice(0, 6000)
            : (main.innerText || '').trim().slice(0, 6000);
        return {
            title,
            description,
            bodyText: (main.innerText || '').slice(0, 10000),
            finalUrl: window.location.href
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

module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        const items = [];

        // ---- 1. Load listing ---------------------------------------------
        try {
            meta.pagesVisited++;
            await loadPage(page, LISTING_URL);
            await delay(800 + Math.random() * 700);
        } catch (e) {
            console.warn(`[${SOURCE}] listing load failed: ${e.message}`);
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

        // ---- 3. Read page ------------------------------------------------
        let ctx = null;
        try { ctx = await readPage(page); } catch (e) { /* best-effort */ }
        if (!ctx) {
            meta.atsEmpty = true;
            console.log(`  [${SOURCE}] extracted 0 (page read failed)`);
            return { items, meta };
        }

        // ---- 4. Early exit if the site says "no vacancy" -----------------
        const bodyText = ctx.bodyText || '';
        if (NO_VACANCY.test(bodyText) && (ctx.links.length === 0 && ctx.cards.length === 0)) {
            meta.atsEmpty = true;
            console.log(`  [${SOURCE}] extracted 0 (no vacancies)`);
            return { items, meta };
        }

        // ---- 5. Filter role candidates ----------------------------------
        const clsPage = classifyBody(bodyText);
        const links = Array.from(new Set(ctx.links || []));
        const cards = (ctx.cards || []).filter(
            (c) => c.title && !NO_VACANCY.test(c.title) && ROLE_WORD.test(c.title)
        );
        const discoverable = links.length || cards.length;
        meta.listingHits = discoverable;
        safeDiscovered(progress, discoverable);

        if (discoverable === 0) {
            meta.atsEmpty = true;
            console.log(`  [${SOURCE}] extracted 0 (no roles resolved)`);
            return { items, meta };
        }

        // ---- 6a. Per-job detail traversal -------------------------------
        if (links.length > 0) {
            for (const link of links) {
                try {
                    meta.pagesVisited++;
                    meta.detailPagesVisited++;
                    await loadPage(page, link);
                    await delay(600 + Math.random() * 500);

                    const d = await readDetail(page);
                    if (!d || !d.title || !ROLE_WORD.test(d.title)) {
                        meta.detailParseFailures++;
                        continue;
                    }

                    let description = d.description;
                    if (description) {
                        try {
                            description = trimDescriptionToLastSentence(
                                cleanDescriptionText(description), 6000
                            );
                        } catch (e) { /* keep raw */ }
                    }

                    const cls = classifyBody([d.bodyText, description].filter(Boolean).join(' '));
                    const location = cls.location || clsPage.location || DEFAULT_LOCATION;
                    const employmentType = cls.employmentType || clsPage.employmentType;
                    const salary = cls.salary || clsPage.salary;

                    items.push({
                        id: `${SOURCE}-${slugify(d.title)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        title: d.title,
                        company: COMPANY,
                        company_status: 'extracted',
                        company_evidence: COMPANY_EVIDENCE,
                        description: description || null,
                        description_status: description ? 'extracted' : 'site_absent',
                        description_evidence: description
                            ? 'detail-page <p> paragraphs under div.container'
                            : 'no prose paragraphs on detail page',
                        location,
                        location_status: cls.location ? 'extracted' : 'site_absent',
                        location_evidence: cls.location
                            ? 'matched city/country in detail body'
                            : 'default: Nimble address in footer (Kathmandu, Nepal)',
                        employmentType: employmentType || null,
                        employmentType_status: employmentType ? 'extracted' : 'site_absent',
                        employmentType_evidence: employmentType
                            ? 'employment-type regex in detail/page body'
                            : 'no full/part/contract/intern in detail or page body',
                        salary: salary || null,
                        salary_status: salary ? 'extracted' : 'site_absent',
                        salary_evidence: salary
                            ? 'currency regex in detail/page body'
                            : 'no salary string on detail or listing',
                        applicationEndsRaw: null,
                        applicationEnds_status: 'site_absent',
                        applicationEnds_evidence: 'no apply-by element on detail page',
                        image: ctx.logo || null,
                        image_status: ctx.logo ? 'extracted' : 'site_absent',
                        image_evidence: ctx.logo ? 'header/logo img' : 'no logo or per-role image',
                        date: null,
                        time: null,
                        price: null,
                        organizer: COMPANY,
                        category: 'Engineering',
                        tags: ['engineering', 'nimble'],
                        url: d.finalUrl || link,
                        registrationUrl: d.finalUrl || link,
                        attendanceMode: location === 'Remote' ? 'online' : 'in-person',
                        source: SOURCE
                    });
                } catch (e) {
                    meta.detailParseFailures++;
                } finally {
                    safeUnitDone(progress);
                }
            }
        }

        // ---- 6b. Inline cards fallback ----------------------------------
        if (links.length === 0 && cards.length > 0) {
            for (const c of cards) {
                try {
                    let description = c.description;
                    if (description) {
                        try {
                            description = trimDescriptionToLastSentence(
                                cleanDescriptionText(description), 4000
                            );
                        } catch (e) { /* keep raw */ }
                    }

                    const cls = classifyBody([c.description].filter(Boolean).join(' '));
                    const location = cls.location || clsPage.location || DEFAULT_LOCATION;
                    const employmentType = cls.employmentType || clsPage.employmentType;
                    const salary = cls.salary || clsPage.salary;
                    const itemUrl = c.applyUrl || LISTING_URL;

                    items.push({
                        id: `${SOURCE}-${slugify(c.title)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                        title: c.title,
                        company: COMPANY,
                        company_status: 'extracted',
                        company_evidence: COMPANY_EVIDENCE,
                        description: description || null,
                        description_status: description ? 'extracted' : 'site_absent',
                        description_evidence: description
                            ? 'sibling text inside listing row/card'
                            : 'no per-role prose inside listing row',
                        location,
                        location_status: cls.location ? 'extracted' : 'site_absent',
                        location_evidence: cls.location
                            ? 'matched city/country in card body'
                            : 'default: Nimble address in footer (Kathmandu, Nepal)',
                        employmentType: employmentType || null,
                        employmentType_status: employmentType ? 'extracted' : 'site_absent',
                        employmentType_evidence: employmentType
                            ? 'employment-type regex in card body'
                            : 'no employment-type marker in card',
                        salary: salary || null,
                        salary_status: salary ? 'extracted' : 'site_absent',
                        salary_evidence: salary
                            ? 'currency regex in card body'
                            : 'no salary string in card',
                        applicationEndsRaw: null,
                        applicationEnds_status: 'site_absent',
                        applicationEnds_evidence: 'no apply-by element in card',
                        image: ctx.logo || null,
                        image_status: ctx.logo ? 'extracted' : 'site_absent',
                        image_evidence: ctx.logo ? 'header/logo img' : 'no logo or per-role image',
                        date: null,
                        time: null,
                        price: null,
                        organizer: COMPANY,
                        category: 'Engineering',
                        tags: ['engineering', 'nimble'],
                        url: itemUrl,
                        registrationUrl: itemUrl,
                        attendanceMode: location === 'Remote' ? 'online' : 'in-person',
                        source: SOURCE
                    });
                } catch (e) {
                    /* skip malformed card */
                } finally {
                    safeUnitDone(progress);
                }
            }
        }

        if (items.length === 0) {
            meta.atsEmpty = true;
        }

        console.log(`  [${SOURCE}] extracted ${items.length}`);
        return { items, meta };
    }
};