// src/scrapers/extractors/jobs/bajratechnologies-2.js
// VERDICT: CAREERS_PAGE
//
// Corrections to wizard assumptions:
// - Entry URL is a careers page, but currently publishes no specific vacancies.
// - li.nav-item.tab-list__item is navigation chrome, NOT job cards.
// - No per-role detail pages or JobPosting JSON-LD exist.
// - H1.bjr-page-title and section belong to the unrelated Bajra AI product page.
// - "Current Openings" contains only a Contact us link.
// - "We're always on the lookout" refers to future opportunities, not an active job.
//
// Extraction strategy: single-page empty-state detection.

const { delay, loadPage } = require('../../page');
const { safeDiscovered } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const BAJRA_URL = 'https://bajratechnologies.com/jobs';
const COMPANY = 'Bajra Technologies Pvt. Ltd';

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        try {
            meta.pagesVisited++;

            await loadPage(page, BAJRA_URL, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            await delay(500);
        } catch (err) {
            console.warn(
                '  [bajratechnologies-2] failed to load careers page: ' +
                err.message
            );
            return { items, meta };
        }

        // Check for Cloudflare, captcha, or other blocking.
        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (_) {
            // Best-effort diagnostics.
        }

        // Inspect the actual careers listing, not unrelated product pages.
        let result;

        try {
            result = await page.evaluate(() => {
                const clean = (value) =>
                    (value || '').replace(/\s+/g, ' ').trim();

                const body = clean(document.body?.innerText);
                const headings = Array.from(
                    document.querySelectorAll('h1, h2, h3')
                ).map((el) => clean(el.innerText));

                // The wizard's three li.nav-item.tab-list__item
                // elements are navigation elements, not vacancies.
                const navigationCards = Array.from(
                    document.querySelectorAll(
                        'li.nav-item.tab-list__item'
                    )
                );

                // Look for actual role-shaped content.
                const possibleRoles = Array.from(
                    document.querySelectorAll(
                        'article, [class*="job-card"], ' +
                        '[class*="career-card"], [class*="vacancy"]'
                    )
                ).filter((el) => {
                    if (el.closest('header, footer, nav')) return false;

                    const text = clean(el.innerText);

                    if (text.length < 30) return false;

                    return /\b(job|position|vacancy|internship|engineer|developer|analyst)\b/i
                        .test(text);
                });

                // Detect explicit empty-careers messaging.
                const emptyPatterns = [
                    /no open positions/i,
                    /no current openings/i,
                    /no job openings/i,
                    /no vacancies/i,
                    /no any vacancy/i,
                    /we are always hiring/i,
                    /always on the lookout/i,
                    /not hiring/i,
                    /check back soon/i,
                    /there are no open/i,
                    /there are no current/i,
                    /sorry,\s*no positions available/i
                ];

                const emptyMessage = emptyPatterns.some(
                    (pattern) => pattern.test(body)
                );

                // Verify that the Current Openings section contains
                // no actual job titles or descriptions.
                const currentOpenings = headings.some(
                    (heading) =>
                        /^current openings$/i.test(heading)
                );

                const contactOnly = Array.from(
                    document.querySelectorAll('a[href]')
                ).some((anchor) => {
                    const text = clean(anchor.innerText);
                    const href = anchor.getAttribute('href') || '';

                    return (
                        currentOpenings &&
                        /contact us/i.test(text) &&
                        /contactus/i.test(href)
                    );
                });

                const siteName =
                    document.querySelector('meta[property="og:site:name"]')
                        ?.content ||
                    document.querySelector(
                        'meta[name="application-name"]'
                    )?.content ||
                    'Bajra Technologies Pvt. Ltd';

                return {
                    body,
                    headings,
                    siteName,
                    navigationCardCount: navigationCards.length,
                    roleCardCount: possibleRoles.length,
                    emptyMessage,
                    currentOpenings,
                    contactOnly
                };
            });
        } catch (err) {
            console.warn(
                '  [bajratechnologies-2] listing inspection failed: ' +
                err.message
            );

            return { items, meta };
        }

        meta.listingHits = 0;
        safeDiscovered(progress, 0);

        // No actual role cards exist. The listing offers contact
        // information and a general resume submission instead.
        if (
            result.roleCardCount === 0 &&
            (
                result.emptyMessage ||
                (result.currentOpenings && result.contactOnly)
            )
        ) {
            meta.atsEmpty = true;
            console.log(
                '  [bajratechnologies-2] extracted 0 (no published vacancies)'
            );

            return { items, meta };
        }

        // Do not manufacture jobs from navigation, FAQ content,
        // marketing copy, or unrelated product pages.
        console.log(
            '  [bajratechnologies-2] extracted 0 (no verified job cards)'
        );

        return { items, meta };
    }
};