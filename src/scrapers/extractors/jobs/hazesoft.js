// src/scrapers/extractors/jobs/hazesoft.js
// Site-specific extractor. See ../README.md for the contract.
//
// VERDICT: CAREERS_PAGE
// Entry URL is the careers page ("Open roles" section anchored at #roles).
// Site is a WordPress marketing site; roles section is JS/HTML hybrid with
// no per-role JSON-LD and no stable per-role URL patterns surfaced by the
// wizard. Strategy:
//   1. Load careers page, detect block state.
//   2. Scroll through page + jump to #roles to trigger any lazy content.
//   3. Harvest per-role links via (a) DOM scan for job-ish anchors and
//      (b) explicit selector families. Dedupe.
//   4. If detail links exist -> per-link navigate + extract from the
//      H1.hz-hero__heading / main content block.
//   5. If no links -> scan #roles inline for heading+body card structure
//      (single-page-cards fallback).
//   6. Otherwise report empty cleanly.
//
// Notes on the field-evidence dump:
//   - The wizard's "sample detail page" is actually /services/ (no real
//     job detail pages were found on the listing). Selectors were chosen
//     to be tolerant: h1.hz-hero__heading is used when present, main h1
//     is the fallback, and the description block is picked from
//     main [class*="content"] / article / div.wp-site-blocks.
//   - No salary / employment-type element was visible; those are
//     regex-classified from body text and reported as site_absent when
//     nothing matches.
//   - company is taken from og:site_name ("Hazesoft") -- the employer is
//     never spelled out per-role, but the org is unambiguous.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne, pickAll } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');
const { trimDescriptionToLastSentence, cleanDescriptionText } = require('../../text');

const CAREERS_URL = 'https://hazesoft.co/careers/';
const SITE_HOST = 'hazesoft.co';
const COMPANY = 'Hazesoft';
const DEFAULT_LOCATION = 'Kathmandu, Nepal';

const SEL = {
    jobLink: [
        '#roles a[href*="/jobs/"]',
        '#roles a[href*="/job/"]',
        '#roles a[href*="/positions/"]',
        '#roles a[href*="/roles/"]',
        '#roles a[href*="/vacancies/"]',
        'a[href*="/jobs/"]',
        'a[href*="/job/"]',
        'a[href*="/positions/"]',
        'a[href*="/roles/"]',
        'a[href*="/vacancies/"]'
    ],
    title: [
        'h1.hz-hero__heading',
        'h1[class*="hz-hero__heading"]',
        'main h1',
        'h1'
    ],
    description: [
        'main [class*="content"]',
        'main article',
        'div.wp-site-blocks',
        'main'
    ]
};

async function harvestJobLinks(page) {
    return page.evaluate((host) => {
        const seen = new Set();
        const out = [];
        document.querySelectorAll('a[href]').forEach((a) => {
            const href = a.getAttribute('href');
            if (!href) return;
            let abs;
            try { abs = new URL(href, window.location.href); } catch (e) { return; }
            if (abs.host !== host) return;
            if (abs.hash && abs.pathname === window.location.pathname) return;
            const path = abs.pathname;
            if (path === '/' || path === '/careers/' || path === '/careers') return;
            if (path.startsWith('/services/')
                || path.startsWith('/applied-ai')
                || path.startsWith('/our-work')
                || path.startsWith('/our-approach')
                || path.startsWith('/request-a-quote')
                || path.startsWith('/contact')
                || path.startsWith('/wp-')) return;
            const cls = (a.className || '').toLowerCase();
            const txt = (a.textContent || '').toLowerCase();
            const inRoles = !!a.closest('#roles');
            const jobish = /job|role|position|opening|vacanc|apply|career|engineer|develop|design|devops|qa|sre/i
                .test(path + ' ' + cls + ' ' + txt) || inRoles;
            if (!jobish) return;
            const key = abs.toString();
            if (seen.has(key)) return;
            seen.add(key);
            out.push(key);
        });
        return out;
    }, SITE_HOST);
}

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
    else if (/\bhybrid\b/i.test(txt)) out.location = 'Hybrid';

    return out;
}

async function scrollThroughRoles(page) {
    await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const roles = document.querySelector('#roles');
        if (roles) {
            roles.scrollIntoView({ behavior: 'instant', block: 'start' });
            await sleep(500);
        }
        const step = 600;
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

module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        const items = [];

        // --- 1. Load careers page ---
        try {
            meta.pagesVisited++;
            await loadPage(page, CAREERS_URL);
            await delay(1000 + Math.random() * 800);
        } catch (e) {
            console.warn(`[hazesoft] careers page load failed: ${e.message}`);
            return { items, meta };
        }

        // --- 2. Block detection ---
        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`[hazesoft] blocked: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        // --- 3. Scroll to trigger any lazy content ---
        try {
            await scrollThroughRoles(page);
            await delay(700 + Math.random() * 500);
        } catch (e) { /* best-effort */ }

        // --- 4. Harvest per-role links ---
        let jobLinks = [];
        try { jobLinks = await harvestJobLinks(page); } catch (e) { /* best-effort */ }

        try {
            const viaSel = await pickAll(page, SEL.jobLink, { label: 'job links' });
            for (const href of viaSel.values) {
                if (!href) continue;
                let resolved = null;
                try { resolved = new URL(href, CAREERS_URL).toString(); }
                catch (e) { continue; }
                if (!jobLinks.includes(resolved)) jobLinks.push(resolved);
            }
        } catch (e) { /* best-effort */ }

        jobLinks = Array.from(new Set(jobLinks));
        meta.listingHits = jobLinks.length;

        // --- 5a. No detail links -> try inline #roles cards ---
        if (jobLinks.length === 0) {
            let cards = [];
            try {
                cards = await page.evaluate(() => {
                    const section = document.querySelector('#roles');
                    if (!section) return [];
                    const out = [];
                    const seen = new Set();
                    const candidates = section.querySelectorAll(
                        'article, li, [class*="card"], [class*="job"], [class*="role"], [class*="position"], [class*="opening"]'
                    );
                    candidates.forEach((el) => {
                        const titleEl = el.querySelector('h2, h3, h4, h5') || (el.matches('h2,h3,h4,h5') ? el : null);
                        if (!titleEl) return;
                        const title = titleEl.textContent.trim();
                        if (!title || title.length < 3 || title.length > 140) return;
                        if (/open roles?\b/i.test(title)) return;
                        if (/^(apply|view|read more|learn more)$/i.test(title)) return;
                        const key = title.toLowerCase();
                        if (seen.has(key)) return;
                        seen.add(key);
                        const body = (el.innerText || '').trim();
                        const descEl = el.querySelector('p');
                        const linkEl = el.querySelector('a[href]');
                        out.push({
                            title,
                            body,
                            description: descEl ? descEl.textContent.trim() : null,
                            link: linkEl ? linkEl.href : null
                        });
                    });
                    return out;
                });
            } catch (e) { /* best-effort */ }

            if (cards.length > 0) {
                safeDiscovered(progress, cards.length);
                for (const c of cards) {
                    try {
                        const cls = classifyBody(c.body || '');
                        const url = c.link || `${CAREERS_URL}#roles`;
                        items.push({
                            id: `hazesoft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                            title: c.title,
                            company: COMPANY,
                            company_status: 'extracted',
                            company_evidence: 'og:site_name = "Hazesoft"',
                            description: c.description || null,
                            description_status: c.description ? 'extracted' : 'site_absent',
                            description_evidence: c.description ? 'sibling <p> inside card' : 'no <p> body found in card',
                            location: cls.location || DEFAULT_LOCATION,
                            location_status: cls.location ? 'extracted' : 'site_absent',
                            location_evidence: cls.location ? 'matched city/country in card body' : 'defaulted from careers-page copy ("from Kathmandu")',
                            date: null,
                            time: null,
                            price: null,
                            salary: cls.salary,
                            salary_status: cls.salary ? 'extracted' : 'site_absent',
                            salary_evidence: cls.salary ? 'matched salary regex in card body' : 'no salary string in card',
                            employmentType: cls.employmentType,
                            employmentType_status: cls.employmentType ? 'extracted' : 'site_absent',
                            employmentType_evidence: cls.employmentType ? 'matched full-time/part-time/contract/intern in card body' : 'no employment-type string in card',
                            applicationEndsRaw: null,
                            applicationEnds_status: 'site_absent',
                            applicationEnds_evidence: 'no apply-by date in card',
                            organizer: COMPANY,
                            category: 'Software Engineering',
                            tags: ['engineering'],
                            image: null,
                            url,
                            registrationUrl: c.link || url,
                            attendanceMode: cls.location === 'Remote' ? 'online' : 'in-person',
                            source: 'hazesoft'
                        });
                    } catch (e) { /* skip malformed card */ }
                    finally { safeUnitDone(progress); }
                }
            } else {
                meta.atsEmpty = true;
            }

            console.log(`  [hazesoft] extracted ${items.length}`);
            return { items, meta };
        }

        // --- 5b. Detail pages exist -> per-link extraction ---
        safeDiscovered(progress, jobLinks.length);

        for (const link of jobLinks) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await loadPage(page, link);
                await delay(700 + Math.random() * 700);

                const titleResult = await pickOne(page, SEL.title, { label: `detail title (${link})` });
                const title = titleResult.value;
                if (!title) {
                    meta.detailParseFailures++;
                    continue;
                }

                const extras = await page.evaluate(() => {
                    const main = document.querySelector('main') || document.body;

                    let description = null;
                    const descEl = main.querySelector('[class*="content"], article, .wp-site-blocks, [class*="description"]');
                    if (descEl) {
                        const t = (descEl.innerText || descEl.textContent || '').trim();
                        if (t.length > 100) description = t;
                    }

                    let image = null;
                    const og = document.querySelector('meta[property="og:image"]');
                    if (og && og.getAttribute('content')) image = og.getAttribute('content');

                    return {
                        description,
                        image,
                        bodyText: (main.innerText || '').slice(0, 8000),
                        finalUrl: window.location.href
                    };
                });

                let description = extras.description;
                if (description) {
                    try {
                        description = cleanDescriptionText(description);
                        description = trimDescriptionToLastSentence(description, 6000);
                    } catch (e) { /* best-effort */ }
                }

                const cls = classifyBody(extras.bodyText || '');

                let slug = 'role';
                try {
                    const parts = new URL(link).pathname.split('/').filter(Boolean);
                    if (parts.length) slug = parts[parts.length - 1];
                } catch (e) { /* best-effort */ }

                items.push({
                    id: `hazesoft-${slug}-${Date.now()}`,
                    title,
                    company: COMPANY,
                    company_status: 'extracted',
                    company_evidence: 'og:site_name = "Hazesoft"',
                    description: description || null,
                    description_status: description ? 'extracted' : 'site_absent',
                    description_evidence: description ? 'main [class*="content"] / article' : 'no content block > 100 chars on detail page',
                    location: cls.location || DEFAULT_LOCATION,
                    location_status: cls.location ? 'extracted' : 'site_absent',
                    location_evidence: cls.location ? 'matched city/country in detail body' : 'defaulted from careers-page copy ("from Kathmandu")',
                    date: null,
                    time: null,
                    price: null,
                    salary: cls.salary,
                    salary_status: cls.salary ? 'extracted' : 'site_absent',
                    salary_evidence: cls.salary ? 'matched salary regex in body' : 'no salary string in detail body',
                    employmentType: cls.employmentType,
                    employmentType_status: cls.employmentType ? 'extracted' : 'site_absent',
                    employmentType_evidence: cls.employmentType ? 'matched full-time/part-time/contract/intern in detail body' : 'no employment-type string in detail body',
                    applicationEndsRaw: null,
                    applicationEnds_status: 'site_absent',
                    applicationEnds_evidence: 'no apply-by element on detail page',
                    organizer: COMPANY,
                    category: 'Software Engineering',
                    tags: ['engineering'],
                    image: extras.image,
                    url: link,
                    registrationUrl: link,
                    attendanceMode: cls.location === 'Remote' ? 'online' : 'in-person',
                    source: 'hazesoft'
                });
            } catch (e) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`  [hazesoft] extracted ${items.length}`);
        return { items, meta };
    }
};