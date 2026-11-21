const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { sanitizeImageUrl } = require('../../sanitize');
const {
    cleanDescriptionText,
    trimDescriptionToLastSentence
} = require('../../text');

const BASE_URL = 'https://careers.hitachi.com';
const LISTING_URL = `${BASE_URL}/jobs`;
const MAX_LISTING_PAGES = 10;

function absoluteUrl(href) {
    if (!href) return null;

    try {
        return new URL(href, BASE_URL).href;
    } catch {
        return null;
    }
}

function cleanText(value) {
    if (!value) return null;
    return String(value).replace(/\s+/g, ' ').trim() || null;
}

function getJobId(url) {
    const match = url.match(/\/job\/([^/?#]+)/i);
    return match ? `hitachi-${match[1]}` : `hitachi-${url}`;
}

async function extractListing(page) {
    return page.evaluate(() => {
        const getText = (el) =>
            el ? el.textContent.replace(/\s+/g, ' ').trim() : null;

        const cards = Array.from(
            document.querySelectorAll('li.results-list__item')
        );

        const jobs = cards.map((card) => {
            const titleLink = card.querySelector(
                '.results-list__item-title--link[href]'
            );

            const applyLink = card.querySelector(
                '.results-list__item-apply[href]'
            );

            const link = titleLink || applyLink;

            if (!link) return null;

            return {
                title: getText(
                    card.querySelector('.results-list__item-title')
                ) || getText(link),

                url: link.getAttribute('href'),

                company: getText(
                    card.querySelector('.results-list__item-company--label')
                ),

                location: getText(
                    card.querySelector('.results-list__item-street--label')
                )
            };
        }).filter((job) => job && job.url);

        const nextLinks = Array.from(
            document.querySelectorAll(
                'a.page-link[href], a[rel="next"]'
            )
        );

        const nextPage = nextLinks.find((link) => {
            const text = (link.textContent || '').trim().toLowerCase();
            const href = link.getAttribute('href') || '';

            return (
                /\/jobs\/page\/\d+/.test(href) &&
                text !== 'previous' &&
                !link.classList.contains('disabled') &&
                link.getAttribute('aria-disabled') !== 'true'
            );
        });

        return {
            jobs,
            nextPage: nextPage
                ? nextPage.getAttribute('href')
                : null,
            bodyText: document.body.innerText || ''
        };
    });
}

async function extractDetail(page) {
    return page.evaluate(() => {
        const getText = (el) =>
            el ? el.textContent.replace(/\s+/g, ' ').trim() : null;

        const parseJsonLd = () => {
            const results = [];

            document.querySelectorAll(
                'script[type="application/ld+json"]'
            ).forEach((script) => {
                try {
                    const parsed = JSON.parse(script.textContent);

                    const collect = (value) => {
                        if (!value) return;

                        if (Array.isArray(value)) {
                            value.forEach(collect);
                            return;
                        }

                        if (typeof value !== 'object') return;

                        results.push(value);

                        if (value['@graph']) {
                            collect(value['@graph']);
                        }

                        if (value.itemListElement) {
                            collect(value.itemListElement);
                        }
                    };

                    collect(parsed);
                } catch {
                    // Ignore malformed structured data.
                }
            });

            return results;
        };

        const structuredData = parseJsonLd();

        const jobPosting = structuredData.find((entry) => {
            const type = entry['@type'];

            return Array.isArray(type)
                ? type.includes('JobPosting')
                : type === 'JobPosting';
        });

        const title = getText(
            document.querySelector('h1.jh__title')
        ) || jobPosting?.title || null;

        const descriptionElement =
            document.querySelector('section.jb .jb__content .description') ||
            document.querySelector('section.jb .description');

        let description = '';

        if (descriptionElement) {
            description = Array.from(
                descriptionElement.querySelectorAll('p, li')
            )
                .map((element) => {
                    const text = getText(element);

                    if (!text || text === '\u00a0') return null;

                    return element.tagName === 'LI'
                        ? `• ${text}`
                        : text;
                })
                .filter(Boolean)
                .join('\n');
        }

        if (!description && jobPosting?.description) {
            const temp = document.createElement('div');
            temp.innerHTML = jobPosting.description;

            description = getText(temp) || '';
        }

        const address = jobPosting?.jobLocation?.address;

        const structuredLocation = Array.isArray(address)
            ? address[0]
            : address;

        const locationFromStructured = structuredLocation
            ? [
                structuredLocation.addressLocality,
                structuredLocation.addressRegion,
                structuredLocation.addressCountry
            ].filter(Boolean).join(', ')
            : null;

        const locationFromDom = getText(
            document.querySelector(
                '[class*="location"] span:not([class*="icon"])'
            )
        );

        const companyObject =
            jobPosting?.hiringOrganization ||
            jobPosting?.organization ||
            null;

        const company = typeof companyObject === 'string'
            ? companyObject
            : companyObject?.name || null;

        const companyUrl = typeof companyObject === 'object'
            ? companyObject?.sameAs || companyObject?.url || null
            : null;

        const companyLogo = typeof companyObject === 'object'
            ? (
                typeof companyObject.logo === 'string'
                    ? companyObject.logo
                    : companyObject.logo?.url
            )
            : null;

        const applyLink = document.querySelector(
            'a#apply[href], a.apply-button[href]'
        );

        const salary = jobPosting?.baseSalary
            ? (
                typeof jobPosting.baseSalary === 'string'
                    ? jobPosting.baseSalary
                    : [
                        jobPosting.baseSalary.currency,
                        jobPosting.baseSalary.value?.minValue,
                        jobPosting.baseSalary.value?.maxValue
                    ].filter(Boolean).join(' ')
            )
            : getText(
                document.querySelector('[class*="salary"]')
            );

        const deadlineElement = Array.from(
            document.querySelectorAll('p, li, span, div')
        ).find((element) => {
            if (element.children.length > 2) return false;

            return /application deadline|apply by|closing date|job expires|valid through/i
                .test(element.textContent || '');
        });

        const deadlineText = getText(deadlineElement);

        const deadlineMatch = deadlineText
            ? deadlineText.match(
                /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/i
            )
            : null;

        const imageElement = document.querySelector(
            'meta[property="og:image"]'
        );

        return {
            title,
            company,
            companyUrl,
            companyLogo,
            location: locationFromStructured || locationFromDom,
            description,
            employmentType: jobPosting?.employmentType || null,
            salary,
            applicationEndsRaw:
                jobPosting?.validThrough || deadlineMatch?.[0] || null,
            publishedAt:
                jobPosting?.datePosted || null,
            image:
                imageElement?.content || null,
            applyUrl: applyLink?.getAttribute('href') || null,
            jobPostingFound: Boolean(jobPosting)
        };
    });
}

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];
        const listingMap = new Map();

        meta.atsEmpty = false;
        meta.listingHits = 0;

        try {
            meta.pagesVisited++;

            await loadPage(page, LISTING_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 25000
            });

            try {
                const state = await detectPageState(page);

                if (state.looksBlocked) {
                    meta.looksBlocked = true;
                    return { items, meta };
                }
            } catch {
                // Diagnostics are best-effort.
            }

            let listingUrl = LISTING_URL;
            const visitedListingPages = new Set();

            for (
                let pageNumber = 0;
                pageNumber < MAX_LISTING_PAGES;
                pageNumber++
            ) {
                if (visitedListingPages.has(listingUrl)) break;

                visitedListingPages.add(listingUrl);

                if (pageNumber > 0) {
                    try {
                        meta.pagesVisited++;

                        await loadPage(page, listingUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: 20000
                        });
                    } catch {
                        break;
                    }
                }

                const listing = await extractListing(page);

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

                const hasEmptyMessage = emptyPatterns.some(
                    (pattern) => pattern.test(listing.bodyText)
                );

                if (hasEmptyMessage && listing.jobs.length === 0) {
                    meta.atsEmpty = true;
                    break;
                }

                for (const job of listing.jobs) {
                    const url = absoluteUrl(job.url);

                    if (!url || !/\/job\/[A-Z0-9]+\/?$/i.test(
                        new URL(url).pathname
                    )) {
                        continue;
                    }

                    if (!listingMap.has(url)) {
                        listingMap.set(url, {
                            ...job,
                            url
                        });
                    }
                }

                const nextHref = listing.nextPage;

                if (!nextHref) break;

                const nextUrl = absoluteUrl(nextHref);

                if (!nextUrl || !nextUrl.startsWith(BASE_URL)) break;

                listingUrl = nextUrl;
            }

            const entries = Array.from(listingMap.values());

            meta.listingHits = entries.length;

            safeDiscovered(progress, entries.length);

            for (const entry of entries) {
                try {
                    meta.pagesVisited++;
                    meta.detailPagesVisited++;

                    await loadPage(page, entry.url, {
                        waitUntil: 'domcontentloaded',
                        timeout: 20000
                    });

                    const raw = await extractDetail(page);

                    const title = cleanText(raw.title || entry.title);

                    if (!title) {
                        meta.detailParseFailures++;
                        continue;
                    }

                    const descriptionText = cleanText(
                        raw.description
                    );

                    let description = '';

                    if (descriptionText) {
                        description = cleanDescriptionText(
                            descriptionText
                        );

                        description = trimDescriptionToLastSentence(
                            description
                        ) || description;
                    }

                    const company = cleanText(
                        entry.company || raw.company
                    );

                    const location = cleanText(
                        entry.location || raw.location
                    );

                    const employmentType = cleanText(
                        raw.employmentType
                    );

                    const salary = cleanText(raw.salary);

                    const applicationEndsRaw = cleanText(
                        raw.applicationEndsRaw
                    );

                    const companyUrl = absoluteUrl(raw.companyUrl);

                    const companyLogoUrl = sanitizeImageUrl(
                        absoluteUrl(raw.companyLogo)
                    );

                    const image = sanitizeImageUrl(
                        absoluteUrl(raw.image)
                    );

                    const registrationUrl =
                        absoluteUrl(raw.applyUrl) || entry.url;

                    const finalJob = {
                        id: getJobId(entry.url),

                        title,
                        title_status: 'extracted',

                        company,
                        company_status: company
                            ? 'extracted'
                            : 'site_absent',
                        company_evidence: company
                            ? 'Extracted from listing company label or JobPosting hiringOrganization.'
                            : 'Checked listing .results-list__item-company--label and detail JobPosting hiringOrganization.',

                        companyUrl,
                        companyLogoUrl,

                        location,
                        location_status: location
                            ? 'extracted'
                            : 'site_absent',
                        location_evidence: location
                            ? 'Extracted from listing .results-list__item-street--label or JobPosting jobLocation.'
                            : 'Checked listing .results-list__item-street--label and detail JobPosting jobLocation.address.',

                        employmentType,
                        employmentType_status: employmentType
                            ? 'extracted'
                            : 'site_absent',
                        employmentType_evidence: employmentType
                            ? 'Extracted from JobPosting employmentType.'
                            : 'Checked JobPosting employmentType.',

                        salary,
                        salary_status: salary
                            ? 'extracted'
                            : 'site_absent',
                        salary_evidence: salary
                            ? 'Extracted from JobPosting baseSalary or [class*="salary"].'
                            : 'Checked JobPosting baseSalary and [class*="salary"] on the detail page.',

                        applicationEndsRaw,
                        applicationEndsRaw_status: applicationEndsRaw
                            ? 'extracted'
                            : 'site_absent',
                        applicationEndsRaw_evidence: applicationEndsRaw
                            ? 'Extracted from JobPosting validThrough or application deadline text.'
                            : 'Checked JobPosting validThrough and visible application deadline, apply-by, closing date, and expiry labels.',

                        publishedAt: raw.publishedAt || null,

                        description: description || null,
                        description_status: description
                            ? 'extracted'
                            : 'site_absent',
                        description_evidence: description
                            ? 'Extracted from section.jb .jb__content .description or JobPosting description.'
                            : 'Checked section.jb .jb__content .description, section.jb .description, and JobPosting description.',

                        image: image || null,

                        experience: null,
                        level: null,
                        openings: null,
                        responsibilities: null,
                        requirements: null,
                        skills: [],

                        companyDescription: null,
                        companyLocation: null,
                        companyAddress: null,

                        attendanceMode: location &&
                            /remote/i.test(location)
                            ? 'Remote'
                            : (
                                location && /hybrid/i.test(location)
                                    ? 'Hybrid'
                                    : null
                            ),

                        url: entry.url,
                        registrationUrl,

                        source: 'hitachi',
                        scrapedAt: Date.now()
                    };

                    items.push(finalJob);
                } catch {
                    meta.detailParseFailures++;
                } finally {
                    safeUnitDone(progress);
                }
            }
        } catch (error) {
            console.warn(
                '[hitachi] Extraction error:',
                error.message
            );
        }

        console.log(
            '  [hitachi] extracted ' + items.length +
            ' jobs from ' + meta.listingHits + ' listing links'
        );

        return { items, meta };
    }
};