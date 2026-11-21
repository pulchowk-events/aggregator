const { loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const BASE_URL = 'https://www.cedargate.com';
const LISTING_URL = `${BASE_URL}/careers-2/`;

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        meta.pagesVisited++;
        await loadPage(page, LISTING_URL, { timeout: 60000 });

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (e) {
            // Best-effort page-state detection.
        }

        // The supplied evidence does not establish a jobs listing.
        // The apparent detail routes are platform marketing pages,
        // and the detected card wrappers are navigation components.
        const listing = await page.evaluate(() => {
            const bodyText = (document.body?.innerText || '')
                .replace(/\s+/g, ' ')
                .trim();

            const emptyPatterns = [
                /no open positions/i,
                /no current openings/i,
                /no job openings/i,
                /no vacancies/i,
                /not hiring/i,
                /check back soon/i,
                /there are no (open|current)/i,
                /sorry, no positions available at this time/i
            ];

            const emptyMessage = emptyPatterns.some((pattern) =>
                pattern.test(bodyText)
            );

            const headings = Array.from(
                document.querySelectorAll('h1, h2, h3, h4')
            );

            const roleHeadings = headings.filter((heading) => {
                const text = (heading.textContent || '').trim();
                return /\b(engineer|developer|designer|analyst|manager|intern|director|specialist|recruiter)\b/i
                    .test(text);
            });

            const jobLinks = Array.from(
                document.querySelectorAll('a[href]')
            ).filter((anchor) => {
                const href = anchor.getAttribute('href') || '';
                return /\/(job|jobs|career|careers|position|positions)\//i
                    .test(href);
            });

            return {
                emptyMessage,
                roleHeadingCount: roleHeadings.length,
                jobLinkCount: jobLinks.length
            };
        });

        meta.listingHits = 0;

        if (listing.emptyMessage && listing.roleHeadingCount === 0) {
            meta.atsEmpty = true;
        }

        safeDiscovered(progress, 0);

        console.log(
            '  [cedargate] extracted 0 jobs; careers listing not verified'
        );

        return { items, meta };
    }
};