// src/scrapers/extractors/jobs/sussol.js
// Site-specific extractor. See ../README.md for the contract.
//
// VERDICT: CAREERS_PAGE
//
// CORRECTION of wizard assumptions:
//   - "listing-to-detail" is WRONG. The 5 `/` anchors are the logo,
//     `#page-top`, and in-page `#services` / `#about` / `#contact`
//     fragments. There are NO per-job detail URLs.
//   - Card wrapper `script` (9) is <script> tags.
//   - No JobPosting JSON-LD, no og:site_name, no per-role cards.
//
// REAL state of the page (bodySnippet):
//   "JOBS / NO JOBS OPENING YET !"
//   "Currently we have no job openings. Reason for this is that our
//    staff turn over rate is low..."
// So this is the site's real careers page, currently showing ZERO
// open roles. The extractor must:
//   - return items: [] with meta.atsEmpty = true on the current page,
//   - self-activate if any job cards / anchors appear in future runs.
//
// Company: site identity is "Sustainable Solutions" (page <title>
// "jobs - Sustainable Solutions", domain sussol.net). og:site_name is
// null, but the title suffix is unambiguous.
//
// Strategy (defensive, empty-friendly):
//   1. Load /jobs/, block-check.
//   2. Read main text; if it matches "no jobs opening" / "no job
//      openings" / "no vacancies" AND there are no role-like anchors,
//      return { items: [], meta } with meta.atsEmpty = true.
//   3. Otherwise harvest role-like anchors and inline cards inside
//      main; accept only titles matching a role keyword.
//   4. Per-anchor: navigate once, extract H1 + main prose.
//   5. Emit with per-field status + evidence; salary/image/
//      applicationEnds are site_absent per evidence.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { trimDescriptionToLastSentence, cleanDescriptionText } = require('../../text');

const LISTING_URL = 'https://sussol.net/jobs/';
const SOURCE = 'sussol';
const COMPANY = 'Sustainable Solutions';
const COMPANY_EVIDENCE =
    'page <title> "jobs - Sustainable Solutions" + domain sussol.net ' +
    '(og:site_name is null)';
const DEFAULT_LOCATION = 'Nepal';

// Non-job navigation / file paths we must never treat as detail pages.
const NON_JOB_PATH = /\/(about|staff|news|photos|contact|sales|file_download)\b/i;

// Role-title keyword matcher (compact alternations to respect line length).
const ROLE_A = /(engineer|developer|designer|manager|analyst|intern)/i;
const ROLE_B = /(lead|architect|specialist|consultant|director|officer)/i;
const ROLE_C = /(devops|\bqa\b|\bsre\b|scientist|writer|programmer|administrator)/i;

function isRoleTitle(t) {
    if (!t) return false;
    return ROLE_A.test(t) || ROLE_B.test(t) || ROLE_C.test(t);
}

// Phrases that mean "the site says it has no openings right now".
const NO_VACANCY =
    /(no jobs?\s+opening|no job openings?|no open(?:ings|ings?\s+right\s+now)|no vacancies|no roles?\s+(?:open|available))/i;

function classifyBody(txt) {
    const out = { employmentType: null, salary: null };
    if (!txt) return out;
    const l = txt.toLowerCase();
    if (/\bfull[-\s]?time\b/.test(l)) out.employmentType = 'full-time';
    else if (/\bpart[-\s]?time\b/.test(l)) out.employmentType = 'part-time';
    else if (/\bintern(ship)?\b/.test(l)) out.employmentType = 'internship';
    else if (/\bcontract(or)?\b/.test(l)) out.employmentType = 'contract';

    const m = txt.match(
        /(?:NPR|Rs\.?|USD|\$)\s?[\d,]+(?:\s?[--]\s?(?:NPR|Rs\.?|USD|\$)?\s?[\d,]+)?(?:\s?(?:k|K|per month|\/month|per year|\/year|annum))?/i
    );
    if (m) out.salary = m[0].trim();
    return out;
}

function slugify(s) {
    return String(s || 'role')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'role';
}

async function readListing(page) {
    return page.evaluate((nonJobSrc, roleA, roleB, roleC) => {
        const NONJOB = new RegExp(nonJobSrc, 'i');
        const RA = new RegExp(roleA, 'i');
        const RB = new RegExp(roleB, 'i');
        const RC = new RegExp(roleC, 'i');
        const isRole = (t) => t && (RA.test(t) || RB.test(t) || RC.test(t));

        const main = document.querySelector('main, #main, section, body');
        const mainText = main ? (main.innerText || '').trim() : '';

        // Collect any role-like same-domain anchors.
        const links = new Set();
        document.querySelectorAll('a[href]').forEach((a) => {
            const raw = a.getAttribute('href') || '';
            if (!raw) return;
            if (/(#|javascript:|mailto:|tel:)/i.test(raw)) return;
            let abs;
            try { abs = new URL(raw, window.location.href); } catch (e) { return; }
            if (abs.host !== window.location.host) return;
            if (NON_JOB_PATH.test(abs.pathname)) return;
            if (/^\/jobs?\/?$/i.test(abs.pathname)) return;
            const text = (a.textContent || '').trim();
            if (!isRole(text) && !isRole(abs.pathname)) return;
            links.add(abs.toString());
        });

        // Collect inline cards (article/li/card) with role-like headings.
        const cards = [];
        const seen = new Set();
        document.querySelectorAll(
            'article, li, [class*="card"], [class*="job"], [class*="position"], [class*="opening"]'
        ).forEach((el) => {
            const headEl = el.querySelector('h2, h3, h4, h5');
            if (!headEl) return;
            const title = (headEl.textContent || '').trim().replace(/\s+/g, ' ');
            if (!title || title.length < 3 || title.length > 140) return;
            if (!isRole(title)) return;
            if (/^jobs?$/i.test(title)) return;
            const key = title.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);

            let applyUrl = null;
            const l = el.querySelector('a[href]');
            if (l) {
                try { applyUrl = new URL(l.getAttribute('href'), window.location.href).toString(); }
                catch (e) { applyUrl = null; }
            }

            const text = (el.innerText || '').trim();
            const idx = text.indexOf(title);
            const description =
                idx >= 0 && text.length > idx + title.length + 20
                    ? text.slice(idx + title.length).trim().slice(0, 4000)
                    : null;

            cards.push({ title, description, applyUrl });
        });

        let logo = null;
        const hdrImg = document.querySelector('header img, .navbar-brand img, nav img');
        if (hdrImg) {
            try {
                logo = window.__resolveImageSrc
                    ? window.__resolveImageSrc(hdrImg)
                    : (hdrImg.currentSrc || hdrImg.src);
            } catch (e) { logo = hdrImg.src || null; }
        }

        return {
            mainText,
            links: Array.from(links),
            cards,
            logo,
            finalUrl: window.location.href
        };
    }, NON_JOB_PATH.source, ROLE_A.source, ROLE_B.source, ROLE_C.source);
}

async function readDetail(page) {
    return page.evaluate(() => {
        const main = document.querySelector('main, #main, section, body');
        const h1 = document.querySelector('h1');
        const title = h1 ? (h1.textContent || '').trim() : null;

        let best = '';
        if (main) {
            main.querySelectorAll('section, article, [class*="content"]').forEach((s) => {
                const t = (s.innerText || '').trim();
                if (t.length > best.length) best = t;
            });
            if (!best) best = (main.innerText || '').trim();
        }

        return {
            title,
            description: best.slice(0, 6000),
            bodyText: (main && (main.innerText || '')).slice(0, 10000) || '',
            finalUrl: window.location.href
        };
    });
}

module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        const items = [];

        // ---- 1. Load listing ---------------------------------------------
        try {
            meta.pagesVisited++;
            await loadPage(page, LISTING_URL);
            await delay(800 + Math.random() * 600);
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

        // ---- 3. Read listing ---------------------------------------------
        let ctx = null;
        try { ctx = await readListing(page); } catch (e) { ctx = null; }
        if (!ctx) {
            meta.atsEmpty = true;
            console.log(`  [${SOURCE}] extracted 0 (page read failed)`);
            return { items, meta };
        }

        const mainText = ctx.mainText || '';
        const links = Array.from(new Set(ctx.links || []));
        const cards = (ctx.cards || []).filter((c) => isRoleTitle(c.title));

        // ---- 4. Empty-site short-circuit --------------------------------
        if (NO_VACANCY.test(mainText) && links.length === 0 && cards.length === 0) {
            meta.atsEmpty = true;
            console.log(`  [${SOURCE}] extracted 0 (site reports no openings)`);
            return { items, meta };
        }

        // ---- 5. Nothing discoverable ------------------------------------
        const discoverable = links.length || cards.length;
        meta.listingHits = discoverable;
        safeDiscovered(progress, discoverable);

        if (discoverable === 0) {
            meta.atsEmpty = true;
            console.log(`  [${SOURCE}] extracted 0 (no role candidates)`);
            return { items, meta };
        }

        const clsPage = classifyBody(mainText);

        // ---- 6a. Per-job detail traversal -------------------------------
        if (links.length > 0) {
            for (const link of links) {
                try {
                    meta.pagesVisited++;
                    meta.detailPagesVisited++;
                    await loadPage(page, link);
                    await delay(600 + Math.random() * 500);

                    const d = await readDetail(page);
                    if (!d || !d.title || !isRoleTitle(d.title)) {
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

                    const cls = classifyBody([d.bodyText, description]
                        .filter(Boolean).join(' '));
                    const employmentType = cls.employmentType || clsPage.employmentType;
                    const salary = cls.salary || clsPage.salary;

                    items.push({
                        id: `${SOURCE}-${slugify(d.title)}-${Date.now()}-`
                            + Math.random().toString(36).slice(2, 6),
                        title: d.title,
                        company: COMPANY,
                        company_status: 'extracted',
                        company_evidence: COMPANY_EVIDENCE,
                        description: description || null,
                        description_status: description ? 'extracted' : 'site_absent',
                        description_evidence: description
                            ? 'longest <section>/<article>/[class*="content"] on detail page'
                            : 'no prose block >100 chars on detail page',
                        location: DEFAULT_LOCATION,
                        location_status: 'site_absent',
                        location_evidence:
                            'no per-role location on jobs listing or detail page; '
                            + 'site is Nepal-based',
                        employmentType: employmentType || null,
                        employmentType_status: employmentType ? 'extracted' : 'site_absent',
                        employmentType_evidence: employmentType
                            ? 'full/part/contract/intern regex in detail body'
                            : 'no employment-type string on detail page',
                        salary: salary || null,
                        salary_status: salary ? 'extracted' : 'site_absent',
                        salary_evidence: salary
                            ? 'currency regex in detail body'
                            : 'no salary string on detail page',
                        applicationEndsRaw: null,
                        applicationEnds_status: 'site_absent',
                        applicationEnds_evidence:
                            'no apply-by / closing-date element on detail page',
                        image: ctx.logo || null,
                        image_status: ctx.logo ? 'extracted' : 'site_absent',
                        image_evidence: ctx.logo ? 'site header logo' : 'no logo',
                        date: null,
                        time: null,
                        price: null,
                        organizer: COMPANY,
                        category: 'Engineering',
                        tags: ['engineering', 'sussol'],
                        url: d.finalUrl || link,
                        registrationUrl: d.finalUrl || link,
                        attendanceMode: 'in-person',
                        source: SOURCE
                    });
                } catch (e) {
                    meta.detailParseFailures++;
                } finally {
                    safeUnitDone(progress);
                }
            }
        }

        // ---- 6b. Inline card fallback -----------------------------------
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

                    const cls = classifyBody(c.description || '');
                    const employmentType = cls.employmentType || clsPage.employmentType;
                    const salary = cls.salary || clsPage.salary;
                    const itemUrl = c.applyUrl || LISTING_URL;

                    items.push({
                        id: `${SOURCE}-${slugify(c.title)}-${Date.now()}-`
                            + Math.random().toString(36).slice(2, 6),
                        title: c.title,
                        company: COMPANY,
                        company_status: 'extracted',
                        company_evidence: COMPANY_EVIDENCE,
                        description: description || null,
                        description_status: description ? 'extracted' : 'site_absent',
                        description_evidence: description
                            ? 'sibling text inside listing card'
                            : 'no per-role prose in card',
                        location: DEFAULT_LOCATION,
                        location_status: 'site_absent',
                        location_evidence:
                            'no per-role location on jobs listing; site is Nepal-based',
                        employmentType: employmentType || null,
                        employmentType_status: employmentType ? 'extracted' : 'site_absent',
                        employmentType_evidence: employmentType
                            ? 'full/part/contract/intern regex in card body'
                            : 'no employment-type string in card',
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
                        image_evidence: ctx.logo ? 'site header logo' : 'no logo',
                        date: null,
                        time: null,
                        price: null,
                        organizer: COMPANY,
                        category: 'Engineering',
                        tags: ['engineering', 'sussol'],
                        url: itemUrl,
                        registrationUrl: itemUrl,
                        attendanceMode: 'in-person',
                        source: SOURCE
                    });
                } catch (e) {
                    /* skip malformed card */
                } finally {
                    safeUnitDone(progress);
                }
            }
        }

        if (items.length === 0) meta.atsEmpty = true;

        console.log(`  [${SOURCE}] extracted ${items.length}`);
        return { items, meta };
    }
};