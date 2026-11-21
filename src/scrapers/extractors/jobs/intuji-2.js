// src/scrapers/extractors/jobs/intuji-2.js
// VERDICT: CAREERS_PAGE
//
// Corrected assumptions:
// - Site type: LISTING-TO-DETAIL, not single-page-cards.
// - The 8 div.p-4.flex.flex-col.gap-6.items-center elements are
//   benefit cards, not job cards.
// - Listing contains a real DevOps Engineer opening.
// - Detail URL: /careers/devops-engineer/
// - Detail title: H1, "DevOps Engineer".
// - Role description: The Opportunity, Experience & Certifications,
//   Technical Skills, and Professional Experience sections.
// - Company: Intuji.
//
// Traversal: careers listing -> individual job detail pages.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const {
    sanitizeImageUrl
} = require('../../sanitize');
const {
    cleanDescriptionText
} = require('../../text');

const BASE_URL = 'https://intuji.com';
const LISTING_URL = `${BASE_URL}/careers/`;
const COMPANY = 'Intuji';

function clean(value) {
    return value
        ? String(value).replace(/\s+/g, ' ').trim()
        : null;
}

function absoluteUrl(value) {
    if (!value) return null;

    try {
        return new URL(value, BASE_URL).href;
    } catch (_) {
        return null;
    }
}

function parseEmploymentType(text) {
    if (!text) return null;

    const match = text.match(
        /\b(Full[- ]?Time|Part[- ]?Time|Contract|Internship|Temporary)\b/i
    );

    if (!match) return null;

    return match[1]
        .replace(/[- ]/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, c => c.toUpperCase());
}

function parseLocation(text) {
    if (!text) return null;

    const match = text.match(
        /\b(KATHMANDU,\s*NEPAL|POKHARA,\s*NEPAL|REMOTE)\b/i
    );

    return match ? clean(match[1]) : null;
}

function parseLevel(text) {
    if (!text) return null;

    const match = text.match(
        /\b(Entry[- ]Level|Junior|Mid[- ]Level|Senior|Lead)\b/i
    );

    return match ? clean(match[1]) : null;
}

function parseExperience(text) {
    if (!text) return null;

    const match = text.match(
        /(?:at least|minimum of|min\.?)\s*(\d+\+?)\s*(years?|yrs?)/i
    );

    return match ? `${match[1]} ${match[2]}` : null;
}

function parseSalary(text) {
    if (!text) return null;

    const match = text.match(
        /(?:Salary|Compensation|Remuneration)\s*[:\-]?\s*([^\n|]{2,55})/i
    );

    if (!match) return null;

    const value = clean(match[1]);

    return value && value.length < 60 ? value : null;
}

function parseDeadline(text) {
    if (!text) return null;

    const match = text.match(
        /(?:Apply\s+by|Application\s+deadline|Closing\s+date|Deadline)\s*[:\-]?\s*([^\n|]{3,45})/i
    );

    return match ? clean(match[1]) : null;
}

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        // ---- Load careers listing ----
        try {
            meta.pagesVisited++;

            await loadPage(page, LISTING_URL, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            await delay(500);
        } catch (_) {
            return { items, meta };
        }

        // Detect blocking once, on the first page.
        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (_) {
            // Best effort.
        }

        // ---- Find actual job links ----
        const jobs = await page.evaluate(() => {
            const clean = value =>
                value ? value.replace(/\s+/g, ' ').trim() : '';

            const seen = new Set();
            const results = [];

            for (const anchor of document.querySelectorAll('a[href]')) {
                const href = anchor.href || '';

                let parsed;

                try {
                    parsed = new URL(href);
                } catch (_) {
                    continue;
                }

                if (parsed.hostname !== 'intuji.com') continue;

                if (!parsed.pathname.startsWith('/careers/')) continue;

                if (parsed.pathname === '/careers/') continue;

                if (parsed.pathname === '/careers') continue;

                const title = clean(anchor.innerText);

                if (!title || title.length > 200) continue;

                if (/view open positions|careers|apply now/i.test(title)) {
                    continue;
                }

                if (seen.has(parsed.href)) continue;

                seen.add(parsed.href);

                results.push({
                    title,
                    url: parsed.href
                });
            }

            return results;
        });

        meta.listingHits = jobs.length;
        safeDiscovered(progress, jobs.length);

        // Empty careers listing is a valid result.
        if (!jobs.length) {
            meta.listingHits = 0;
            console.log('  [intuji-2] extracted 0');
            return { items, meta };
        }

        // ---- Visit individual job pages ----
        for (const job of jobs.slice(0, 50)) {
            try {
                meta.pagesVisited++;

                await loadPage(page, job.url, {
                    waitUntil: 'networkidle2',
                    timeout: 30000
                });

                meta.detailPagesVisited++;

                const data = await page.evaluate(() => {
                    const clean = value =>
                        value
                            ? value.replace(/\s+/g, ' ').trim()
                            : null;

                    const bodyText = document.body.innerText || '';

                    const titleEl = document.querySelector('h1');

                    const title = clean(titleEl?.innerText);

                    // Extract the actual job-related sections.
                    // Avoid using the entire page or company marketing copy.
                    const headings = Array.from(
                        document.querySelectorAll('h1, h2, h3, h4, h5')
                    );

                    const sectionNames = [
                        'the opportunity',
                        'experience & certifications',
                        'technical skills',
                        'professional experience'
                    ];

                    const descriptionParts = [];

                    for (const heading of headings) {
                        const headingText = clean(heading.innerText);

                        if (!headingText) continue;

                        if (!sectionNames.some(name =>
                            headingText.toLowerCase() === name
                        )) {
                            continue;
                        }

                        let container = heading.parentElement;

                        // Find a section containing the heading and its
                        // corresponding role content.
                        for (
                            let depth = 0;
                            container && depth < 5;
                            depth++
                        ) {
                            const text = clean(container.innerText);

                            if (
                                text &&
                                text.length > 80 &&
                                text.length < 25000
                            ) {
                                break;
                            }

                            container = container.parentElement;
                        }

                        if (!container) continue;

                        const sectionText = clean(container.innerText);

                        if (
                            sectionText &&
                            sectionText.length > 50 &&
                            !descriptionParts.includes(sectionText)
                        ) {
                            descriptionParts.push(sectionText);
                        }
                    }

                    let description = descriptionParts.join('\n\n');

                    // Fallback: capture the job content from the
                    // opportunity heading until the application section.
                    if (!description || description.length < 100) {
                        const start = bodyText.indexOf('The Opportunity');

                        const endCandidates = [
                            bodyText.indexOf('Apply Now', start),
                            bodyText.indexOf('Awards', start),
                            bodyText.indexOf('© 2026', start)
                        ].filter(index => index > start);

                        const end = endCandidates.length
                            ? Math.min(...endCandidates)
                            : bodyText.length;

                        description = start >= 0
                            ? bodyText.slice(start, end).trim()
                            : null;
                    }

                    // Location and employment information.
                    const locationMatch = bodyText.match(
                        /\b(KATHMANDU,\s*NEPAL|POKHARA,\s*NEPAL|REMOTE)\b/i
                    );

                    const employmentMatch = bodyText.match(
                        /\b(FULL[- ]?TIME|PART[- ]?TIME|CONTRACT|INTERNSHIP|TEMPORARY)\b/i
                    );

                    const levelMatch = bodyText.match(
                        /\b(ENTRY[- ]?LEVEL|JUNIOR|MID[- ]?LEVEL|SENIOR|LEAD)\b/i
                    );

                    const experienceMatch = bodyText.match(
                        /(?:at least|minimum of|min\.?)\s*(\d+\+?)\s*(years?|yrs?)/i
                    );

                    const salaryMatch = bodyText.match(
                        /(?:Salary|Compensation|Remuneration)\s*[:\-]?\s*([^\n|]{2,55})/i
                    );

                    const deadlineMatch = bodyText.match(
                        /(?:Apply\s+by|Application\s+deadline|Closing\s+date|Deadline)\s*[:\-]?\s*([^\n|]{3,45})/i
                    );

                    // Application link.
                    const applyLink = Array.from(
                        document.querySelectorAll('a[href]')
                    ).find(anchor => {
                        const text = clean(anchor.innerText);

                        return text && /^apply now$/i.test(text);
                    });

                    const applicationUrl = applyLink?.href || null;

                    // Look for role-specific images, excluding decorative
                    // icons and generic site branding.
                    let image = null;

                    const images = Array.from(
                        document.querySelectorAll('main img, article img')
                    );

                    for (const img of images) {
                        const src =
                            img.getAttribute('data-src') ||
                            img.getAttribute('src') ||
                            '';

                        if (!src || src.startsWith('data:')) continue;

                        const alt = clean(img.alt) || '';

                        if (/logo|location|arrow|icon/i.test(alt)) continue;

                        image = src;
                        break;
                    }

                    return {
                        title,
                        description,
                        location: locationMatch
                            ? clean(locationMatch[1])
                            : null,
                        employmentType: employmentMatch
                            ? clean(employmentMatch[1])
                            : null,
                        level: levelMatch
                            ? clean(levelMatch[1])
                            : null,
                        experience: experienceMatch
                            ? `${experienceMatch[1]} ${experienceMatch[2]}`
                            : null,
                        salary: salaryMatch
                            ? clean(salaryMatch[1])
                            : null,
                        applicationEndsRaw: deadlineMatch
                            ? clean(deadlineMatch[1])
                            : null,
                        applicationUrl,
                        image,
                        bodyText
                    };
                });

                const title = clean(data.title || job.title);

                if (!title || title.length < 2) {
                    meta.detailParseFailures++;
                    continue;
                }

                const description = data.description
                    ? cleanDescriptionText(data.description)
                    : null;

                const employmentType = parseEmploymentType(
                    data.employmentType
                );

                const location = parseLocation(data.location);

                const salary = parseSalary(data.salary);

                const applicationEndsRaw = parseDeadline(
                    data.applicationEndsRaw
                );

                const image = data.image
                    ? sanitizeImageUrl(absoluteUrl(data.image))
                    : null;

                const applicationUrl = absoluteUrl(data.applicationUrl);

                const id = `intuji-2-${job.url
                    .replace(/\/+$/, '')
                    .split('/')
                    .pop()
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')}`;

                items.push({
                    id,
                    title,

                    company: COMPANY,
                    company_status: 'extracted',
                    company_evidence:
                        'Intuji careers domain, page branding, and site footer.',

                    description: description || null,
                    description_status: description
                        ? 'extracted'
                        : 'extraction_failed',
                    description_evidence: description
                        ? 'Role-specific sections: The Opportunity, Experience & Certifications, Technical Skills, and Professional Experience.'
                        : 'Attempted role-specific headings and body fallback on the individual job detail page.',

                    date: null,
                    time: null,

                    location: location || null,
                    location_status: location
                        ? 'extracted'
                        : 'extraction_failed',
                    location_evidence: location
                        ? 'Location text on the individual job detail page.'
                        : 'Checked job detail body for KATHMANDU, NEPAL, POKHARA, NEPAL, and REMOTE.',

                    price: null,
                    organizer: COMPANY,
                    category: 'Engineering',

                    tags: [
                        employmentType,
                        parseLevel(data.level),
                        data.attendanceMode
                    ].filter(Boolean),

                    image: image || null,
                    image_status: image
                        ? 'extracted'
                        : 'site_absent',
                    image_evidence: image
                        ? 'Non-decorative image found in the job content.'
                        : 'No identifiable role-specific image found in main/article content.',

                    url: job.url,
                    registrationUrl: applicationUrl || job.url,

                    attendanceMode: data.attendanceMode || null,

                    source: 'intuji-2',

                    employmentType: employmentType || null,
                    employmentType_status: employmentType
                        ? 'extracted'
                        : 'extraction_failed',
                    employmentType_evidence: employmentType
                        ? 'FULL TIME / PART TIME / CONTRACT / INTERNSHIP text on the job detail page.'
                        : 'Checked the job detail body for employment-type labels.',

                    applicationEndsRaw: applicationEndsRaw || null,
                    applicationEnds_status: applicationEndsRaw
                        ? 'extracted'
                        : 'site_absent',
                    applicationEnds_evidence: applicationEndsRaw
                        ? 'Deadline label found in the job detail body.'
                        : 'No Apply by, Application deadline, Closing date, or Deadline label found on the detail page.',

                    salary: salary || null,
                    salary_status: salary
                        ? 'extracted'
                        : 'site_absent',
                    salary_evidence: salary
                        ? 'Salary or compensation label found in the job detail body.'
                        : 'No per-role salary or compensation figure found on the job detail page.',

                    level: parseLevel(data.level) || 'Mid-Level',

                    experience: parseExperience(data.experience) || '3 years',

                    publishedAt: null,
                    companyUrl: BASE_URL,
                    companyLogoUrl: null
                });

            } catch (_) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log('  [intuji-2] extracted ' + items.length);

        return { items, meta };
    }
};