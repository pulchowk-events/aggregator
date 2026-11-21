// src/scrapers/extractors/jobs/lftechnology-2.js
// VERDICT: CAREERS_PAGE
//
// Recruitee ATS. Detail pages contain authoritative JobPosting JSON-LD.
// Excludes the Join our Talent Pool pseudo-job.
// Fixes previous salary truncation and explicitly checks DOM deadline labels.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const {
    trimDescriptionToLastSentence,
    cleanDescriptionText
} = require('../../text');

const CAREERS_URL = 'https://career.lftechnology.com/';
const SOURCE = 'lftechnology-2';
const COMPANY = 'Leapfrog Technology';
const TALENT_POOL = /join-our-talent-pool/i;

function slugify(value) {
    return String(value || 'role')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'role';
}

function stripHtml(value) {
    if (!value) return null;
    return String(value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim() || null;
}

function normalizeEmploymentType(value) {
    if (!value) return null;

    const text = String(value).toLowerCase();

    if (text.includes('full')) return 'full-time';
    if (text.includes('part')) return 'part-time';
    if (text.includes('contract')) return 'contract';
    if (text.includes('intern')) return 'internship';
    if (text.includes('temporary')) return 'temporary';

    return String(value).trim();
}

function normalizeLocation(jobLocation) {
    if (!jobLocation) return null;

    const locations = Array.isArray(jobLocation)
        ? jobLocation
        : [jobLocation];

    for (const location of locations) {
        if (!location) continue;

        const address = location.address || location;
        const parts = [];

        if (address.addressLocality) {
            parts.push(address.addressLocality);
        }

        if (
            address.addressRegion &&
            address.addressRegion !== address.addressLocality
        ) {
            parts.push(address.addressRegion);
        }

        if (address.addressCountry) {
            const country = String(address.addressCountry);

            parts.push(
                country.toUpperCase() === 'NP' ? 'Nepal' : country
            );
        }

        if (parts.length) {
            return parts.join(', ');
        }
    }

    return null;
}

function formatSalary(baseSalary) {
    if (!baseSalary) return null;

    if (Array.isArray(baseSalary)) {
        return formatSalary(baseSalary[0]);
    }

    if (typeof baseSalary === 'string') {
        return baseSalary.trim() || null;
    }

    if (typeof baseSalary !== 'object') {
        return null;
    }

    const value = baseSalary.value || baseSalary;
    const currency = baseSalary.currency || '';
    const unit = baseSalary.unitText || '';

    let amount = null;

    if (typeof value === 'object') {
        const min = value.minValue;
        const max = value.maxValue;

        if (min != null && max != null) {
            amount = `${min}-${max}`;
        } else if (min != null) {
            amount = String(min);
        } else if (max != null) {
            amount = String(max);
        } else if (value.value != null) {
            amount = String(value.value);
        }
    } else if (value != null) {
        amount = String(value);
    }

    if (!amount || !/\d/.test(amount)) return null;

    return [currency, amount, unit]
        .filter(Boolean)
        .join(' ')
        .trim() || null;
}

function extractSalaryFromText(text) {
    if (!text) return null;

    // Only accept complete numeric salary expressions.
    const patterns = [
        /\b(?:NPR|USD|INR)\s*[\d,]+(?:\.\d+)?(?:\s*[-–]\s*(?:NPR|USD|INR)?\s*[\d,]+(?:\.\d+)?)?(?:\s*(?:k|K|per month|\/month|per year|\/year|annually))?/i,
        /(?:Rs\.?|रु\.?)\s*[\d,]+(?:\.\d+)?(?:\s*[-–]\s*(?:Rs\.?|रु\.?)?\s*[\d,]+(?:\.\d+)?)?(?:\s*(?:k|K|per month|\/month|per year|\/year))?/i,
        /[$]\s*[\d,]+(?:\.\d+)?(?:\s*[-–]\s*[$]?\s*[\d,]+(?:\.\d+)?)?(?:\s*(?:k|K|per month|\/month|per year|\/year))?/i
    ];

    for (const pattern of patterns) {
        const match = String(text).match(pattern);

        if (match && /\d/.test(match[0])) {
            return match[0].trim();
        }
    }

    return null;
}

function classifyFromText(text) {
    const result = {
        employmentType: null,
        salary: null
    };

    if (!text) return result;

    const lower = text.toLowerCase();

    if (/\bfull[\s-]?time\b/.test(lower)) {
        result.employmentType = 'full-time';
    } else if (/\bpart[\s-]?time\b/.test(lower)) {
        result.employmentType = 'part-time';
    } else if (/\bintern(ship)?\b/.test(lower)) {
        result.employmentType = 'internship';
    } else if (/\bcontract(?:or)?\b/.test(lower)) {
        result.employmentType = 'contract';
    }

    result.salary = extractSalaryFromText(text);

    return result;
}

async function harvestJobLinks(page) {
    return page.evaluate(() => {
        const links = new Set();

        document.querySelectorAll('a[href]').forEach((anchor) => {
            const href = anchor.getAttribute('href');

            if (!href) return;

            let url;

            try {
                url = new URL(href, window.location.href);
            } catch (error) {
                return;
            }

            if (url.hostname !== 'career.lftechnology.com') return;

            if (!/^\/o\/[^/?#]+\/?$/.test(url.pathname)) return;

            if (/join-our-talent-pool/i.test(url.pathname)) return;

            url.hash = '';
            url.search = '';

            links.add(url.toString());
        });

        return Array.from(links);
    });
}

async function readDetail(page) {
    return page.evaluate(() => {
        function findJobPosting(value) {
            if (!value) return null;

            if (Array.isArray(value)) {
                for (const entry of value) {
                    const found = findJobPosting(entry);
                    if (found) return found;
                }

                return null;
            }

            if (typeof value !== 'object') return null;

            const types = Array.isArray(value['@type'])
                ? value['@type']
                : [value['@type']];

            if (types.includes('JobPosting')) {
                return value;
            }

            if (value['@graph']) {
                return findJobPosting(value['@graph']);
            }

            return null;
        }

        let jobPosting = null;

        for (const script of document.querySelectorAll(
            'script[type="application/ld+json"]'
        )) {
            try {
                const parsed = JSON.parse(script.textContent);
                jobPosting = findJobPosting(parsed);

                if (jobPosting) break;
            } catch (error) {
                // Ignore malformed structured data.
            }
        }

        function metaContent(name) {
            const element = document.querySelector(
                `meta[property="${name}"], meta[name="${name}"]`
            );

            return element
                ? element.getAttribute('content')
                : null;
        }

        function textOf(element) {
            return element
                ? (element.innerText || element.textContent || '').trim()
                : null;
        }

        const titleElement =
            document.querySelector('h1.sc-1lss5cy-2') ||
            document.querySelector('h1[class*="sc-1lss5cy"]') ||
            document.querySelector('main h1') ||
            document.querySelector('h1');

        const descriptionElement =
            document.querySelector('div.sc-1fwbcuw-0.iMCTcK') ||
            document.querySelector('[class*="job-description"]') ||
            document.querySelector('article');

        const locationElement =
            document.querySelector(
                'li.custom-css-style-job-location'
            ) ||
            document.querySelector('[class*="job-location"] li') ||
            document.querySelector('[class*="location"] li');

        const bodyText = document.body
            ? document.body.innerText || ''
            : '';

        // Look for an explicitly labelled application deadline.
        // Do not mistake datePosted for an application deadline.
        let deadlineFallback = null;

        const deadlineLabels = [
            /application\s*(?:deadline|closing date|ends|closes)/i,
            /apply\s*by/i,
            /applications?\s*(?:close|end)\s*(?:on)?/i,
            /closing\s*date/i,
            /last\s*date\s*to\s*apply/i
        ];

        const candidateElements = Array.from(
            document.querySelectorAll(
                'p, li, span, div, time, strong, label'
            )
        );

        for (const element of candidateElements) {
            const text = (element.innerText || '').trim();

            if (!text || text.length > 250) continue;

            if (!deadlineLabels.some((pattern) => pattern.test(text))) {
                continue;
            }

            const parentText = (
                element.parentElement?.innerText || text
            ).trim();

            if (parentText.length > 300) continue;

            const dateMatch = parentText.match(
                /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/. -]\d{1,2}[/. -]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b/i
            );

            if (dateMatch) {
                deadlineFallback = dateMatch[0];
                break;
            }
        }

        // Salary fallback requires an explicit salary label.
        let salaryFallback = null;

        const salaryLabels = [
            /salary/i,
            /compensation/i,
            /remuneration/i,
            /pay\s*range/i
        ];

        for (const element of candidateElements) {
            const text = (element.innerText || '').trim();

            if (!text || text.length > 250) continue;

            if (!salaryLabels.some((pattern) => pattern.test(text))) {
                continue;
            }

            salaryFallback = text;
            break;
        }

        let image = metaContent('og:image');

        if (!image) {
            const img = document.querySelector(
                'main img, article img'
            );

            if (img) {
                try {
                    image = window.__resolveImageSrc
                        ? window.__resolveImageSrc(img)
                        : (img.currentSrc || img.src);
                } catch (error) {
                    image = img.currentSrc || img.src || null;
                }
            }
        }

        return {
            jobPosting,
            titleFallback: textOf(titleElement),
            descriptionFallback: textOf(descriptionElement),
            locationFallback: textOf(locationElement),
            deadlineFallback,
            salaryFallback,
            bodyText,
            image,
            finalUrl: window.location.href,
            ogSiteName: metaContent('og:site_name'),
            ogTitle: metaContent('og:title')
        };
    });
}

function status(value) {
    return value ? 'extracted' : 'site_absent';
}

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];
        const seenUrls = new Set();
        const seenTitles = new Set();

        try {
            meta.pagesVisited++;

            await loadPage(page, CAREERS_URL);
            await delay(900 + Math.random() * 500);
        } catch (error) {
            return { items, meta };
        }

        // Detect blocking once on the initial listing load.
        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (error) {
            // Continue with best-effort extraction.
        }

        // Check for genuine empty states before harvesting links.
        let listingState;

        try {
            listingState = await page.evaluate(() => {
                const text = document.body?.innerText || '';

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
                    /there are no (open|current)/i,
                    /sorry, no positions available at this time/i
                ];

                const hasEmptyMessage = emptyPatterns.some(
                    (pattern) => pattern.test(text)
                );

                const hasJobLinks = Array.from(
                    document.querySelectorAll('a[href]')
                ).some((anchor) => {
                    const href = anchor.getAttribute('href') || '';

                    return /^\/o\/[^/?#]+\/?$/.test(href) &&
                        !/join-our-talent-pool/i.test(href);
                });

                return {
                    hasEmptyMessage,
                    hasJobLinks
                };
            });
        } catch (error) {
            listingState = {
                hasEmptyMessage: false,
                hasJobLinks: false
            };
        }

        if (
            listingState.hasEmptyMessage &&
            !listingState.hasJobLinks
        ) {
            meta.listingHits = 0;
            meta.atsEmpty = true;
            return { items, meta };
        }

        let links = [];

        try {
            links = await harvestJobLinks(page);
        } catch (error) {
            links = [];
        }

        links = Array.from(new Set(links));

        meta.listingHits = links.length;
        safeDiscovered(progress, links.length);

        if (!links.length) {
            meta.atsEmpty = true;
            return { items, meta };
        }

        // Visit individual Recruitee job detail pages.
        for (const link of links) {
            try {
                if (seenUrls.has(link)) continue;

                seenUrls.add(link);

                meta.pagesVisited++;
                meta.detailPagesVisited++;

                await loadPage(page, link);
                await delay(650 + Math.random() * 450);

                const data = await readDetail(page);

                if (!data) {
                    meta.detailParseFailures++;
                    continue;
                }

                const jp = data.jobPosting || {};

                const title = (
                    jp.title ||
                    data.titleFallback ||
                    ''
                ).trim();

                if (!title) {
                    meta.detailParseFailures++;
                    continue;
                }

                const titleKey = title.toLowerCase();

                if (seenTitles.has(titleKey)) continue;

                seenTitles.add(titleKey);

                const companyValue =
                    jp.hiringOrganization?.name ||
                    (
                        typeof jp.hiringOrganization === 'string'
                            ? jp.hiringOrganization
                            : null
                    ) ||
                    data.ogSiteName ||
                    COMPANY;

                const company = String(companyValue).trim();

                const jsonLocation = normalizeLocation(
                    jp.jobLocation
                );

                const location = (
                    jsonLocation ||
                    data.locationFallback ||
                    null
                );

                let rawDescription = jp.description
                    ? stripHtml(jp.description)
                    : data.descriptionFallback;

                let description = null;

                if (rawDescription) {
                    try {
                        description = trimDescriptionToLastSentence(
                            cleanDescriptionText(rawDescription),
                            6000
                        );
                    } catch (error) {
                        description = stripHtml(rawDescription);
                    }
                }

                const classified = classifyFromText(
                    [
                        description,
                        data.bodyText,
                        jp.employmentType
                    ].filter(Boolean).join(' ')
                );

                const employmentType =
                    normalizeEmploymentType(jp.employmentType) ||
                    classified.employmentType ||
                    null;

                // Only use valid structured salary or explicitly labelled
                // DOM salary. Never infer salary from arbitrary page text.
                const salary =
                    formatSalary(jp.baseSalary) ||
                    extractSalaryFromText(data.salaryFallback) ||
                    null;

                // validThrough is authoritative. DOM fallback searches
                // explicit deadline labels only.
                const applicationEndsRaw =
                    jp.validThrough ||
                    data.deadlineFallback ||
                    null;

                const publishedAt = jp.datePosted || null;

                const isRemote =
                    String(jp.jobLocationType || '')
                        .toUpperCase()
                        .includes('TELECOMMUTE') ||
                    /\bremote\b/i.test(location || '');

                const attendanceMode = isRemote
                    ? 'online'
                    : /\bhybrid\b/i.test(data.bodyText)
                        ? 'hybrid'
                        : 'in-person';

                const image = data.image || null;

                const item = {
                    id: `${SOURCE}-${slugify(title)}`,
                    title,

                    title_status: 'extracted',
                    title_evidence: jp.title
                        ? 'JobPosting JSON-LD title'
                        : 'Detail page h1.sc-1lss5cy-2',

                    company,
                    company_status: status(company),
                    company_evidence: jp.hiringOrganization
                        ? 'JobPosting JSON-LD hiringOrganization.name'
                        : data.ogSiteName
                            ? 'og:site_name'
                            : 'Leapfrog Technology careers-site identity',

                    description,
                    description_status: status(description),
                    description_evidence: description
                        ? jp.description
                            ? 'JobPosting JSON-LD description'
                            : 'Detail DOM div.sc-1fwbcuw-0.iMCTcK'
                        : 'Checked JobPosting.description and detail description block',

                    location,
                    location_status: status(location),
                    location_evidence: location
                        ? jsonLocation
                            ? 'JobPosting JSON-LD jobLocation.address'
                            : 'Detail DOM custom-css-style-job-location'
                        : 'Checked JSON-LD jobLocation and detail location elements',

                    url: data.finalUrl || link,
                    url_status: 'extracted',
                    url_evidence: 'Recruitee /o/ job detail URL',

                    employmentType,
                    employmentType_status: status(employmentType),
                    employmentType_evidence: employmentType
                        ? jp.employmentType
                            ? 'JobPosting JSON-LD employmentType'
                            : 'Employment type identified in detail text'
                        : 'Checked JSON-LD employmentType and detail text',

                    applicationEndsRaw,
                    applicationEnds_status: status(applicationEndsRaw),
                    applicationEnds_evidence: applicationEndsRaw
                        ? jp.validThrough
                            ? 'JobPosting JSON-LD validThrough'
                            : 'Explicit application deadline label in detail DOM'
                        : 'Checked JSON-LD validThrough and DOM labels: apply by, application deadline, closing date',

                    salary,
                    salary_status: status(salary),
                    salary_evidence: salary
                        ? jp.baseSalary
                            ? 'JobPosting JSON-LD baseSalary'
                            : 'Explicitly labelled salary in detail DOM'
                        : 'Checked JSON-LD baseSalary and explicitly labelled salary text; no valid numeric amount found',

                    image,
                    image_status: status(image),
                    image_evidence: image
                        ? 'og:image or detail content image'
                        : 'No usable og:image or content image',

                    publishedAt: publishedAt || null,
                    publishedAt_status: status(publishedAt),
                    publishedAt_evidence: publishedAt
                        ? 'JobPosting JSON-LD datePosted'
                        : 'No datePosted in JobPosting JSON-LD',

                    experience: null,
                    level: null,
                    openings: null,

                    responsibilities: null,
                    requirements: null,
                    skills: [],

                    companyUrl: 'https://www.lftechnology.com/',
                    companyLogoUrl: null,
                    companyDescription: null,
                    companyLocation: 'Kathmandu, Nepal',

                    date: null,
                    time: null,
                    price: null,
                    organizer: company,
                    category: 'Engineering',
                    tags: [
                        'engineering',
                        'software',
                        'technology',
                        'leapfrog'
                    ],

                    registrationUrl: data.finalUrl || link,
                    attendanceMode,
                    source: SOURCE
                };

                items.push(item);
            } catch (error) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        if (!items.length) {
            meta.atsEmpty = true;
        }

        console.log(
            '  [lftechnology-2] extracted ' + items.length
        );

        return { items, meta };
    }
};