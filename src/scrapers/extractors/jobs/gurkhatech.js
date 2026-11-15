// src/scrapers/extractors/jobs/gurkhatech.js
// Site: gurkhatech.com/careers/ (WordPress marketing site)
//
// IMPORTANT -- structural reality (verified 2026-11 via wizard evidence):
//   - The /careers/ page is a generic "Join Our Team / we're always hiring"
//     marketing page. It contains a hero image (not-hiring.jpg), one intro
//     paragraph, and "Why Gurkha Technology?" / "Stay Connected" sections.
//   - There are NO actual job cards, NO per-role detail links, and NO
//     JobPosting JSON-LD. The only links are navigation, social, and
//     service pages (SEO, social media, google ads, website dev).
//   - The wizard's "detail page" sample was the site's Facebook link,
//     which is not a job page.
//
// Strategy: harvest any job-like links (path or text matching
// job|career|vacancy|position|opening|apply). If none exist -- the
// current state -- return an empty items array with atsEmpty=true.
// If the site later publishes real vacancies under a /job/ or
// /careers/<slug>/ path, the generic scan will pick them up.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const ENTRY_URL = 'https://gurkhatech.com/careers/';
const SITE_HOST = 'gurkhatech.com';

module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        const items = [];

        // --- 1. Load entry page -------------------------------------------
        meta.pagesVisited++;
        try {
            await loadPage(page, ENTRY_URL);
            await delay(500 + Math.random() * 700);
        } catch (e) {
            console.warn(`[gurkhatech] entry load failed: ${e.message}`);
            return { items: [], meta };
        }

        // --- 2. Block detection ------------------------------------------
        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`[gurkhatech] looks blocked: ${JSON.stringify(state.bodySnippet)}`);
                return { items: [], meta };
            }
        } catch (e) { /* best-effort */ }

        // --- 3. Harvest job-like links -----------------------------------
        const jobLinks = await page.evaluate((host) => {
            const out = [];
            const seen = new Set();
            const skipHost = /facebook|twitter|linkedin|instagram|github|behance|youtube|pagead|google|gstatic|doubleclick/i;
            const skipPath = /\/digital-marketing|\/about|\/blog|\/contact|\/page\/|\/wp-content|\/wp-admin|\/feed|\/meta-verification|\/facebook-boosting/i;

            document.querySelectorAll('a[href]').forEach((a) => {
                let href;
                try { href = new URL(a.href, location.href).href; } catch (e) { return; }
                if (!href.includes(host)) return;
                if (skipHost.test(href)) return;
                if (skipPath.test(href)) return;
                if (href.includes('#')) return;
                if (/\/careers\/?$/.test(href)) return;
                if (seen.has(href)) return;

                const text = (a.textContent || '').trim();
                if (!text) return;

                const blob = (href + ' ' + text).toLowerCase();
                const pathLooksJob = /\/(job|jobs|career|careers|vacanc|vacancies|position|positions|opening|openings|apply)\b/.test(blob);
                const textLooksJob = /\b(hiring|vacancy|vacancies|position|opening|apply now|full[\s-]?time|part[\s-]?time|internship)\b/i.test(text);

                if (pathLooksJob || textLooksJob) {
                    seen.add(href);
                    out.push({ href, text });
                }
            });
            return out;
        }, SITE_HOST);

        if (jobLinks.length === 0) {
            // Honest empty: the /careers/ page has no published vacancies.
            meta.listingHits = 0;
            meta.atsEmpty = true;
            console.log('  [gurkhatech] extracted 0 (careers page has no job listings)');
            return { items, meta };
        }

        meta.listingHits = jobLinks.length;
        safeDiscovered(progress, jobLinks.length);

        // --- 4. Visit each detail link -----------------------------------
        for (const link of jobLinks) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await loadPage(page, link.href);
                await delay(400 + Math.random() * 600);

                const detail = await page.evaluate(() => {
                    const h1El = document.querySelector('h1');
                    const title = h1El ? h1El.textContent.trim() : null;

                    // Longest prose paragraph as description.
                    let description = null;
                    let maxLen = 0;
                    document
                        .querySelectorAll('article p, main p, .entry-content p, .content p, p')
                        .forEach((p) => {
                            const t = p.textContent.trim();
                            if (t.length > maxLen && t.length > 80) {
                                maxLen = t.length;
                                description = t;
                            }
                        });

                    // Location.
                    let location = null;
                    const locEl = document.querySelector(
                        '[class*="location"], [class*="address"], [class*="place"]'
                    );
                    if (locEl) {
                        const t = locEl.textContent.trim();
                        if (t) location = t;
                    }
                    if (!location) {
                        const m = (document.body.innerText || '').match(
                            /(Kathmandu|Pokhara|Lalitpur|Bhaktapur|Biratnagar|Nepal)/i
                        );
                        if (m) location = m[0];
                    }

                    // Employment type.
                    const body = (document.body.innerText || '').toLowerCase();
                    let employmentType = null;
                    if (/full[\s-]?time/.test(body)) employmentType = 'full-time';
                    else if (/part[\s-]?time/.test(body)) employmentType = 'part-time';
                    else if (/internship|intern\b/.test(body)) employmentType = 'internship';
                    else if (/contract/.test(body)) employmentType = 'contract';

                    // Application deadline.
                    let applicationEndsRaw = null;
                    const dm = (document.body.innerText || '').match(
                        /(?:apply\s+by|deadline|closing\s+date)\s*[:\-]?\s*([^\n]{4,40})/i
                    );
                    if (dm) applicationEndsRaw = dm[1].trim();

                    return {
                        title,
                        description,
                        location,
                        employmentType,
                        applicationEndsRaw,
                        finalUrl: location.href
                    };
                });

                if (!detail.title) {
                    meta.detailParseFailures++;
                    continue;
                }

                items.push({
                    id: `gurkhatech-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    title: detail.title,

                    company: 'Gurkha Technology',
                    company_status: 'extracted',

                    description: detail.description || link.text || null,
                    description_status: detail.description ? 'extracted' : 'site_absent',
                    description_evidence: detail.description
                        ? undefined
                        : 'scanned article p / main p / .entry-content p / p on detail page',

                    date: null,
                    time: null,

                    location: detail.location,
                    location_status: detail.location ? 'extracted' : 'site_absent',
                    location_evidence: detail.location
                        ? undefined
                        : 'searched [class*=location], [class*=address], body text for Kathmandu/Pokhara/Nepal',

                    price: null,
                    organizer: 'Gurkha Technology',
                    category: 'jobs',
                    tags: ['jobs', 'nepal'],
                    image: null,

                    url: detail.finalUrl,
                    registrationUrl: detail.finalUrl,

                    employmentType: detail.employmentType,
                    employmentType_status: detail.employmentType ? 'extracted' : 'extraction_failed',
                    employmentType_evidence: detail.employmentType
                        ? undefined
                        : 'scanned body text for full-time/part-time/contract/internship keywords',

                    applicationEndsRaw: detail.applicationEndsRaw,
                    applicationEndsRaw_status: detail.applicationEndsRaw ? 'extracted' : 'site_absent',
                    applicationEndsRaw_evidence: detail.applicationEndsRaw
                        ? undefined
                        : 'searched body text for apply by / deadline / closing date',

                    attendanceMode: 'in-person',
                    source: 'gurkhatech'
                });
            } catch (e) {
                if (e.message && e.message.includes('403')) continue;
                console.warn(`[gurkhatech] detail failed for ${link.href}: ${e.message}`);
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`  [gurkhatech] extracted ${items.length}`);
        return { items, meta };
    }
};