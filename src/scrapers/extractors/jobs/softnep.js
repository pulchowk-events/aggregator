const { loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { sanitizeJobFields } = require('../../jobs');

const SOFTNEP_BASE_URL = 'https://www.softnep.com';
const SOFTNEP_CAREER_URL = `${SOFTNEP_BASE_URL}/career`;
const SOFTNEP_JOBS_URL = `${SOFTNEP_BASE_URL}/opportunities/jobs`;
const SOFTNEP_INTERNSHIPS_URL =
    `${SOFTNEP_BASE_URL}/opportunities/internships`;

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];
        const visited = new Set();

        meta.atsEmpty = false;

        await loadPage(page, SOFTNEP_CAREER_URL);
        meta.pagesVisited++;

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                meta.listingHits = 0;
                return { items, meta };
            }
        } catch (_) {
            // Page-state detection is best effort.
        }

        // The career page is a navigation hub, not a job listing.
        // Its only role-related destinations are jobs and internships.
        const opportunityLinks = await page.evaluate(() => {
            const anchors = Array.from(
                document.querySelectorAll(
                    '.career-list a[href]'
                )
            );

            return anchors.map((anchor) => ({
                href: anchor.href,
                title:
                    anchor.querySelector('.maintitle')?.textContent
                        ?.replace(/\s+/g, ' ')
                        .trim() ||
                    anchor.getAttribute('title') ||
                    anchor.textContent.replace(/\s+/g, ' ').trim()
            })).filter((item) => item.href);
        });

        const opportunityPages = opportunityLinks.length
            ? opportunityLinks
            : [
                {
                    href: SOFTNEP_JOBS_URL,
                    title: 'Job Opportunities'
                },
                {
                    href: SOFTNEP_INTERNSHIPS_URL,
                    title: 'Internship Opportunities'
                }
            ];

        const normalizedPages = opportunityPages.filter((entry) => {
            try {
                const url = new URL(entry.href);
                return (
                    url.origin === SOFTNEP_BASE_URL &&
                    /^\/opportunities\/(jobs|internships)\/?$/.test(
                        url.pathname
                    )
                );
            } catch (_) {
                return false;
            }
        });

        const listings = new Map();

        for (const opportunity of normalizedPages) {
            if (visited.has(opportunity.href)) continue;
            visited.add(opportunity.href);

            await loadPage(page, opportunity.href);
            meta.pagesVisited++;

            const pageData = await page.evaluate(() => {
                const normalize = (value) =>
                    (value || '').replace(/\s+/g, ' ').trim();

                const bodyText = normalize(document.body?.innerText);

                const emptyPattern =
                    /no open positions|no current openings|no job openings/i;

                if (emptyPattern.test(bodyText)) {
                    return {
                        empty: true,
                        entries: []
                    };
                }

                const entries = [];

                // Do not interpret navigation, marketing sections, or
                // generic list elements as individual job postings.
                const candidates = document.querySelectorAll(
                    'a[href*="/opportunities/jobs/"], ' +
                    'a[href*="/opportunities/internships/"]'
                );

                for (const anchor of candidates) {
                    const href = anchor.href;
                    const title = normalize(
                        anchor.querySelector('h1, h2, h3, h4')?.textContent ||
                        anchor.querySelector('.maintitle')?.textContent ||
                        anchor.getAttribute('title') ||
                        anchor.textContent
                    );

                    if (!href || !title || title.length > 150) continue;

                    if (
                        !/\/opportunities\/(jobs|internships)\/[^/]+\/?$/i
                            .test(new URL(href).pathname)
                    ) {
                        continue;
                    }

                    entries.push({
                        href,
                        title
                    });
                }

                return {
                    empty: false,
                    entries
                };
            });

            if (pageData.empty && pageData.entries.length === 0) {
                meta.atsEmpty = true;
            }

            for (const entry of pageData.entries) {
                if (!listings.has(entry.href)) {
                    listings.set(entry.href, entry);
                }
            }
        }

        const listingEntries = Array.from(listings.values());

        meta.listingHits = listingEntries.length;
        safeDiscovered(progress, listingEntries.length);

        if (!listingEntries.length) {
            return { items, meta };
        }

        for (const entry of listingEntries) {
            try {
                await loadPage(page, entry.href);
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                const raw = await page.evaluate(() => {
                    const normalize = (value) =>
                        (value || '').replace(/\s+/g, ' ').trim();

                    const getText = (selectors, root = document) => {
                        for (const selector of selectors) {
                            const element = root.querySelector(selector);
                            const value = normalize(element?.textContent);
                            if (value) return value;
                        }
                        return null;
                    };

                    const title = getText([
                        'h1',
                        'h2',
                        '.job-title',
                        '.opportunity-title'
                    ]);

                    const descriptionSelectors = [
                        '[class*="job-description"]',
                        '[class*="role-body"]',
                        '[class*="job-detail"]',
                        '.description',
                        'article'
                    ];

                    let description = null;

                    for (const selector of descriptionSelectors) {
                        const element = document.querySelector(selector);
                        if (!element) continue;

                        const text = normalize(element.innerText);
                        if (
                            text &&
                            text.length > 100 &&
                            text !== normalize(document.body?.innerText)
                        ) {
                            description = text;
                            break;
                        }
                    }

                    const bodyText = normalize(document.body?.innerText);

                    const locationMatch = bodyText.match(
                        /(?:location|work location)\s*[:\-]\s*([^\n]{2,80})/i
                    );

                    const salaryMatch = bodyText.match(
                        /(?:salary|compensation|remuneration)\s*[:\-]\s*([^\n]{1,60})/i
                    );

                    const employmentMatch = bodyText.match(
                        /\b(full[\s-]?time|part[\s-]?time|contract|internship)\b/i
                    );

                    const expiryMatch = bodyText.match(
                        /(?:apply before|application deadline|deadline|closing date|last date)\s*[:\-]?\s*([^\n]{3,60})/i
                    );

                    const image = document.querySelector(
                        'article img, main img, .content-section img'
                    );

                    const companyLogo = document.querySelector(
                        'header img[alt], img[alt*="SoftNEP" i]'
                    );

                    const canonical = document.querySelector(
                        'link[rel="canonical"]'
                    );

                    const companyUrl = document.querySelector(
                        'a[href="https://www.softnep.com/"]'
                    );

                    return {
                        title,
                        description,
                        location: locationMatch
                            ? normalize(locationMatch[1])
                            : null,
                        salary: salaryMatch
                            ? normalize(salaryMatch[1])
                            : null,
                        employmentType: employmentMatch
                            ? employmentMatch[1]
                            : null,
                        applicationEndsRaw: expiryMatch
                            ? normalize(expiryMatch[1])
                            : null,
                        image: image
                            ? image.getAttribute('src') ||
                              image.getAttribute('data-src')
                            : null,
                        companyLogoUrl: companyLogo
                            ? companyLogo.getAttribute('src')
                            : null,
                        companyUrl: companyUrl
                            ? companyUrl.href
                            : null,
                        canonicalUrl: canonical?.href || null,
                        company: 'SoftNEP',
                        bodyText
                    };
                });

                const finalUrl = raw.canonicalUrl || entry.href;
                const title = raw.title || entry.title;

                if (!title) {
                    meta.detailParseFailures++;
                    continue;
                }

                const finalJob = {
                    id: `softnep-${Buffer.from(finalUrl).toString('base64url')}`,
                    title,
                    company: raw.company,
                    company_status: 'extracted',
                    company_evidence:
                        'SoftNEP employer identity confirmed by the career page domain and company branding.',
                    companyUrl: raw.companyUrl || SOFTNEP_BASE_URL,
                    companyLogoUrl: raw.companyLogoUrl || null,

                    location: raw.location,
                    location_status: raw.location
                        ? 'extracted'
                        : 'site_absent',
                    location_evidence: raw.location
                        ? 'Extracted from the job detail page.'
                        : 'Searched job detail page text for Location and Work Location labels.',

                    description: raw.description,
                    description_status: raw.description
                        ? 'extracted'
                        : 'site_absent',
                    description_evidence: raw.description
                        ? 'Extracted from job-specific description selectors.'
                        : 'Searched job-description, role-body, job-detail, description, and article selectors.',

                    employmentType: raw.employmentType,
                    employmentType_status: raw.employmentType
                        ? 'extracted'
                        : 'site_absent',
                    employmentType_evidence:
                        'Searched detail page for full-time, part-time, contract, and internship.',

                    applicationEndsRaw: raw.applicationEndsRaw,
                    applicationEndsRaw_status: raw.applicationEndsRaw
                        ? 'extracted'
                        : 'site_absent',
                    applicationEndsRaw_evidence:
                        'Searched detail page for application deadline, apply before, closing date, and last date.',

                    salary: raw.salary,
                    salary_status: raw.salary
                        ? 'extracted'
                        : 'site_absent',
                    salary_evidence:
                        'Searched detail page for salary, compensation, and remuneration labels.',

                    experience: null,
                    level: null,
                    openings: null,
                    responsibilities: null,
                    requirements: null,
                    skills: [],

                    attendanceMode: raw.location &&
                        /remote/i.test(raw.location)
                        ? 'Remote'
                        : null,

                    companyDescription: null,
                    companyLocation: null,
                    companyAddress: null,

                    url: finalUrl,
                    registrationUrl: finalUrl,
                    image: raw.image || null,
                    source: 'softnep',
                    scrapedAt: Date.now()
                };

                sanitizeJobFields(finalJob);
                items.push(finalJob);
            } catch (_) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(
            '  [softnep] extracted ' + items.length + ' job(s)'
        );

        return { items, meta };
    }
};