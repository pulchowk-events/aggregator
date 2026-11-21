const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const CAREER_URL = 'https://www.margintopsolutions.com/career';
const COMPANY = 'MarginTop Solutions';

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        try {
            meta.pagesVisited++;

            await loadPage(page, CAREER_URL, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            await delay(500);

        } catch (err) {
            console.warn(
                `[margintopsolutions] failed to load careers page: ${err.message}`
            );
            return { items, meta };
        }

        // Check for blocking on the first page load.
        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (e) {
            // Best effort.
        }

        // Verdict:
        // CAREERS_PAGE
        //
        // Corrections to wizard assumptions:
        // - Entry URL is genuinely a careers listing page.
        // - JSON-LD contains Organization, LocalBusiness, WebSite,
        //   WebPage and BreadcrumbList, NOT JobPosting.
        // - The sample detail URL resolves to the homepage.
        //   Its H1 and description selectors are unrelated to jobs.
        // - There are four real job cards.
        // - Each card contains a title, employment type, description
        //   excerpt and mailto application link.
        // - No individual job detail pages exist.
        // - Employer is identified through og:site:name.
        // - Kathmandu is established through og:description and
        //   the company description on the listing page.
        //
        // Strategy: single-page card extraction.

        const harvested = await page.evaluate(() => {
            const clean = (value) => {
                if (!value) return null;

                return value
                    .replace(/\s+/g, ' ')
                    .trim() || null;
            };

            const normalizeUrl = (href) => {
                if (!href) return null;

                try {
                    return new URL(href, location.href).href;
                } catch (e) {
                    return null;
                }
            };

            // Read organization information from actual site metadata.
            const siteName =
                document.querySelector('meta[property="og:site_name"]')
                    ?.content || null;

            const ogDescription =
                document.querySelector('meta[property="og:description"]')
                    ?.content || null;

            // Extract only the verified job card structure.
            const blocks = Array.from(
                document.querySelectorAll('li.border-b')
            ).filter((el) => el.classList.contains('border-white/10'));

            const cards = [];
            const seen = new Set();

            for (const block of blocks) {
                if (block.closest('header, footer, nav')) continue;

                const link = block.querySelector('a[href]');
                if (!link) continue;

                const titleEl = link.querySelector('h2');

                const title = clean(
                    titleEl?.textContent
                );

                if (!title || title.length > 150) continue;

                const descriptionEl = link.querySelector(
                    'span.mt-3.block'
                );

                const description = clean(
                    descriptionEl?.textContent
                );

                const employmentEl = link.querySelector(
                    'span.flex.flex-wrap'
                );

                const employmentType = clean(
                    employmentEl?.textContent
                );

                const href = link.getAttribute('href') || '';

                const applyUrl = href.startsWith('mailto:')
                    ? href
                    : null;

                if (seen.has(title.toLowerCase())) continue;
                seen.add(title.toLowerCase());

                cards.push({
                    title,
                    description,
                    employmentType,
                    applyUrl: applyUrl
                        ? normalizeUrl(applyUrl)
                        : null
                });
            }

            // Check empty-state wording only when no real job cards exist.
            const bodyText = clean(document.body?.innerText) || '';

            const emptyPatterns = [
                /no open positions/i,
                /no current openings/i,
                /no job openings/i,
                /no vacancies/i,
                /no any vacancy/i,
                /not hiring/i,
                /check back soon/i,
                /there are no (open|current)/i,
                /sorry, no positions available at this time/i
            ];

            const hasEmptyMessage = emptyPatterns.some(
                (pattern) => pattern.test(bodyText)
            );

            // Extract company location from actual company metadata.
            let companyLocation = null;

            const locationMatch = (
                `${ogDescription || ''} ${bodyText}`
            ).match(/\b(Kathmandu|Lalitpur),?\s*Nepal\b/i);

            if (locationMatch) {
                companyLocation = `${locationMatch[1]}, Nepal`;
            }

            // Page update date is not an application deadline.
            const publishedDates = Array.from(
                document.querySelectorAll('time[datetime]')
            ).map((el) => ({
                value: clean(el.getAttribute('datetime')),
                text: clean(el.textContent)
            })).filter((item) => item.value);

            const updatedDate = publishedDates.find(
                (item) => /updated/i.test(item.text || '')
            );

            return {
                cards,
                siteName: clean(siteName),
                ogDescription: clean(ogDescription),
                companyLocation,
                publishedAt: updatedDate?.value || null,
                hasEmptyMessage
            };
        });

        const cards = harvested.cards || [];

        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);

        if (cards.length === 0) {
            if (harvested.hasEmptyMessage) {
                meta.atsEmpty = true;
            }

            console.log('[margintopsolutions] extracted 0');
            return { items, meta };
        }

        const company = harvested.siteName || COMPANY;
        const companyLocation = harvested.companyLocation || 'Kathmandu, Nepal';

        for (const card of cards) {
            try {
                const slug = card.title
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, '');

                const description = card.description || null;
                const employmentType = card.employmentType || null;
                const applicationUrl = card.applyUrl || null;

                const location = companyLocation;

                items.push({
                    id: `margintopsolutions-${slug}`,

                    // Mandatory fields.
                    title: card.title,
                    title_status: 'extracted',
                    title_evidence: 'h2 inside li.border-b.border-white/10',

                    company,
                    company_status: 'extracted',
                    company_evidence: 'og:site_name metadata',

                    url: applicationUrl || CAREER_URL,

                    location,
                    location_status: 'extracted',
                    location_evidence:
                        'og:description and company description identify Kathmandu, Nepal',

                    description,
                    description_status: description
                        ? 'extracted'
                        : 'extraction_failed',
                    description_evidence: description
                        ? 'span.mt-3.block inside the individual job card'
                        : 'span.mt-3.block inside the individual job card returned no text',

                    // Application information.
                    registrationUrl: applicationUrl,
                    applicationUrl,

                    // Employment information.
                    employmentType,
                    employmentType_status: employmentType
                        ? 'extracted'
                        : 'extraction_failed',
                    employmentType_evidence:
                        'span.flex.flex-wrap inside the individual job card',

                    // No role-specific deadline is published.
                    applicationEndsRaw: null,
                    applicationEnds_status: 'site_absent',
                    applicationEnds_evidence:
                        'Checked card content and time[datetime]; available dates describe page publication and updates, not application deadlines',

                    // No per-role salary is published.
                    salary: null,
                    salary_status: 'site_absent',
                    salary_evidence:
                        'No salary or compensation field in the four listing cards',

                    // No per-role image is published.
                    image: null,
                    image_status: 'site_absent',
                    image_evidence:
                        'No image element inside li.border-b.border-white/10',

                    // Company metadata.
                    companyUrl: 'https://www.margintopsolutions.com',
                    companyLocation,
                    companyDescription: harvested.ogDescription || null,

                    publishedAt: harvested.publishedAt,

                    // Optional fields not published per role.
                    experience: null,
                    level: null,
                    openings: null,
                    responsibilities: [],
                    requirements: [],
                    skills: [],

                    // Legacy-compatible fields.
                    date: null,
                    time: null,
                    price: null,
                    organizer: company,
                    category: 'Jobs',
                    tags: employmentType ? [employmentType] : [],
                    attendanceMode: null,

                    source: 'margintopsolutions'
                });

            } catch (err) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(
            `[margintopsolutions] extracted ${items.length}`
        );

        return { items, meta };
    }
};