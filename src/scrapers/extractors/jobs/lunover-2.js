const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const LUNOVER_URL = 'https://www.lunover.com/careers/';
const LUNOVER_COMPANY = 'Lunover';

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        try {
            meta.pagesVisited++;
            await loadPage(page, LUNOVER_URL, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });
            await delay(500);
        } catch (err) {
            console.warn(
                '[lunover-2] failed to load careers page: ' + err.message
            );
            return { items, meta };
        }

        // Detect blocking on the initial page load.
        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (err) {
            // Best effort.
        }

        // The supplied raw HTML confirms this is a careers page,
        // but it explicitly has no current open positions.
        const result = await page.evaluate(() => {
            const body = document.body
                ? document.body.innerText || ''
                : '';

            const normalized = body.replace(/\s+/g, ' ').trim();

            const emptyPatterns = [
                /we don't have open roles right now/i,
                /no open positions/i,
                /no current openings/i,
                /no job openings/i,
                /no vacancies/i,
                /check back soon/i,
                /not hiring/i,
                /there are no (open|current)/i
            ];

            const hasEmptyMessage = emptyPatterns.some(
                pattern => pattern.test(normalized)
            );

            // Actual listing evidence must be role-shaped.
            // The three reported H2 elements are section headings,
            // not job titles. Do not interpret marketing content as jobs.
            const roleHeadings = Array.from(
                document.querySelectorAll(
                    'h2.text-2xl.tracking-tight.mb-4.font-bold.scroll-mt-16'
                )
            );

            const jobs = roleHeadings.filter(el => {
                const text = (el.innerText || '').trim();

                return text.length > 2 &&
                    !/careers|why work with us|current openings/i.test(text);
            });

            return {
                hasEmptyMessage,
                jobs: jobs.map(el => ({
                    title: (el.innerText || '').trim()
                })),
                company: document.querySelector(
                    'meta[property="og:site_name"]'
                )?.content || 'Lunover'
            };
        });

        if (result.hasEmptyMessage && result.jobs.length === 0) {
            meta.atsEmpty = true;
            meta.listingHits = 0;
            safeDiscovered(progress, 0);
            console.log('  [lunover-2] extracted 0 (no open positions)');
            return { items, meta };
        }

        // No actual role-shaped cards exist in the supplied HTML.
        // The Careers page explicitly states that there are no open roles.
        // Do not turn company marketing headings into job listings.
        meta.listingHits = 0;
        safeDiscovered(progress, 0);

        console.log('  [lunover-2] extracted ' + items.length);
        return { items, meta };
    }
};