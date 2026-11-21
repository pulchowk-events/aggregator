// VERDICT: CAREERS_PAGE
// The URL is a genuine careers page, but currently has no open positions.
// Corrected site type: single-page empty ATS listing.
// JSON-LD JobPosting: absent on listing and sample detail.
// The /service/* links are marketing pages, not job detail pages.
// Raw HTML confirms: .awsm-jobs-none-container
// Empty-state text: "We currently have no job openings"

const { loadPage } = require('../../page');
const { detectPageState } = require('../../diagnostics');

const AGILE_CAREER_URL = 'https://agile.com.np/career/';

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        meta.pagesVisited = (meta.pagesVisited || 0) + 1;

        await loadPage(page, AGILE_CAREER_URL);

        // Check for Cloudflare, captcha, or other blocking.
        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                meta.listingHits = 0;
                console.log('  [agile-2] Listing blocked');
                return { items, meta };
            }
        } catch (error) {
            // Continue with DOM inspection if diagnostics fail.
        }

        // Inspect the actual ATS listing, not navigation links.
        const listingState = await page.evaluate(() => {
            const normalize = (value) =>
                (value || '').replace(/\s+/g, ' ').trim();

            const bodyText = normalize(document.body?.innerText);

            const emptyPatterns = [
                /we currently have no job openings/i,
                /no open positions/i,
                /no current openings/i,
                /no job openings/i,
                /no vacancies/i,
                /no any vacancy/i,
                /there are no open positions/i,
                /there are no current positions/i,
                /check back soon/i,
                /not hiring/i
            ];

            const emptyMessage = emptyPatterns.some((pattern) =>
                pattern.test(bodyText)
            );

            const listing = document.querySelector('.awsm-job-listings');

            const emptyContainer = listing?.querySelector(
                '.awsm-jobs-none-container'
            );

            const emptyText = normalize(emptyContainer?.innerText);

            return {
                emptyMessage,
                emptyText,
                hasListing: Boolean(listing),
                listingText: normalize(listing?.innerText),
                pageTitle: document.title
            };
        });

        meta.listingHits = 0;

        if (listingState.emptyMessage) {
            meta.atsEmpty = true;
            console.log('  [agile-2] extracted 0 (no current job openings)');
            return { items, meta };
        }

        // No verified job-card or per-role detail selectors exist in
        // the supplied HTML evidence. Do not treat service links as jobs.
        if (!listingState.hasListing) {
            meta.atsEmpty = false;
            console.log('  [agile-2] extracted 0 (ATS listing not found)');
            return { items, meta };
        }

        console.log('  [agile-2] extracted 0 (no verified job records)');
        return { items, meta };
    }
};