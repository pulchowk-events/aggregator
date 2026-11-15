// src/scrapers/extractors/jobs/bajratechnologies.js
// Site: https://bajratechnologies.com/jobs
// Verdict: CAREERS_PAGE.
//
// Structural notes (corrections to the wizard's assumptions):
//   - Wizard detected site type "listing-to-detail" but detailLinkCandidates
//     was EMPTY. There are no per-job detail pages on this site - the whole
//     careers experience is a single-page Odoo tabbed layout.
//   - "Current Openings" is a tab (.tab-list__item), not a link list.
//   - When openings exist, they render as Odoo job cards inside that tab.
//     When the company has no active listings (very common), the tab is
//     empty - we return [] rather than inventing a headline as a job.
//   - Wizard's card detectors landed on nav / FAQ / menu items, so we use
//     Odoo-specific job selectors (.o_job, /job/ hrefs) plus generic
//     job-card classes.
//
// Selector drift history:
//   2026-11-15: initial extraction. Odoo classes s_title_default /
//                s_faq_tabs / tab-list__item confirmed on page.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const BAJRA_URL = 'https://bajratechnologies.com/jobs';
const BAJRA_COMPANY = 'Bajra Technologies Pvt. Ltd';

const SEL = {
    // Odoo careers listing containers.
    jobCard: [
        '.o_jobs_list_compact .o_job_compact',
        '.o_jobs_list .o_job',
        '.o_jobs_list article',
        'article.o_job',
        '[class*="job-card"]',
        '[class*="job_card"]',
        '[class*="job-item"]',
        '[class*="job_item"]',
        '[class*="opening"][class*="item"]'
    ],
    // Job detail hrefs (Odoo-style).
    jobLink: [
        'a[href*="/job/"]',
        'a[href*="/jobs/detail/"]',
        'a[href*="/jobs/"]'
    ]
};

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        try {
            meta.pagesVisited++;
            await loadPage(page, BAJRA_URL);
            await delay(Math.random() * 800 + 400);
        } catch (err) {
            console.warn(`?? [bajratechnologies] failed to load listing: ${err.message}`);
            return { items, meta };
        }

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`?? [bajratechnologies] page looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        try {
            await page.waitForSelector('h1, h2, .tab-list__item', { timeout: 10000 });
        } catch (e) { /* continue */ }

        // Trigger any lazy rendering inside the tab panels.
        try {
            await page.evaluate(() => {
                document.querySelectorAll('.tab-list__link, .nav-link[data-toggle="tab"]').forEach((a) => {
                    try { a.click(); } catch (_) { /* ignore */ }
                });
            });
            await delay(800);
        } catch (e) { /* ignore */ }

        // Harvest job cards + job links, excluding chrome.
        const found = await page.evaluate((sel) => {
            const out = [];
            const seen = new Set();
            const isChrome = (el) => !!(el.closest && el.closest('header, footer, nav, .bjr-menu-item, .footer-column, .bjr-nav'));
            const isJunkTitle = (t) => (
                !t || t.length < 3 || t.length > 200 ||
                /^(home|about|services|products|contact|careers?|join us|faq|privacy|terms|login|sign ?in)$/i.test(t) ||
                /^(who can apply|how do i apply|do you accept|what documents|frequently asked|can.t find what)/i.test(t) ||
                /^do you have what it takes/i.test(t) ||
                /^current openings$/i.test(t)
            );

            const push = (title, url, text) => {
                if (isJunkTitle(title)) return;
                const key = title + '|' + (url || '');
                if (seen.has(key)) return;
                seen.add(key);
                out.push({ title, url: url || null, text: text || null });
            };

            // 1) Explicit job-card containers.
            for (const s of sel.jobCard) {
                try {
                    document.querySelectorAll(s).forEach((el) => {
                        if (isChrome(el)) return;
                        if (el.children.length > 30) return; // skip section wrappers
                        const h = el.querySelector('h1, h2, h3, h4, h5, .o_job_title, [class*="job-title"], [class*="job_title"]');
                        const title = h ? h.textContent.trim() : null;
                        const a = el.querySelector('a[href]');
                        const url = a ? a.href : null;
                        const text = el.textContent.trim().replace(/\s+/g, ' ').slice(0, 800);
                        push(title, url, text);
                    });
                } catch (e) { /* bad selector */ }
            }

            // 2) Explicit job-detail links (works even if the card class drifts).
            for (const s of sel.jobLink) {
                try {
                    document.querySelectorAll(s).forEach((a) => {
                        if (isChrome(a)) return;
                        const href = a.href || '';
                        if (href.replace(/\/+$/, '') === 'https://bajratechnologies.com/jobs') return;
                        const title = a.textContent.trim();
                        push(title, href, title);
                    });
                } catch (e) { /* ignore */ }
            }

            return out;
        }, SEL);

        meta.listingHits = found.length;
        safeDiscovered(progress, found.length);

        if (found.length === 0) {
            // Normal state for this site: careers page exists but the
            // company is not actively hiring.
            console.log('  [bajratechnologies] extracted 0 (no current openings)');
            return { items, meta };
        }

        // Site-wide location fallback (used only if we have items to attach it to).
        let pageLocation = null;
        try {
            pageLocation = await page.evaluate(() => {
                const sec = document.querySelector('[class*="location"], address');
                if (!sec) return null;
                const text = sec.textContent.trim();
                const m = text.match(/([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*,\s*[A-Z][a-zA-Z]+(?:,\s*[A-Z][a-zA-Z]+)*)/);
                return m ? m[1] : null;
            });
        } catch (e) { /* ignore */ }

        const now = Date.now();
        for (const cand of found) {
            try {
                items.push({
                    id: `bajratechnologies-${now}-${Math.random().toString(36).slice(2, 9)}`,
                    title: cand.title,
                    company: BAJRA_COMPANY,
                    company_status: 'extracted',
                    description: cand.text || null,
                    description_status: cand.text ? 'extracted' : 'extraction_failed',
                    description_evidence: cand.text
                        ? 'listing-card text (no per-job detail page exists on this site)'
                        : 'no description text on listing card; no detail page exists',
                    date: null,
                    time: null,
                    location: pageLocation || 'Kathmandu, Nepal',
                    location_status: pageLocation ? 'extracted' : 'extraction_failed',
                    location_evidence: pageLocation
                        ? '[class*="location"] section on listing page'
                        : 'no per-job location element; site-wide address fallback from [class*="location"] section',
                    price: null,
                    organizer: BAJRA_COMPANY,
                    category: null,
                    tags: [],
                    image: null,
                    image_status: 'site_absent',
                    image_evidence: 'listing cards carry no per-job image; only site marketing images on page',
                    url: cand.url || BAJRA_URL,
                    registrationUrl: cand.url || BAJRA_URL,
                    attendanceMode: 'in-person',
                    source: 'bajratechnologies',
                    employmentType: null,
                    employmentType_status: 'site_absent',
                    employmentType_evidence: 'no employment-type label on listing card; no detail pages exist',
                    applicationEndsRaw: null,
                    applicationEnds_status: 'site_absent',
                    applicationEnds_evidence: 'no apply-by date on listing card; no detail pages exist',
                    salary: null,
                    salary_status: 'site_absent',
                    salary_evidence: 'no salary/compensation string on listing card'
                });
            } catch (e) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`  [bajratechnologies] extracted ${items.length}`);
        return { items, meta };
    }
};