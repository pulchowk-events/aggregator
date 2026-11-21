const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { cleanDescriptionText, trimDescriptionToLastSentence } = require('../../text');
const { sanitizeJobFields } = require('../../jobs');

const BASE_URL = 'https://esignature.com.np';
const LISTING_URL = `${BASE_URL}/careers`;

const SOURCE = 'esignature-2';
const COMPANY = 'E-Signature Pvt. Ltd.';
const MAX_DESCRIPTION_LENGTH = 12000;

function absoluteUrl(href) {
    if (!href) return null;

    try {
        const url = new URL(href, BASE_URL);
        return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}

function normalizeText(value) {
    return String(value || '')
        .replace(/\uFEFF/g, '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractLocation(description) {
    const match = description.match(
        /(?:^|\n)\s*Location\s*:\s*([^\n]+)/i
    );

    if (!match) return null;

    const location = normalizeText(match[1]);

    return location.length < 80 ? location : null;
}

function extractSalary(text) {
    const match = text.match(
        /(?:salary|compensation|remuneration)\s*[:\-]\s*([^\n]+)/i
    );

    if (!match) return null;

    const value = normalizeText(match[1]);

    if (value.length > 60) return null;
    if (!/\d|negotiable|competitive/i.test(value)) return null;

    return value;
}

function extractEmploymentType(text) {
    if (/\bintern(ship)?\b/i.test(text)) return 'Internship';
    if (/\bpart[\s-]?time\b/i.test(text)) return 'Part-time';
    if (/\bcontract\b/i.test(text)) return 'Contract';
    if (/\bfull[\s-]?time\b/i.test(text)) return 'Full-time';

    return null;
}

function extractExperience(text) {
    const match = text.match(
        /(?:experience|required experience)\s*[:\-]?\s*([^.\n]+)/i
    );

    return match ? normalizeText(match[1]).slice(0, 100) : null;
}

function extractSkills(text) {
    const knownSkills = [
        'JavaScript',
        'TypeScript',
        'React',
        'ReactJS',
        'Node.js',
        'PHP',
        'Laravel',
        'Python',
        'WordPress',
        'SEO',
        'HTML',
        'CSS',
        'MySQL',
        'MongoDB',
        'Content Writing',
        'Digital Marketing',
        'Quality Assurance',
        'Software Testing'
    ];

    const found = new Set();

    for (const skill of knownSkills) {
        const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(escaped, 'i').test(text)) {
            found.add(skill);
        }
    }

    return Array.from(found);
}

function extractDescription(text) {
    let description = normalizeText(text);

    // Remove the generic company introduction from the job description.
    const descriptionStart = description.search(
        /DETAILED JOB DESCRIPTION\s*\/?\s*REQUIREMENTS\s*:/i
    );

    if (descriptionStart !== -1) {
        description = description.slice(descriptionStart);
    }

    // Remove application contact instructions from the role description.
    description = description.replace(
        /Note\s*:\s*Please include your CV[\s\S]*$/i,
        ''
    );

    description = description.replace(
        /\s*Location\s*:\s*[^\n]+$/i,
        ''
    );

    description = cleanDescriptionText(description);

    if (!description) return null;

    description = trimDescriptionToLastSentence(description);

    return normalizeText(description).slice(0, MAX_DESCRIPTION_LENGTH) || null;
}

async function scrapeListingCards(page) {
    return page.evaluate(() => {
        const getText = (element) => {
            if (!element) return '';

            return (element.innerText || element.textContent || '')
                .replace(/\uFEFF/g, '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        };

        return Array.from(document.querySelectorAll('div.openP'))
            .map((card) => {
                const titleElement = card.querySelector(
                    '.c-open__list-title .subt1'
                );

                const contentElement = card.querySelector(
                    '.collapse .caption.body1.text-custom'
                ) || card.querySelector('.collapse .caption');

                const applyLink = card.querySelector(
                    '.collapse .c-header-btn a[href*="/career/job-apply/"]'
                ) || card.querySelector(
                    'a[href*="/career/job-apply/"]'
                );

                if (!titleElement || !applyLink) return null;

                const href = applyLink.getAttribute('href');

                if (!href || !/\/career\/job-apply\/[^/]+/i.test(href)) {
                    return null;
                }

                const description = contentElement
                    ? getText(contentElement)
                    : '';

                return {
                    title: getText(titleElement),
                    href,
                    description
                };
            })
            .filter((item) => item.title && item.href);
    });
}

async function scrapeDetailPage(page) {
    return page.evaluate(() => {
        const getText = (element) => {
            if (!element) return '';

            return (element.innerText || element.textContent || '')
                .replace(/\uFEFF/g, '')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        };

        const titleElement = document.querySelector(
            'h3:not(.contacts-form__title)'
        );

        const descriptionSelectors = [
            '.job-description',
            '.job-detail',
            '.job-description-wrap',
            '.job-details',
            '[class*="job-description"]',
            '[class*="role-body"]',
            '[class*="job-detail"]'
        ];

        let description = '';

        for (const selector of descriptionSelectors) {
            const element = document.querySelector(selector);
            const text = getText(element);

            if (text.length > description.length) {
                description = text;
            }
        }

        const bodyText = getText(document.body);

        const applicationEndsMatch = bodyText.match(
            /(?:application deadline|apply before|closing date|last date|deadline)\s*[:\-]\s*([^\n]+)/i
        );

        const salaryMatch = bodyText.match(
            /(?:salary|compensation|remuneration)\s*[:\-]\s*([^\n]+)/i
        );

        const locationMatch = bodyText.match(
            /(?:job location|location)\s*[:\-]\s*([^\n]+)/i
        );

        return {
            title: getText(titleElement),
            description,
            applicationEndsRaw: applicationEndsMatch
                ? applicationEndsMatch[1]
                : null,
            salary: salaryMatch ? salaryMatch[1] : null,
            location: locationMatch ? locationMatch[1] : null,
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
        const seenUrls = new Set();

        meta.atsEmpty = false;

        meta.pagesVisited++;

        await loadPage(page, LISTING_URL);
        await delay(1200);

        // Check the initial listing page for blocking.
        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch {
            // Diagnostics are best-effort.
        }

        const emptyState = await page.evaluate(() => {
            const text = (document.body?.innerText || '').toLowerCase();

            return [
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
            ].some((phrase) => text.includes(phrase));
        });

        const entries = await scrapeListingCards(page);

        if (!entries.length) {
            meta.listingHits = 0;

            if (emptyState) {
                meta.atsEmpty = true;
            }

            safeDiscovered(progress, 0);

            console.log('  [esignature-2] extracted 0');

            return { items, meta };
        }

        // The accordion cards contain the actual role descriptions.
        // The /career/job-apply/{slug} URLs are still visited individually.
        const uniqueEntries = [];

        for (const entry of entries) {
            const url = absoluteUrl(entry.href);

            if (!url || seenUrls.has(url)) continue;

            seenUrls.add(url);

            uniqueEntries.push({
                ...entry,
                url
            });
        }

        meta.listingHits = uniqueEntries.length;
        safeDiscovered(progress, uniqueEntries.length);

        for (const entry of uniqueEntries) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                await loadPage(page, entry.url);
                await delay(500);

                let detail = {
                    title: null,
                    description: '',
                    applicationEndsRaw: null,
                    salary: null,
                    location: null,
                    bodyText: ''
                };

                try {
                    detail = await scrapeDetailPage(page);
                } catch {
                    meta.detailParseFailures++;
                }

                const title = normalizeText(
                    detail.title && !/careers|e-signature/i.test(detail.title)
                        ? detail.title
                        : entry.title
                );

                if (!title) {
                    meta.detailParseFailures++;
                    continue;
                }

                const listingDescription = extractDescription(
                    entry.description
                );

                const detailDescription = extractDescription(
                    detail.description
                );

                // Prefer the actual accordion role body when the application
                // page only exposes a form or generic company content.
                const description = listingDescription ||
                    detailDescription ||
                    null;

                const combinedText = [
                    entry.description,
                    detail.bodyText
                ].join(' ');

                const location = extractLocation(entry.description) ||
                    normalizeText(detail.location || '') ||
                    null;

                const salary = extractSalary(entry.description) ||
                    extractSalary(detail.salary || '') ||
                    null;

                const employmentType = extractEmploymentType(combinedText);
                const experience = extractExperience(combinedText);
                const skills = extractSkills(combinedText);

                const applicationEndsRaw = detail.applicationEndsRaw
                    ? normalizeText(detail.applicationEndsRaw)
                    : null;

                const job = {
                    id: `esignature-${Buffer.from(entry.url)
                        .toString('base64')
                        .replace(/[^a-zA-Z0-9]/g, '')
                        .slice(0, 32)}`,

                    title,

                    company: COMPANY,
                    company_status: 'extracted',
                    company_evidence:
                        'E-Signature Pvt. Ltd. (ES) is explicitly named ' +
                        'in the listing accordion introduction.',

                    companyUrl: BASE_URL,
                    companyLogoUrl: null,

                    location,
                    location_status: location ? 'extracted' : 'site_absent',
                    location_evidence: location
                        ? 'Extracted from the listing description Location field.'
                        : 'Searched listing accordion text and detail-page ' +
                          'location labels; no job-specific location found.',

                    employmentType,
                    employmentType_status: employmentType
                        ? 'extracted'
                        : 'site_absent',
                    employmentType_evidence: employmentType
                        ? 'Classified from employment-related listing text.'
                        : 'No explicit full-time, part-time, contract, or ' +
                          'internship classification found.',

                    attendanceMode: location && /remote/i.test(location)
                        ? 'Remote'
                        : null,

                    salary,
                    salary_status: salary ? 'extracted' : 'site_absent',
                    salary_evidence: salary
                        ? 'Extracted from salary or compensation text.'
                        : 'Searched listing and detail-page salary fields; ' +
                          'no numeric or currency-based compensation found.',

                    experience,
                    level: null,
                    openings: null,

                    description,
                    description_status: description
                        ? 'extracted'
                        : 'site_absent',
                    description_evidence: description
                        ? 'Extracted from the div.openP accordion content, ' +
                          'starting at DETAILED JOB DESCRIPTION / REQUIREMENTS.'
                        : 'Searched .caption.body1.text-custom, .job-description, ' +
                          '.job-detail and role-body selectors.',

                    responsibilities: '',
                    requirements: '',
                    skills,

                    applicationEndsRaw,
                    applicationEndsRaw_status: applicationEndsRaw
                        ? 'extracted'
                        : 'site_absent',
                    applicationEndsRaw_evidence: applicationEndsRaw
                        ? 'Extracted from the detail-page application deadline.'
                        : 'Searched application deadline, apply before, ' +
                          'closing date, last date and deadline labels.',

                    publishedAt: null,

                    companyDescription: null,
                    companyLocation: null,
                    companyAddress: null,

                    url: entry.url,
                    registrationUrl: entry.url,

                    image: null,
                    image_status: 'site_absent',
                    image_evidence:
                        'No per-job image was present in the supplied listing ' +
                        'card HTML or detected detail-page evidence.',

                    source: SOURCE,
                    scrapedAt: Date.now()
                };

                sanitizeJobFields(job);

                items.push(job);
            } catch {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log('  [esignature-2] extracted ' + items.length);

        return { items, meta };
    }
};