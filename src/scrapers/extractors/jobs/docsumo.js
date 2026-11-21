const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const DOCSUMO_URL = 'https://www.docsumo.com/careers';
const DOCSUMO_COMPANY = 'Docsumo';

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        try {
            meta.pagesVisited++;
            await loadPage(page, DOCSUMO_URL, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });
            await delay(500);
        } catch (_) {
            meta.listingHits = 0;
            return { items, meta };
        }

        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (_) {
            // Diagnostics are best-effort.
        }

        const harvested = await page.evaluate(() => {
            const clean = (value) => {
                if (!value) return null;
                return value.replace(/\s+/g, ' ').trim() || null;
            };

            const bodyText = document.body?.innerText || '';
            const pageTitle = document.title || '';

            const emptyPattern =
                /no open positions|no current openings|no job openings|no vacancies|/i;
            const emptyPattern2 =
                /not hiring|check back soon|there are no (open|current)|sorry, no positions/i;

            const emptyState =
                emptyPattern.test(bodyText) || emptyPattern2.test(bodyText);

            const organization =
                document.querySelector('meta[property="og:site_name"]')
                    ?.getAttribute('content') ||
                'Docsumo';

            const jobPostingData = [];

            document.querySelectorAll(
                'script[type="application/ld+json"]'
            ).forEach((script) => {
                try {
                    const data = JSON.parse(script.textContent || '{}');
                    const nodes = Array.isArray(data) ? data : [data];

                    for (const node of nodes) {
                        const candidates = [
                            node,
                            ...(Array.isArray(node['@graph'])
                                ? node['@graph']
                                : [])
                        ];

                        for (const candidate of candidates) {
                            const type = candidate['@type'];
                            const types = Array.isArray(type) ? type : [type];

                            if (types.includes('JobPosting')) {
                                jobPostingData.push(candidate);
                            }
                        }
                    }
                } catch (_) {
                    // Ignore malformed JSON-LD.
                }
            });

            const jobs = [];

            for (const job of jobPostingData) {
                const title = clean(job.title);
                if (!title) continue;

                const locationObjects = Array.isArray(job.jobLocation)
                    ? job.jobLocation
                    : job.jobLocation
                        ? [job.jobLocation]
                        : [];

                const locations = locationObjects
                    .map((entry) => {
                        const address = entry.address || {};
                        return [
                            address.addressLocality,
                            address.addressRegion,
                            address.addressCountry
                        ].filter(Boolean).join(', ');
                    })
                    .filter(Boolean);

                const description = clean(
                    (job.description || '').replace(/<[^>]*>/g, ' ')
                );

                jobs.push({
                    title,
                    description,
                    location: locations.join(' / ') || null,
                    url: job.url || DOCSUMO_URL,
                    employmentType: job.employmentType || null,
                    applicationEndsRaw: job.validThrough || null,
                    salary: job.baseSalary?.value?.value || null,
                    image: job.image || null,
                    company: job.hiringOrganization?.name || organization,
                    companyUrl: job.hiringOrganization?.sameAs || null
                });
            }

            if (jobs.length) {
                return {
                    jobs,
                    emptyState: false,
                    organization
                };
            }

            // The six details elements are FAQ accordions, not job cards.
            // Do not interpret their headings as employment opportunities.
            const faqDetails = Array.from(
                document.querySelectorAll('details')
            );

            const openRolesFaq = faqDetails.find((element) => {
                const text = clean(element.innerText) || '';
                return /where can i see.*open roles/i.test(text);
            });

            const faqText = clean(openRolesFaq?.innerText) || '';

            const applyLink = Array.from(
                document.querySelectorAll('a[href^="mailto:"]')
            ).find((anchor) => {
                const href = anchor.getAttribute('href') || '';
                return /careers@docsumo\.com/i.test(href);
            });

            const companyLocation =
                /hybrid team in the USA, India and Nepal/i.test(
                    document.querySelector('meta[property="og:description"]')
                        ?.getAttribute('content') || ''
                )
                    ? 'USA, India and Nepal'
                    : null;

            return {
                jobs: [],
                emptyState,
                organization,
                faqText,
                companyLocation,
                applyUrl: applyLink?.href || null,
                hasOpenRolesFaq: Boolean(openRolesFaq),
                pageTitle
            };
        });

        const jobs = harvested.jobs || [];

        meta.listingHits = jobs.length;
        safeDiscovered(progress, jobs.length);

        if (jobs.length === 0) {
            if (harvested.emptyState) {
                meta.atsEmpty = true;
            }

            // The careers page explicitly states that openings are not
            // published on a job board. The details elements are FAQs.
            console.log('  [docsumo] extracted 0');
            return { items, meta };
        }

        for (const job of jobs) {
            try {
                const title = job.title;
                const description = job.description;
                const location = job.location;
                const url = job.url.startsWith('http')
                    ? job.url
                    : new URL(job.url, DOCSUMO_URL).href;

                const employmentType = job.employmentType
                    ? String(job.employmentType)
                    : null;

                const salary = job.salary
                    ? String(job.salary)
                    : null;

                const image = job.image
                    ? new URL(job.image, DOCSUMO_URL).href
                    : null;

                const deadline = job.applicationEndsRaw
                    ? String(job.applicationEndsRaw)
                    : null;

                items.push({
                    id: 'docsumo-' + title
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '-')
                        .replace(/^-|-$/g, ''),

                    title,
                    title_status: 'extracted',
                    title_evidence: 'JSON-LD JobPosting.title',

                    company: job.company || DOCSUMO_COMPANY,
                    company_status: 'extracted',
                    company_evidence:
                        'JSON-LD hiringOrganization.name or og:site_name',

                    description,
                    description_status: description
                        ? 'extracted'
                        : 'site_absent',
                    description_evidence: description
                        ? 'JSON-LD JobPosting.description'
                        : 'JobPosting description was empty',

                    url,
                    url_status: 'extracted',
                    url_evidence: 'JSON-LD JobPosting.url',

                    location,
                    location_status: location
                        ? 'extracted'
                        : 'site_absent',
                    location_evidence: location
                        ? 'JSON-LD jobLocation.address'
                        : 'JSON-LD jobLocation was absent',

                    employmentType,
                    employmentType_status: employmentType
                        ? 'extracted'
                        : 'site_absent',
                    employmentType_evidence: employmentType
                        ? 'JSON-LD JobPosting.employmentType'
                        : 'JSON-LD employmentType was absent',

                    applicationEndsRaw: deadline,
                    applicationEnds_status: deadline
                        ? 'extracted'
                        : 'site_absent',
                    applicationEnds_evidence: deadline
                        ? 'JSON-LD validThrough'
                        : 'JSON-LD validThrough was absent',

                    salary,
                    salary_status: salary
                        ? 'extracted'
                        : 'site_absent',
                    salary_evidence: salary
                        ? 'JSON-LD JobPosting.baseSalary'
                        : 'JSON-LD baseSalary was absent',

                    image,
                    image_status: image
                        ? 'extracted'
                        : 'site_absent',
                    image_evidence: image
                        ? 'JSON-LD JobPosting.image'
                        : 'No per-job image in JobPosting',

                    date: null,
                    time: null,
                    price: null,
                    organizer: job.company || DOCSUMO_COMPANY,
                    category: employmentType || null,
                    tags: [],
                    registrationUrl: url,
                    attendanceMode: null,
                    source: 'docsumo',

                    companyUrl: job.companyUrl,
                    companyUrl_status: job.companyUrl
                        ? 'extracted'
                        : 'site_absent',
                    companyUrl_evidence:
                        'JSON-LD hiringOrganization.sameAs'
                });
            } catch (_) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log('  [docsumo] extracted ' + items.length);
        return { items, meta };
    }
};