// VERDICT: CAREERS_PAGE
// Entry URL is the EKbana careers/jobs listing, currently displaying
// "No Jobs Found". The internship page is informational, not a job detail page.
// No role-shaped cards exist. Do not treat navigation links as job listings.

const { loadPage } = require('../../page');
const { detectPageState } = require('../../diagnostics');

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        meta.pagesVisited++;

        await loadPage(page, 'https://careers.ekbana.com/');

        // Check for Cloudflare, CAPTCHA, or other blocking.
        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                meta.listingHits = 0;
                console.log('  [ekbana-2] listing blocked');
                return { items, meta };
            }
        } catch (error) {
            // Page-state detection is best-effort.
        }

        const listingState = await page.evaluate(() => {
            const bodyText = (document.body?.innerText || '')
                .replace(/\s+/g, ' ')
                .trim();

            const resultContainer = document.querySelector(
                '.allresult-wraps'
            );

            const resultText = (resultContainer?.innerText || '')
                .replace(/\s+/g, ' ')
                .trim();

            const emptyPatterns = [
                /no jobs found/i,
                /no open positions/i,
                /no current openings/i,
                /no job openings/i,
                /no vacancies/i,
                /no any vacancy/i,
                /not hiring/i,
                /check back soon/i,
                /sorry, no positions available/i
            ];

            const isEmpty = emptyPatterns.some((pattern) =>
                pattern.test(resultText || bodyText)
            );

            // Do not mistake navigation links for job cards.
            // The observed li.nav-item elements are site navigation.
            const navigationLinks = Array.from(
                document.querySelectorAll('li.nav-item a[href]')
            );

            const jobCards = Array.from(
                document.querySelectorAll(
                    '.allresult-wraps .result'
                )
            ).filter((card) => {
                const text = card.innerText || '';
                const hasTitle = Boolean(
                    card.querySelector('h1, h2, h3, h4')
                );
                const hasJobLink = Array.from(
                    card.querySelectorAll('a[href]')
                ).some((a) =>
                    /apply|job|position|vacancy/i.test(
                        (a.innerText || '') + ' ' + a.href
                    )
                );

                return (
                    hasTitle &&
                    hasJobLink &&
                    !/no jobs found/i.test(text)
                );
            });

            return {
                isEmpty,
                bodyText,
                resultText,
                jobCardCount: jobCards.length,
                navigationLinkCount: navigationLinks.length
            };
        });

        // The supplied listing HTML explicitly contains "No Jobs Found".
        // Its four li.nav-item elements are navigation, not employment cards.
        if (
            listingState.isEmpty &&
            listingState.jobCardCount === 0
        ) {
            meta.listingHits = 0;
            meta.atsEmpty = true;
            console.log('  [ekbana-2] extracted 0 jobs (empty careers page)');
            return { items, meta };
        }

        // No verified job-card structure is available in the supplied HTML.
        // Do not manufacture jobs from the internship information page.
        meta.listingHits = 0;

        console.log('  [ekbana-2] extracted 0 jobs');
        return { items, meta };
    }
};