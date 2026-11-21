// VERDICT: CAREERS_PAGE
// The entry URL is a genuine ITONICS careers page.
// Correction: div._cardItem_h0evo_141 contains employee testimonials,
// NOT job listings. The sample detail page is a Toyota case study,
// so its H1 and description selectors are irrelevant.
// No verified job-card or JobPosting structure exists in the evidence.
// Do not generate employee testimonials as vacancies.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const URL = 'https://www.itonics-innovation.de/karriere';
const COMPANY = 'ITONICS';

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        try {
            meta.pagesVisited++;

            await loadPage(page, URL, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            await delay(700);
        } catch (err) {
            console.warn(
                '  [itonics-innovation] failed to load careers page: ' +
                err.message
            );
            return { items, meta };
        }

        // Check for blocking once on the initial page.
        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (_) {
            // Best effort.
        }

        let result;

        try {
            result = await page.evaluate(() => {
                const clean = (value) =>
                    value
                        ? value.replace(/\s+/g, ' ').trim()
                        : null;

                const bodyText = clean(
                    document.body?.innerText || ''
                ) || '';

                const title = clean(document.title);

                const headings = Array.from(
                    document.querySelectorAll('h1, h2, h3')
                ).map((element) => clean(element.innerText))
                    .filter(Boolean);

                // These cards are employee testimonials, not vacancies.
                const employeeCards = Array.from(
                    document.querySelectorAll(
                        'div._cardItem_h0evo_141'
                    )
                ).map((card) => ({
                    title: clean(
                        card.querySelector(
                            '._cardTitle_h0evo_288'
                        )?.innerText
                    ),
                    supportingLine: clean(
                        card.querySelector(
                            '._cardSupportingLine_h0evo_299'
                        )?.innerText
                    )
                }));

                // Detect explicit vacancy-empty states.
                const emptyPatterns = [
                    /no open positions/i,
                    /no current openings/i,
                    /no job openings/i,
                    /no vacancies/i,
                    /not hiring/i,
                    /check back soon/i,
                    /there are no (open|current)/i,
                    /keine offenen stellen/i,
                    /derzeit keine stellen/i
                ];

                const explicitEmpty = emptyPatterns.some(
                    (pattern) => pattern.test(bodyText)
                );

                // Only recognize actual job-shaped elements.
                const jobSelectors = [
                    '[class*="job-listing"]',
                    '[class*="job-card"]',
                    '[class*="vacancy"]',
                    '[class*="position-card"]',
                    '[class*="career-opening"]',
                    'script[type="application/ld+json"]'
                ];

                const jobElements = [];

                for (const selector of jobSelectors) {
                    for (const element of document.querySelectorAll(
                        selector
                    )) {
                        if (
                            element.tagName === 'SCRIPT' &&
                            !/JobPosting/i.test(element.textContent || '')
                        ) {
                            continue;
                        }

                        const text = clean(element.innerText || '');
                        if (!text) continue;

                        jobElements.push({
                            selector,
                            text: text.slice(0, 1000)
                        });
                    }
                }

                // Inspect JSON-LD for authoritative JobPosting data.
                const structuredJobs = [];

                for (const script of document.querySelectorAll(
                    'script[type="application/ld+json"]'
                )) {
                    try {
                        const data = JSON.parse(script.textContent);

                        const collect = (value) => {
                            if (!value) return;

                            if (Array.isArray(value)) {
                                value.forEach(collect);
                                return;
                            }

                            if (typeof value !== 'object') return;

                            const type = value['@type'];

                            if (
                                type === 'JobPosting' ||
                                (
                                    Array.isArray(type) &&
                                    type.includes('JobPosting')
                                )
                            ) {
                                structuredJobs.push(value);
                            }

                            if (value['@graph']) {
                                collect(value['@graph']);
                            }
                        };

                        collect(data);
                    } catch (_) {
                        // Ignore malformed JSON-LD.
                    }
                }

                return {
                    title,
                    bodyText,
                    headings,
                    employeeCards,
                    explicitEmpty,
                    jobElements,
                    structuredJobs,
                    ogSiteName: clean(
                        document.querySelector(
                            'meta[property="og:site_name"]'
                        )?.content
                    ),
                    ogDescription: clean(
                        document.querySelector(
                            'meta[property="og:description"]'
                        )?.content
                    )
                };
            });
        } catch (err) {
            console.warn(
                '  [itonics-innovation] extraction failed: ' +
                err.message
            );

            return { items, meta };
        }

        // The three detected cards are employee profiles.
        // Never interpret employee names or testimonials as job titles.
        const cards = result.employeeCards || [];

        const actualJobs = result.structuredJobs || [];

        // Only structured JobPosting records are accepted here.
        // The supplied evidence contains no JobPosting records.
        for (const job of actualJobs) {
            try {
                const title = job.title
                    ? String(job.title).trim()
                    : null;

                if (!title) continue;

                const description = job.description
                    ? String(job.description)
                        .replace(/<[^>]*>/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim()
                    : null;

                const location = job.jobLocation?.address
                    ? [
                        job.jobLocation.address.addressLocality,
                        job.jobLocation.address.addressRegion,
                        job.jobLocation.address.addressCountry
                    ].filter(Boolean).join(', ')
                    : null;

                const company = job.hiringOrganization?.name ||
                    result.ogSiteName ||
                    COMPANY;

                const url = job.url || URL;

                const employmentType = job.employmentType || null;

                const salary = job.baseSalary
                    ? JSON.stringify(job.baseSalary)
                    : null;

                const applicationEndsRaw =
                    job.validThrough || null;

                const item = {
                    id: 'itonics-innovation-' +
                        title.toLowerCase()
                            .replace(/[^a-z0-9]+/g, '-')
                            .replace(/^-|-$/g, ''),

                    title,

                    title_status: 'extracted',
                    title_evidence: 'JSON-LD JobPosting title',

                    company,
                    company_status: 'extracted',
                    company_evidence:
                        'JobPosting hiringOrganization or ITONICS site identity',

                    description,
                    description_status: description
                        ? 'extracted'
                        : 'site_absent',
                    description_evidence:
                        description
                            ? 'JSON-LD JobPosting description'
                            : 'JobPosting contains no description',

                    location,
                    location_status: location
                        ? 'extracted'
                        : 'site_absent',
                    location_evidence:
                        location
                            ? 'JSON-LD JobPosting jobLocation'
                            : 'No jobLocation in JobPosting',

                    url: (() => {
                        try {
                            return new URL(
                                url,
                                URL
                            ).href;
                        } catch (_) {
                            return URL;
                        }
                    })(),

                    employmentType,
                    employmentType_status: employmentType
                        ? 'extracted'
                        : 'site_absent',
                    employmentType_evidence:
                        employmentType
                            ? 'JSON-LD JobPosting employmentType'
                            : 'No employmentType in JobPosting',

                    applicationEndsRaw,
                    applicationEnds_status: applicationEndsRaw
                        ? 'extracted'
                        : 'site_absent',
                    applicationEnds_evidence:
                        applicationEndsRaw
                            ? 'JSON-LD JobPosting validThrough'
                            : 'No validThrough in JobPosting',

                    image: null,
                    image_status: 'site_absent',
                    image_evidence:
                        'No per-job image extracted from JobPosting',

                    salary,
                    salary_status: salary
                        ? 'extracted'
                        : 'site_absent',
                    salary_evidence:
                        salary
                            ? 'JSON-LD JobPosting baseSalary'
                            : 'No baseSalary in JobPosting',

                    date: null,
                    time: null,
                    price: null,
                    organizer: company,
                    category: 'jobs',
                    tags: [],
                    registrationUrl: url,
                    attendanceMode: null,
                    source: 'itonics-innovation'
                };

                items.push(item);
            } catch (err) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        meta.listingHits = items.length;
        safeDiscovered(progress, items.length);

        if (
            items.length === 0 &&
            (
                result.explicitEmpty ||
                cards.length > 0 ||
                result.headings.some((heading) =>
                    /finde deinen traumjob/i.test(heading)
                )
            )
        ) {
            meta.atsEmpty = true;
        }

        console.log(
            '  [itonics-innovation] extracted ' + items.length +
            ' jobs; ignored ' + cards.length +
            ' employee testimonial cards'
        );

        return { items, meta };
    }
};