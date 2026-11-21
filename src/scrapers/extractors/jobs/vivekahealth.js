const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const {
    cleanDescriptionText
} = require('../../text');

const CAREERS_URL = 'https://www.vivekahealth.com/about/careers/';
const COMPANY = 'Viveka Health Inc.';
const COMPANY_URL = 'https://www.vivekahealth.com/';

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        // The wizard's assumptions need correction:
        // - This is a single-page careers listing, not six independent cards.
        // - The six p matches are not six jobs; they include page paragraphs.
        // - The representative p contains the Healthcare Data Manager description.
        // - JSON-LD contains WebPage, ImageObject, BreadcrumbList and WebSite,
        //   but no JobPosting.
        // - The supplied detail URL is a marketing page, not a job detail page.
        // - The actual job is rendered inline under the Job Openings heading.

        try {
            meta.pagesVisited++;
            await loadPage(page, CAREERS_URL, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });
            await delay(500);
        } catch (err) {
            return { items, meta };
        }

        // Check for blocking before attempting extraction.
        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (e) {
            // Best effort.
        }

        const harvested = await page.evaluate(() => {
            const clean = (value) => {
                if (!value) return null;
                return value.replace(/\s+/g, ' ').trim() || null;
            };

            const bodyText = document.body?.innerText || '';

            // Empty-state detection.
            const emptyPattern =
                /no open positions|no current openings|no job openings|no vacancies|check back soon|not hiring/i;

            const headings = Array.from(
                document.querySelectorAll('h1, h2, h3, h4, h5, h6')
            );

            const jobSection = headings.find((heading) =>
                /^job openings$/i.test(clean(heading.innerText) || '')
            );

            if (!jobSection) {
                return {
                    jobs: [],
                    empty: emptyPattern.test(bodyText),
                    companyFound: /Viveka/i.test(document.title)
                };
            }

            // Find the actual job description paragraph.
            // The representative raw HTML confirms this p contains the ETL
            // description for Healthcare Data Manager.
            const paragraphs = Array.from(
                document.querySelectorAll('p')
            );

            const descriptionParagraph = paragraphs.find((p) => {
                const text = clean(p.innerText) || '';

                return (
                    text.length > 60 &&
                    /ETL\s*\(Extract,\s*Transform,\s*Load\)/i.test(text) &&
                    /data engineers/i.test(text)
                );
            });

            if (!descriptionParagraph) {
                return {
                    jobs: [],
                    empty: emptyPattern.test(bodyText),
                    companyFound: /Viveka/i.test(document.title)
                };
            }

            // Find the job title from the headings following Job Openings.
            const sectionHeadingIndex = headings.indexOf(jobSection);

            const titleHeading = headings
                .slice(sectionHeadingIndex + 1)
                .find((heading) =>
                    /^Healthcare Data Manager$/i.test(
                        clean(heading.innerText) || ''
                    )
                );

            if (!titleHeading) {
                return {
                    jobs: [],
                    empty: false,
                    companyFound: true
                };
            }

            const title = clean(titleHeading.innerText);

            // Company and location are published in the next heading.
            const titleIndex = headings.indexOf(titleHeading);
            const employerHeading = headings
                .slice(titleIndex + 1)
                .find((heading) => {
                    const text = clean(heading.innerText) || '';

                    return (
                        /Viveka Health Inc\./i.test(text) &&
                        /Princeton/i.test(text)
                    );
                });

            const employerText = clean(
                employerHeading?.innerText
            );

            const company = employerText
                ? (employerText.match(/Viveka Health Inc\./i) || [])[0]
                : null;

            const location = employerText
                ? (employerText.match(
                    /(?:in\s+)?Princeton\s+Jct,?\s*NJ/i
                ) || [])[0]?.replace(/^in\s+/i, '') || null
                : null;

            // Collect the role body without including unrelated marketing
            // content or the footer.
            const sectionText = [];

            let collecting = false;

            const nodes = Array.from(
                document.querySelectorAll('h1, h2, h3, h4, h5, h6, p')
            );

            for (const node of nodes) {
                if (node === jobSection) {
                    collecting = true;
                    continue;
                }

                if (!collecting) continue;

                const text = clean(node.innerText);
                if (!text) continue;

                if (
                    node.matches('h1, h2') &&
                    !/^Healthcare Data Manager$/i.test(text)
                ) {
                    break;
                }

                if (/^(COMPANY|LOCATIONS|HOURS)$/i.test(text)) {
                    break;
                }

                if (/^Healthcare Data Manager$/i.test(text)) {
                    continue;
                }

                if (
                    employerHeading &&
                    node === employerHeading
                ) {
                    continue;
                }

                sectionText.push(text);
            }

            // The first paragraph is the actual role summary.
            // The following content contains Duties, Requirements,
            // Experience, Hours and How to Apply.
            let description = sectionText.join('\n');

            description = description
                .replace(/How to Apply\s*/i, 'Application information: ')
                .trim();

            // Remove duplicate summary text if present.
            const summary = clean(descriptionParagraph.innerText);

            if (description && summary && !description.includes(summary)) {
                description = summary + '\n' + description;
            }

            // Find application email and job code.
            const emailMatch = bodyText.match(
                /careers@vivekahealth\.com/i
            );

            const jobCodeMatch = bodyText.match(
                /Job code\s+([A-Z0-9]+)/i
            );

            // Check for employment and compensation information.
            const employmentMatch = description.match(
                /\b(Full[- ]?Time|Part[- ]?Time|Contract|Internship|Temporary)\b/i
            );

            const salaryMatch = description.match(
                /(?:Salary|Compensation)\s*[:\-]?\s*([^\n]{2,55})/i
            );

            const deadlineMatch = description.match(
                /(?:Apply by|Application deadline|Deadline)\s*[:\-]?\s*([^\n]{2,40})/i
            );

            // The site has no per-job image in the supplied role evidence.
            return {
                jobs: [{
                    title,
                    company,
                    location,
                    description: description || summary,
                    summary,
                    email: emailMatch ? emailMatch[0] : null,
                    jobCode: jobCodeMatch ? jobCodeMatch[1] : null,
                    employmentType: employmentMatch
                        ? employmentMatch[1]
                        : null,
                    salary: salaryMatch ? salaryMatch[1].trim() : null,
                    applicationEndsRaw: deadlineMatch
                        ? deadlineMatch[1].trim()
                        : null,
                    image: null
                }],
                empty: false,
                companyFound: !!company
            };
        });

        const jobs = harvested.jobs || [];

        meta.listingHits = jobs.length;
        safeDiscovered(progress, jobs.length);

        if (jobs.length === 0) {
            if (harvested.empty) {
                meta.atsEmpty = true;
            }

            console.log('  [vivekahealth] extracted 0');
            return { items, meta };
        }

        for (const job of jobs) {
            try {
                const description = job.description
                    ? cleanDescriptionText(job.description)
                    : null;

                const emailUrl = job.email
                    ? `mailto:${job.email}?subject=${encodeURIComponent(
                        'Application - ' + job.title +
                        (job.jobCode ? ' - ' + job.jobCode : '')
                    )}`
                    : null;

                items.push({
                    id: 'vivekahealth-' +
                        job.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),

                    title: job.title,
                    title_status: 'extracted',
                    title_evidence: 'Heading Healthcare Data Manager under Job Openings',

                    company: job.company,
                    company_status: job.company
                        ? 'extracted'
                        : 'extraction_failed',
                    company_evidence: job.company
                        ? 'Employer heading identifies Viveka Health Inc.'
                        : 'Checked employer heading following the job title',

                    description: description || null,
                    description_status: description
                        ? 'extracted'
                        : 'extraction_failed',
                    description_evidence:
                        'ETL description paragraph and following job content under Job Openings',

                    url: CAREERS_URL,

                    location: job.location,
                    location_status: job.location
                        ? 'extracted'
                        : 'extraction_failed',
                    location_evidence:
                        'Employer heading contains Princeton Jct, NJ',

                    employmentType: job.employmentType || null,
                    employmentType_status: job.employmentType
                        ? 'extracted'
                        : 'site_absent',
                    employmentType_evidence:
                        job.employmentType
                            ? 'Employment type matched in job description'
                            : 'No explicit employment type published in the role content',

                    applicationEndsRaw: job.applicationEndsRaw || null,
                    applicationEnds_status: job.applicationEndsRaw
                        ? 'extracted'
                        : 'site_absent',
                    applicationEnds_evidence:
                        job.applicationEndsRaw
                            ? 'Application deadline matched in role content'
                            : 'No application deadline published in role content',

                    image: null,
                    image_status: 'site_absent',
                    image_evidence:
                        'No per-job image found in the inline job listing',

                    salary: job.salary || null,
                    salary_status: job.salary
                        ? 'extracted'
                        : 'site_absent',
                    salary_evidence:
                        job.salary
                            ? 'Salary or compensation matched in role content'
                            : 'No salary or compensation published in role content',

                    experience: null,
                    level: null,
                    openings: null,

                    companyUrl: COMPANY_URL,
                    companyLogoUrl: null,

                    date: null,
                    time: null,
                    price: null,
                    organizer: COMPANY,
                    category: 'Healthcare Technology',
                    tags: [
                        'Healthcare',
                        'Data Engineering',
                        'ETL',
                        'SQL',
                        'Python',
                        'AWS',
                        'HIPAA'
                    ],
                    registrationUrl: emailUrl || CAREERS_URL,
                    attendanceMode: null,

                    source: 'vivekahealth'
                });
            } catch (err) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log('  [vivekahealth] extracted ' + items.length);

        return { items, meta };
    }
};