const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { cleanDescriptionText } = require('../../text');
const { sanitizeJobFields } = require('../../jobs');

const BASE_URL = 'https://eminenceways.com';
const LISTING_URL = `${BASE_URL}/career`;

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        meta.pagesVisited = meta.pagesVisited || 0;
        meta.listingHits = 0;
        meta.detailPagesVisited = 0;
        meta.detailParseFailures = 0;

        // The entry URL is already the careers listing.
        // Its Bootstrap accordion contains complete job descriptions.
        // /home is a navigation link, NOT a job detail route.
        meta.pagesVisited++;

        await loadPage(page, LISTING_URL);
        await delay(800);

        // Check for Cloudflare or other blocking.
        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (error) {
            // Diagnostics are best-effort.
        }

        // Extract actual accordion-based job listings.
        const listings = await page.evaluate(() => {
            const getText = (el) => {
                if (!el) return null;
                return (el.innerText || el.textContent || '')
                    .replace(/\s+/g, ' ')
                    .trim() || null;
            };

            const cards = Array.from(
                document.querySelectorAll(
                    '#blogs .accordion-item'
                )
            );

            return cards.map((card) => {
                const titleEl = card.querySelector(
                    '.accordion-header .accordion-button'
                );

                const bodyEl = card.querySelector(
                    '.accordion-body'
                );

                if (!titleEl) return null;

                const title = getText(titleEl);

                if (!title) return null;

                // Read collapsed Bootstrap accordion content directly.
                // No clicking or interaction is necessary.
                let description = '';

                if (bodyEl) {
                    const clone = bodyEl.cloneNode(true);

                    clone.querySelectorAll(
                        'script, style, noscript'
                    ).forEach((el) => el.remove());

                    description = (
                        clone.innerText || clone.textContent || ''
                    ).replace(/\r/g, '').trim();
                }

                const imageEl = card.querySelector('img');
                const image = imageEl
                    ? imageEl.getAttribute('src')
                    : null;

                const headings = Array.from(
                    bodyEl ? bodyEl.querySelectorAll('h5, h6, strong') : []
                ).map(getText).filter(Boolean);

                const sections = {};

                if (bodyEl) {
                    let currentSection = null;

                    Array.from(bodyEl.children).forEach((el) => {
                        const tag = el.tagName.toLowerCase();
                        const text = getText(el);

                        if (!text) return;

                        if (
                            tag === 'h5' ||
                            tag === 'h6' ||
                            tag === 'strong'
                        ) {
                            currentSection = text.toLowerCase();
                            sections[currentSection] = [];
                        } else if (
                            currentSection &&
                            (tag === 'ul' || tag === 'ol')
                        ) {
                            sections[currentSection].push(
                                ...Array.from(el.querySelectorAll('li'))
                                    .map(getText)
                                    .filter(Boolean)
                            );
                        }
                    });
                }

                return {
                    title,
                    description,
                    image,
                    headings,
                    sections
                };
            }).filter(Boolean);
        });

        // Empty-state detection.
        const hasJobCards = listings.length > 0;

        const emptyState = await page.evaluate(() => {
            const body = (
                document.body?.innerText || ''
            ).toLowerCase();

            const phrases = [
                'no open positions',
                'no current openings',
                'no job openings',
                'no vacancies',
                'no any vacancy',
                'not hiring',
                'check back soon',
                'there are no open',
                'there are no current',
                'sorry, no positions available at this time'
            ];

            return phrases.some((phrase) => body.includes(phrase));
        });

        if (emptyState && !hasJobCards) {
            meta.atsEmpty = true;
            safeDiscovered(progress, 0);
            return { items, meta };
        }

        meta.listingHits = listings.length;
        safeDiscovered(progress, listings.length);

        const company = 'Eminence Ways Pvt. Ltd.';
        const companyUrl = BASE_URL;

        for (const listing of listings) {
            try {
                const title = listing.title;
                const description = listing.description
                    ? cleanDescriptionText(listing.description)
                    : null;

                if (!title) {
                    meta.detailParseFailures++;
                    continue;
                }

                const responsibilities = [];
                const requirements = [];

                for (const [section, values] of Object.entries(
                    listing.sections || {}
                )) {
                    if (
                        /responsibilit|duties|what you will do/i.test(section)
                    ) {
                        responsibilities.push(...values);
                    } else if (
                        /qualification|requirement|skill|experience/i.test(
                            section
                        )
                    ) {
                        requirements.push(...values);
                    }
                }

                const hasDescription = Boolean(
                    description && description.length > 30
                );

                const item = {
                    id: `eminenceways-2-${Buffer.from(title).toString('base64url')}`,

                    title,
                    title_status: 'extracted',

                    company,
                    company_status: 'extracted',
                    company_evidence:
                        'Eminence Ways Pvt. Ltd. identified in listing ' +
                        'footer copyright and company content.',

                    companyUrl,
                    companyLogoUrl: null,

                    location: null,
                    location_status: 'site_absent',
                    location_evidence:
                        'Searched accordion job content, headings and ' +
                        'listing metadata. Kathmandu appears in the site ' +
                        'footer only, not as a confirmed job location.',

                    description: hasDescription ? description : null,
                    description_status: hasDescription
                        ? 'extracted'
                        : 'site_absent',
                    description_evidence: hasDescription
                        ? 'Extracted from #blogs .accordion-item ' +
                          '.accordion-body, including collapsed content.'
                        : 'Attempted #blogs .accordion-item .accordion-body; ' +
                          'no usable role description found.',

                    employmentType: null,
                    employmentType_status: 'site_absent',
                    employmentType_evidence:
                        'Searched accordion title and body for ' +
                        'full-time, part-time, contract and internship ' +
                        'classification; none explicitly published.',

                    applicationEndsRaw: null,
                    applicationEndsRaw_status: 'site_absent',
                    applicationEndsRaw_evidence:
                        'Searched accordion content for application ' +
                        'deadlines and closing dates; none published.',

                    salary: null,
                    salary_status: 'site_absent',
                    salary_evidence:
                        'Searched complete accordion body for salary, ' +
                        'compensation and remuneration information; none found.',

                    image: null,
                    image_status: listing.image
                        ? 'extraction_failed'
                        : 'site_absent',
                    image_evidence: listing.image
                        ? 'An image element exists but no verified ' +
                          'per-job image was established.'
                        : 'No per-job image exists in the accordion card.',

                    experience: null,
                    level: null,
                    openings: null,

                    responsibilities,
                    requirements,
                    skills: [],

                    companyDescription: null,
                    companyLocation: null,
                    companyAddress: null,

                    attendanceMode: null,

                    url: LISTING_URL,
                    url_status: 'extracted',
                    url_evidence:
                        'The accordion contains the complete job listing ' +
                        'without a separate detail-page URL.',

                    registrationUrl: null,

                    source: 'eminenceways-2',
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

        // No per-role navigation: descriptions are already present
        // in the listing page's collapsed Bootstrap accordion.
        console.log(
            '  [eminenceways-2] extracted ' + items.length + ' job(s)'
        );

        return { items, meta };
    }
};