const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { sanitizeJobFields } = require('../../jobs');
const {
    cleanDescriptionText
} = require('../../text');

const BASE_URL = 'https://www.evolveasia.co';
const LISTING_URL = `${BASE_URL}/layouts/job-list.html`;
const SOURCE = 'evolveasia-2';

async function collectListingJobs(page) {
    return page.evaluate(() => {
        const getText = (el) => el
            ? el.textContent.replace(/\s+/g, ' ').trim()
            : null;

        const cards = Array.from(
            document.querySelectorAll('div.job-list__item.icon')
        );

        return cards.map((card) => {
            const titleLink = card.querySelector('h3.title a[href]');
            const readMore = card.querySelector('a.button-plain[href]');
            const applyLink = card.querySelector('a.apply-btn[href]');

            const link = titleLink || readMore;
            if (!link) return null;

            return {
                title: getText(titleLink || link),
                href: link.getAttribute('href'),
                excerpt: getText(card.querySelector('p')),
                applyHref: applyLink
                    ? applyLink.getAttribute('href')
                    : null
            };
        }).filter((item) => item && item.href);
    });
}

async function scrapeDetail(page) {
    return page.evaluate(() => {
        const getText = (el) => el
            ? el.textContent.replace(/\s+/g, ' ').trim()
            : null;

        const role = document.querySelector(
            'section.job-wrap.detail .job-heading.icon'
        );

        const title = getText(
            role?.querySelector('h1')
        );

        const detail = role?.querySelector('.job-detail');

        let description = '';

        if (detail) {
            const parts = Array.from(
                detail.querySelectorAll('p, h3, li')
            ).map((el) => {
                const text = getText(el);
                if (!text) return '';

                return el.tagName === 'LI'
                    ? `• ${text}`
                    : el.tagName === 'H3'
                        ? `\n${text}\n`
                        : text;
            }).filter(Boolean);

            description = parts.join('\n');
        }

        // The company name is published in the site's address block.
        const addressElement = document.querySelector(
            '[class*="address"]'
        );

        const addressText = getText(addressElement);

        const companyMatch = addressText?.match(
            /Evolve\s+Pvt\.?\s*Ltd\.?/i
        );

        const company = companyMatch
            ? 'Evolve Pvt. Ltd.'
            : null;

        // The location link is part of the site-wide contact information.
        const locationElement = document.querySelector(
            '[class*="location"]'
        );

        const locationText = getText(locationElement);

        let location = null;

        if (locationText) {
            if (/thapathali/i.test(locationText)) {
                location = 'Thapathali, Kathmandu, Nepal';
            } else if (
                locationText.length < 80 &&
                /kathmandu|nepal/i.test(locationText)
            ) {
                location = locationText;
            }
        }

        // Check the page text for actual application deadline information.
        const bodyText = document.body.innerText || '';

        const deadlinePatterns = [
            /(?:application|apply)\s+(?:deadline|ends|before|by)\s*[:\-]?\s*([^\n]+)/i,
            /(?:closing|last)\s+date\s*[:\-]?\s*([^\n]+)/i,
            /(?:deadline|apply\s+by)\s*[:\-]?\s*([^\n]+)/i
        ];

        let applicationEndsRaw = null;

        for (const pattern of deadlinePatterns) {
            const match = bodyText.match(pattern);
            if (match && match[1]) {
                applicationEndsRaw = match[1].trim();
                break;
            }
        }

        // Salary is extracted only when a salary/compensation amount exists.
        const salaryPatterns = [
            /(?:salary|compensation|remuneration)\s*[:\-]?\s*([^\n]+)/i
        ];

        let salary = null;

        for (const pattern of salaryPatterns) {
            const match = bodyText.match(pattern);
            if (
                match &&
                match[1] &&
                /\d|npr|rs\.?|usd|\$|€|£/i.test(match[1])
            ) {
                salary = match[1].trim().slice(0, 59);
                break;
            }
        }

        // Employment type is not assumed from the role title.
        const employmentMatch = bodyText.match(
            /\b(full[\s-]?time|part[\s-]?time|contract|internship)\b/i
        );

        const employmentType = employmentMatch
            ? employmentMatch[1]
            : null;

        return {
            title,
            company,
            location,
            description,
            applicationEndsRaw,
            salary,
            employmentType,
            pageHasRole: Boolean(role),
            pageHasDescription: Boolean(detail),
            companyAddressText: addressText,
            locationEvidence: locationText,
            bodyText
        };
    });
}

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];
        const seen = new Set();

        meta.pagesVisited = meta.pagesVisited || 0;
        meta.listingHits = 0;
        meta.detailPagesVisited = 0;
        meta.detailParseFailures = 0;

        // Stage 1: Load and validate the actual careers listing.
        meta.pagesVisited++;

        await loadPage(page, LISTING_URL);
        await delay(1000);

        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (error) {
            // Page-state detection is best effort.
        }

        // Empty-state detection before harvesting cards.
        const pageState = await page.evaluate(() => {
            const text = (document.body.innerText || '').toLowerCase();

            const emptyPatterns = [
                'no open positions',
                'no current openings',
                'no job openings',
                'no vacancies',
                'no any vacancy',
                'we are always hiring',
                'always on the lookout',
                'not hiring',
                'check back soon',
                'there are no open',
                'there are no current',
                'sorry, no positions available at this time'
            ];

            const cards = document.querySelectorAll(
                'div.job-list__item.icon'
            );

            return {
                empty: emptyPatterns.some((pattern) =>
                    text.includes(pattern)
                ),
                hasCards: cards.length > 0
            };
        });

        if (pageState.empty && !pageState.hasCards) {
            meta.atsEmpty = true;
            meta.listingHits = 0;
            return { items, meta };
        }

        const entries = await collectListingJobs(page);

        const uniqueEntries = entries.filter((entry) => {
            if (!entry.href) return false;

            const absoluteUrl = new URL(
                entry.href,
                LISTING_URL
            ).href.split('#')[0];

            if (
                !absoluteUrl.startsWith(`${BASE_URL}/layouts/`) ||
                absoluteUrl === LISTING_URL ||
                seen.has(absoluteUrl)
            ) {
                return false;
            }

            seen.add(absoluteUrl);
            entry.url = absoluteUrl;

            return true;
        });

        meta.listingHits = uniqueEntries.length;

        safeDiscovered(progress, uniqueEntries.length);

        // Stage 2: Visit every individual job detail page.
        for (const entry of uniqueEntries) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                await loadPage(page, entry.url);
                await delay(500);

                const raw = await scrapeDetail(page);

                if (!raw.title && !entry.title) {
                    meta.detailParseFailures++;
                    continue;
                }

                const title = raw.title || entry.title;

                const description = raw.description
                    ? cleanDescriptionText(raw.description)
                    : entry.excerpt
                        ? cleanDescriptionText(entry.excerpt)
                        : null;

                const company = raw.company || null;
                const location = raw.location || null;

                const applicationEndsRaw =
                    raw.applicationEndsRaw || null;

                const salary = raw.salary || null;
                const employmentType = raw.employmentType || null;

                const finalUrl = entry.url;

                const item = {
                    id: `evolveasia-2-${encodeURIComponent(
                        finalUrl.split('/').pop().replace('.html', '')
                    )}`,

                    title,

                    title_status: 'extracted',

                    company,
                    company_status: company
                        ? 'extracted'
                        : 'extraction_failed',
                    company_evidence: company
                        ? 'Extracted Evolve Pvt. Ltd. from the [class*="address"] contact block.'
                        : 'Checked [class*="address"] and the company-name text in the site contact block.',

                    url: finalUrl,
                    url_status: 'extracted',

                    location,
                    location_status: location
                        ? 'extracted'
                        : 'extraction_failed',
                    location_evidence: location
                        ? 'Extracted from [class*="location"] and normalized the published Thapathali, Kathmandu office address.'
                        : 'Checked [class*="location"] on the detail page. No usable place-shaped location was returned.',

                    description,
                    description_status: description
                        ? 'extracted'
                        : 'extraction_failed',
                    description_evidence: description
                        ? 'Extracted unique role content from section.job-wrap.detail .job-heading.icon .job-detail, including paragraphs, requirements, responsibilities and benefits.'
                        : 'Checked .job-heading.icon .job-detail and the listing-card p excerpt.',

                    employmentType,
                    employmentType_status: employmentType
                        ? 'extracted'
                        : 'site_absent',
                    employmentType_evidence: employmentType
                        ? 'Matched an explicit employment-type phrase in the detail-page text.'
                        : 'Searched the complete detail-page text for full-time, part-time, contract and internship classifications.',

                    applicationEndsRaw,
                    applicationEndsRaw_status: applicationEndsRaw
                        ? 'extracted'
                        : 'site_absent',
                    applicationEndsRaw_evidence: applicationEndsRaw
                        ? 'Extracted an explicit application deadline from the detail-page text.'
                        : 'Searched the complete detail-page text for application deadline, apply-by, closing date and last date phrases.',

                    salary,
                    salary_status: salary
                        ? 'extracted'
                        : 'site_absent',
                    salary_evidence: salary
                        ? 'Extracted a numeric or currency-bearing salary value from the detail-page text.'
                        : 'Searched the detail-page text for salary, compensation and remuneration amounts. No numeric salary value found.',

                    image: null,
                    image_status: 'site_absent',
                    image_evidence: 'The listing cards and detail-page evidence contain no per-job image. The shared job-list banner is not treated as a job-specific image.',

                    experience: null,
                    level: null,
                    openings: null,

                    responsibilities: '',
                    requirements: '',
                    skills: [],

                    companyUrl: null,
                    companyLogoUrl: null,
                    companyDescription: null,
                    companyLocation: null,
                    companyAddress: null,

                    publishedAt: null,
                    attendanceMode: null,

                    registrationUrl: `${finalUrl}#form-section`,

                    source: SOURCE,
                    scrapedAt: Date.now()
                };

                sanitizeJobFields(item);

                items.push(item);
            } catch (error) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(
            `  [${SOURCE}] extracted ${items.length} of ${uniqueEntries.length} jobs`
        );

        return { items, meta };
    }
};