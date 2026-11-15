// src/scrapers/extractors/jobs/proshore.js
// Site-specific extractor. See ../README.md for the contract.
//
// VERDICT: CAREERS_PAGE
//
// CORRECTION of wizard assumptions -- the raw dump was misleading:
//   - "listing-to-detail" is UNVERIFIED. The 5 `/` anchors are: the
//     logo, an in-page #current_openings anchor, and three `#Content-Block`
//     tab anchors. The 30+ "detailLinkCandidates" are /services/* and
//     /themes/* MARKETING pages, not per-job URLs.
//   - Card wrapper `script` (19) is <script> tags.
//   - No JobPosting JSON-LD anywhere.
//
// What the evidence DOES show for proshore.eu/careers:
//   - h1 "Get ready to grow with us and develop the future"
//   - Nav tabs: "Tech | Operations | Bootcamp | Current openings"
//   - Three "EXPLORE YOUR NEXT ROLE" category cards under #Content-Block-*:
//       Tech        -> "Developers, Designers, Testers"   -> Learn more
//       Operations  -> "Scrum Masters, HR, Management"    -> Learn more
//       Bootcamp    -> "Starting your career."            -> Learn more
//     These are CATEGORY POINTERS, not job postings.
//   - An in-page "Current openings" section is referenced
//     (`https://proshore.eu/#current_openings` and `[class*="openings"]`)
//     but the wizard's snapshot did not capture any rendered rows inside
//     it -- likely because (a) jobs load via JS from an ATS, and/or
//     (b) no roles are open at the time of the dump.
//   - og:title "Careers at Proshore | Build Your Tech Career in Nepal";
//     og:description says "Tech and operations roles in Kathmandu".
//
// Shape: single-page career landing whose actual openings section
// renders at runtime. Strategy is defensive -- we do NOT invent
// per-role selectors.
//
// Strategy:
//   1. Load /careers, detect block, scroll through the whole page so
//      any IntersectionObserver-loaded cards render.
//   2. Explicitly hop to #current_openings and wait up to ~10s for
//      either:
//        a) new anchor(s) whose href is on-site and NOT one of the
//           known marketing routes, OR
//        b) a "Learn more"/"Apply" CTA inside the openings section
//           whose visible title matches a role keyword.
//   3. Role candidates are filtered against:
//        - an explicit blocklist of the marketing card labels
//          (Tech / Operations / Bootcamp / Current openings / Our voices
//           / Do you share the same values? / etc.)
//        - a positive role keyword (engineer/developer/designer/manager/
//          analyst/intern/lead/qa/devops/sre/specialist/scrum/hr/...)
//   4. If a distinct per-job URL exists -> follow and extract there.
//      Otherwise emit inline with description_status: "site_absent".
//   5. If nothing resolves -> meta.atsEmpty = true (no jobs live today).
//
// Field handling:
//   - company: og:title suffix "Proshore" + header logo. Extracted.
//   - location: og:description says "in Kathmandu"; per-card work-mode
//     not published -> default "Kathmandu, Nepal".
//   - salary/applicationEnds/image: site_absent per evidence.
//
// Selector-drift log:
//   2026-11-15: initial. No stable per-role CSS class exists in evidence,
//               so anchoring on role-keyword scan inside the openings
//               region.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { trimDescriptionToLastSentence, cleanDescriptionText } = require('../../text');

const LISTING_URL = 'https://proshore.eu/careers';
const SOURCE = 'proshore';
const COMPANY = 'Proshore';
const COMPANY_EVIDENCE =
    'og:title = "Careers at Proshore | Build Your Tech Career in Nepal" + header logo';
const DEFAULT_LOCATION = 'Kathmandu, Nepal';

// Role-word filter (kept small to respect 120-char line limit).
const ROLE_A = /(engineer|developer|designer|manager|analyst|intern)/i;
const ROLE_B = /(lead|architect|specialist|consultant|director|officer)/i;
const ROLE_C = /(scrum|tester|\bqa\b|devops|\bsre\b|bootcamp|trainee)/i;
const ROLE_D = /(\bhr\b|recruit|marketer|admin|scientist|writer)/i;

function isRoleTitle(t) {
    if (!t) return false;
    return ROLE_A.test(t) || ROLE_B.test(t) || ROLE_C.test(t) || ROLE_D.test(t);
}

// Marketing card labels that must NOT be treated as jobs.
const NON_JOB_TITLE = new RegExp(
    '^(tech|operations|bootcamp|current openings|our voices|' +
    'do you share the same values\\??|' +
    'get ready to grow with us and develop the future|' +
    'developing for impact with global tech companies[^.]*|' +
    'get our career opportunities[^.]*)$',
    'i'
);

// On-site paths that are marketing, not job postings.
const NON_JOB_PATH = /\/(services|themes|solutions|industries|insights|about|contact|case-studies|case-study|blog|news)\b/i;

async function scrollAll(page) {
    await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        // Jump to #current_openings first.
        const pos = document.getElementById('current_openings')
            || document.querySelector('[class*="openings"]');
        if (pos) {
            try { pos.scrollIntoView({ behavior: 'instant', block: 'start' }); }
            catch (e) { /* best-effort */ }
            await sleep(800);
        }
        // Then walk the page.
        const step = 500;
        let y = 0;
        const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        while (y < h) {
            window.scrollTo(0, y);
            y += step;
            await sleep(80);
        }
        window.scrollTo(0, 0);
    });
}

async function waitForOpenings(page) {
    try {
        await page.waitForFunction(() => {
            // Any anchor in the openings region whose text has a role word?
            const region = document.getElementById('current_openings')
                || document.querySelector('[class*="openings"]')
                || document.querySelector('main');
            if (!region) return false;
            const ROLE = /(engineer|developer|designer|manager|analyst|intern|lead|architect|scrum|tester|qa|devops|sre|hr|recruiter)/i;
            const NON = /^(tech|operations|bootcamp|current openings)$/i;
            let hit = false;
            region.querySelectorAll('a, h3, h4, h5').forEach((el) => {
                if (hit) return;
                const t = (el.textContent || '').trim();
                if (!t || t.length > 140) return;
                if (NON.test(t)) return;
                if (ROLE.test(t)) hit = true;
            });
            return hit;
        }, { timeout: 10000 });
    } catch (e) { /* timeout - continue with whatever exists */ }
}

async function harvest(page) {
    return page.evaluate((nonJobSrc) => {
        const NONJOB = new RegExp(nonJobSrc, 'i');
        const links = new Set();
        const cards = [];
        const seen = new Set();

        // Role-word matcher, mirrored from Node to keep the evaluate()
        // self-contained.
        const RA = /(engineer|developer|designer|manager|analyst|intern)/i;
        const RB = /(lead|architect|specialist|consultant|director|officer)/i;
        const RC = /(scrum|tester|\bqa\b|devops|\bsre\b|bootcamp|trainee)/i;
        const RD = /(\bhr\b|recruit|marketer|admin|scientist|writer)/i;
        const isRole = (t) => t && (RA.test(t) || RB.test(t) || RC.test(t) || RD.test(t));

        const NONJOB_TITLE = new RegExp(
            '^(tech|operations|bootcamp|current openings|our voices|'
            + 'do you share the same values\\??|'
            + 'get ready to grow with us and develop the future)$',
            'i'
        );

        // --- 1. Per-job anchors on the whole page ---------------------
        document.querySelectorAll('a[href]').forEach((a) => {
            const raw = a.getAttribute('href') || '';
            if (!raw) return;
            if (/(#|javascript:|mailto:|tel:)/i.test(raw)) return;
            let abs;
            try { abs = new URL(raw, window.location.href); } catch (e) { return; }
            if (abs.host !== window.location.host) return;
            if (NONJOB.test(abs.pathname)) return;
            if (/^\/(careers?|careers\/?)$/i.test(abs.pathname)) return;
            const text = (a.textContent || '').trim();
            if (!isRole(text) && !isRole(abs.pathname)) return;
            links.add(abs.toString());
        });

        // --- 2. Inline cards in the openings region -------------------
        const region = document.getElementById('current_openings')
            || document.querySelector('[class*="openings"]')
            || document.querySelector('main');

        if (region) {
            region.querySelectorAll(
                'article, li, [class*="card"], [class*="role"], [class*="job"], '
                + '[class*="position"], [class*="opening"]'
            ).forEach((el) => {
                const headEl = el.querySelector('h2, h3, h4, h5');
                if (!headEl) return;
                const title = (headEl.textContent || '').trim().replace(/\s+/g, ' ');
                if (!title || title.length < 3 || title.length > 140) return;
                if (NONJOB_TITLE.test(title)) return;
                if (!isRole(title)) return;
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
        }

        // Page-level logo + body text for classification.
        const main = document.querySelector('main') || document.body;
        const bodyText = (main.innerText || '').slice(0, 12000);
        let logo = null;
        const hdrImg = document.querySelector('header img, nav img, .navbar2_logo-link img');
        if (hdrImg) {
            try {
                logo = window.__resolveImageSrc
                    ? window.__resolveImageSrc(hdrImg)
                    : (hdrImg.currentSrc || hdrImg.src);
            } catch (e) { logo = hdrImg.src || null; }
        }

        return {
            links: Array.from(links),
            cards,
            bodyText,
            logo,
            finalUrl: window.location.href
        };
    }, NON_JOB_PATH.source);
}

async function readDetail(page) {
    return page.evaluate(() => {
        const main = document.querySelector('main') || document.body;
        const h = main.querySelector('h1, h2');
        const title = h ? (h.textContent || '').trim() : null;

        let best = '';
        main.querySelectorAll('section, article, [class*="rich-text"], [class*="content"]')
            .forEach((s) => {
                const t = (s.innerText || '').trim();
                if (t.length > best.length) best = t;
            });
        if (!best) best = (main.innerText || '').trim();

        let location = null;
        const locEl = main.querySelector('[class*="location"], [class*="office"]');
        if (locEl) {
            const t = (locEl.textContent || '').trim();
            if (t && t.length < 80) location = t;
        }
        return {
            title,
            description: best.slice(0, 6000),
            location,
            bodyText: (main.innerText || '').slice(0, 10000),
            finalUrl: window.location.href
        };
    });
}

function classifyBody(txt) {
    const out = { employmentType: null, salary: null };
    if (!txt) return out;
    const l = txt.toLowerCase();
    if (/\bfull[-\s]?time\b/.test(l)) out.employmentType = 'full-time';
    else if (/\bpart[-\s]?time\b/.test(l)) out.employmentType = 'part-time';
    else if (/\bintern(ship)?\b/.test(l)) out.employmentType = 'internship';
    else if (/\bcontract(or)?\b/.test(l)) out.employmentType = 'contract';
    const m = txt.match(
        /(?:NPR|Rs\.?|USD|\$)\s?[\d,]+(?:\s?[--]\s?(?:NPR|Rs\.?|USD|\$)?\s?[\d,]+)?/
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

module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        const items = [];

        // ---- 1. Load listing ---------------------------------------------
        try {
            meta.pagesVisited++;
            await loadPage(page, LISTING_URL);
            await delay(1000 + Math.random() * 700);
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

        // ---- 3. Scroll + wait for openings region to render --------------
        try { await scrollAll(page); } catch (e) { /* best-effort */ }
        try { await waitForOpenings(page); } catch (e) { /* best-effort */ }
        await delay(600 + Math.random() * 400);

        // ---- 4. Harvest --------------------------------------------------
        let ctx = null;
        try { ctx = await harvest(page); } catch (e) { /* best-effort */ }
        if (!ctx) {
            meta.atsEmpty = true;
            console.log(`  [${SOURCE}] extracted 0 (page read failed)`);
            return { items, meta };
        }

        // Filter & dedupe.
        const links = Array.from(new Set(ctx.links || []));
        const cards = (ctx.cards || []).filter((c) => {
            if (!c.title) return false;
            if (NON_JOB_TITLE.test(c.title)) return false;
            if (!isRoleTitle(c.title)) return false;
            return true;
        });
        const discoverable = links.length || cards.length;
        meta.listingHits = discoverable;
        safeDiscovered(progress, discoverable);

        if (discoverable === 0) {
            meta.atsEmpty = true;
            console.log(`  [${SOURCE}] extracted 0 (no openings rendered)`);
            return { items, meta };
        }

        const clsPage = classifyBody(ctx.bodyText || '');
        const pageLocation = clsPage.location || DEFAULT_LOCATION;

        // ---- 5a. Per-job detail traversal --------------------------------
        if (links.length > 0) {
            for (const link of links) {
                try {
                    meta.pagesVisited++;
                    meta.detailPagesVisited++;
                    await loadPage(page, link);
                    await delay(600 + Math.random() * 500);

                    const d = await readDetail(page);
                    if (!d || !d.title) {
                        meta.detailParseFailures++;
                        continue;
                    }
                    if (NON_JOB_TITLE.test(d.title)) {
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
                    const location = d.location || clsPage.location || DEFAULT_LOCATION;

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
                            ? 'detail-page longest section/article text'
                            : 'detail page had no prose block > 100 chars',

                        location,
                        location_status: (d.location || clsPage.location)
                            ? 'extracted' : 'site_absent',
                        location_evidence: d.location
                            ? '[class*="location"] on detail page'
                            : (clsPage.location
                                ? 'matched city in careers-page body'
                                : 'default: Proshore is Kathmandu-based'),

                        employmentType: cls.employmentType || null,
                        employmentType_status: cls.employmentType ? 'extracted' : 'site_absent',
                        employmentType_evidence: cls.employmentType
                            ? 'full/part/contract/intern regex in detail body'
                            : 'no employment-type marker on detail page',

                        salary: cls.salary || null,
                        salary_status: cls.salary ? 'extracted' : 'site_absent',
                        salary_evidence: cls.salary
                            ? 'currency regex in detail body'
                            : 'no salary string on detail page',

                        applicationEndsRaw: null,
                        applicationEnds_status: 'site_absent',
                        applicationEnds_evidence: 'no apply-by element on detail page',

                        image: ctx.logo || null,
                        image_status: ctx.logo ? 'extracted' : 'site_absent',
                        image_evidence: ctx.logo ? 'header logo' : 'no logo or per-role image',

                        date: null,
                        time: null,
                        price: null,
                        organizer: COMPANY,
                        category: 'Engineering',
                        tags: ['engineering', 'proshore'],
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

        // ---- 5b. Inline card fallback -----------------------------------
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
                            ? 'sibling text inside openings card'
                            : 'no per-role prose in openings card',

                        location: pageLocation,
                        location_status: clsPage.location ? 'extracted' : 'site_absent',
                        location_evidence: clsPage.location
                            ? 'matched city in careers-page body'
                            : 'default: Proshore is Kathmandu-based',

                        employmentType: cls.employmentType || null,
                        employmentType_status: cls.employmentType ? 'extracted' : 'site_absent',
                        employmentType_evidence: cls.employmentType
                            ? 'full/part/contract/intern regex in card body'
                            : 'no employment-type marker in card',

                        salary: cls.salary || null,
                        salary_status: cls.salary ? 'extracted' : 'site_absent',
                        salary_evidence: cls.salary
                            ? 'currency regex in card body'
                            : 'no salary string in card',

                        applicationEndsRaw: null,
                        applicationEnds_status: 'site_absent',
                        applicationEnds_evidence: 'no apply-by element in card',

                        image: ctx.logo || null,
                        image_status: ctx.logo ? 'extracted' : 'site_absent',
                        image_evidence: ctx.logo ? 'header logo' : 'no logo or per-role image',

                        date: null,
                        time: null,
                        price: null,
                        organizer: COMPANY,
                        category: 'Engineering',
                        tags: ['engineering', 'proshore'],
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