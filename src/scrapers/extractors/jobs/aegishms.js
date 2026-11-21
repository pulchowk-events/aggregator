// src/scrapers/extractors/jobs/aegishms.js
// Site: https://www.aegishms.com/careers
// Verdict: CAREERS_PAGE
//
// Structural findings:
// - Single-page careers listing with 3 JobPosting JSON-LD entries.
// - JSON-LD is authoritative for job title, company, location,
//   description, employment type, and application deadline.
// - The sample detail URL (/modules/front-office) is a marketing
//   page, NOT a job detail page. Discard its selectors.
// - No per-job detail navigation is required.
// - Company: Aegis Software.
// - Listing URL is used when no per-job application URL exists.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const BASE_URL = 'https://www.aegishms.com';
const CAREERS_URL = `${BASE_URL}/careers`;
const COMPANY = 'Aegis Software';

function cleanText(value) {
    if (value == null) return null;

    return String(value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/\s+/g, ' ')
        .trim() || null;
}

function absoluteUrl(value) {
    if (!value || typeof value !== 'string') return null;

    try {
        return new URL(value, BASE_URL).href;
    } catch (_) {
        return null;
    }
}

function normalizeEmploymentType(value) {
    if (!value) return null;

    const raw = Array.isArray(value) ? value.join(', ') : String(value);

    const types = {
        FULL_TIME: 'Full-time',
        PART_TIME: 'Part-time',
        CONTRACT: 'Contract',
        TEMPORARY: 'Temporary',
        INTERN: 'Internship',
        VOLUNTEER: 'Volunteer',
        PER_DIEM: 'Per diem',
        OTHER: 'Other'
    };

    return raw.split(',').map((type) => {
        const key = type.trim().toUpperCase();
        return types[key] || cleanText(type);
    }).filter(Boolean).join(', ') || null;
}

function extractLocation(job) {
    const locations = job.jobLocation;

    if (!locations) return null;

    const list = Array.isArray(locations) ? locations : [locations];

    const results = list.map((entry) => {
        const address = entry && entry.address;
        if (!address) return null;

        if (typeof address === 'string') {
            return cleanText(address);
        }

        const parts = [
            address.addressLocality,
            address.addressRegion,
            address.addressCountry
        ].map(cleanText).filter(Boolean);

        return parts.join(', ') || null;
    }).filter(Boolean);

    return [...new Set(results)].join(' / ') || null;
}

function extractSalary(job) {
    const salary = job.baseSalary;

    if (!salary) return null;

    if (typeof salary === 'string' || typeof salary === 'number') {
        return String(salary).slice(0, 60);
    }

    const currency = salary.currency || '';
    const value = salary.value;

    if (value == null) return null;

    if (typeof value === 'object') {
        const min = value.minValue;
        const max = value.maxValue;

        if (min != null && max != null) {
            return `${currency} ${min} - ${max}`.trim().slice(0, 60);
        }

        const amount = min ?? max ?? value.value;

        return amount != null
            ? `${currency} ${amount}`.trim().slice(0, 60)
            : null;
    }

    return `${currency} ${value}`.trim().slice(0, 60);
}

function extractJobPostings(value, results = []) {
    if (!value) return results;

    if (Array.isArray(value)) {
        for (const entry of value) {
            extractJobPostings(entry, results);
        }
        return results;
    }

    if (typeof value !== 'object') return results;

    const type = value['@type'];
    const types = Array.isArray(type) ? type : [type];

    if (types.some((entry) => entry === 'JobPosting')) {
        results.push(value);
    }

    if (value['@graph']) {
        extractJobPostings(value['@graph'], results);
    }

    return results;
}

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        // ---- Load careers page ----
        try {
            meta.pagesVisited++;

            await loadPage(page, CAREERS_URL, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            await delay(500);
        } catch (_) {
            meta.listingHits = 0;
            return { items, meta };
        }

        // ---- Detect blocking ----
        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (_) {
            // Diagnostics are best-effort.
        }

        // ---- Read structured data ----
        const result = await page.evaluate(() => {
            const scripts = Array.from(
                document.querySelectorAll(
                    'script[type="application/ld+json"]'
                )
            );

            const structuredData = [];

            for (const script of scripts) {
                try {
                    structuredData.push(JSON.parse(script.textContent));
                } catch (_) {
                    // Ignore malformed JSON-LD blocks.
                }
            }

            const bodyText = document.body?.innerText || '';

            const emptyPatterns = [
                /no open positions/i,
                /no current openings/i,
                /no job openings/i,
                /no vacancies/i,
                /no any vacancy/i,
                /not hiring/i,
                /check back soon/i,
                /there are no (open|current)/i,
                /sorry,\s*no positions available at this time/i
            ];

            const emptyState = emptyPatterns.some(
                (pattern) => pattern.test(bodyText)
            );

            return {
                structuredData,
                emptyState,
                pageTitle: document.title,
                ogSiteName: document.querySelector(
                    'meta[property="og:site_name"]'
                )?.content || null
            };
        });

        // ---- Find JobPosting objects ----
        const postings = [];

        for (const data of result.structuredData || []) {
            extractJobPostings(data, postings);
        }

        // Deduplicate structured data by identifier/title.
        const seen = new Set();

        const uniquePostings = postings.filter((job) => {
            const key = String(
                job.identifier?.value ||
                job.identifier ||
                job.title ||
                ''
            ).trim().toLowerCase();

            if (!key || seen.has(key)) return false;

            seen.add(key);
            return true;
        });

        meta.listingHits = uniquePostings.length;
        safeDiscovered(progress, uniquePostings.length);

        // ---- Empty-state handling ----
        if (uniquePostings.length === 0) {
            if (result.emptyState) {
                meta.atsEmpty = true;
            }

            console.log('  [aegishms] extracted 0');
            return { items, meta };
        }

        // ---- Build job items ----
        for (const job of uniquePostings) {
            try {
                const title = cleanText(job.title);

                if (!title) continue;

                const companyName = cleanText(
                    job.hiringOrganization?.name
                ) || COMPANY;

                const description = cleanText(job.description);

                const location = extractLocation(job);

                const employmentType = normalizeEmploymentType(
                    job.employmentType
                );

                const applicationEndsRaw = cleanText(
                    job.validThrough
                );

                const publishedAt = cleanText(
                    job.datePosted
                );

                const salary = extractSalary(job);

                const image = absoluteUrl(
                    typeof job.image === 'string'
                        ? job.image
                        : job.image?.url
                );

                const applicationUrl = absoluteUrl(
                    job.applicationUrl ||
                    job.applyUrl ||
                    job.url
                );

                const url = applicationUrl || CAREERS_URL;

                const identifier = cleanText(
                    job.identifier?.value ||
                    job.identifier
                );

                const idSource = identifier || title;

                const id = `aegishms-${idSource
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, '')}`;

                const companyUrl = absoluteUrl(
                    job.hiringOrganization?.sameAs ||
                    job.hiringOrganization?.url
                );

                const jobLocationType = cleanText(
                    job.jobLocationType
                );

                const attendanceMode = jobLocationType
                    ? /TELECOMMUTE/i.test(jobLocationType)
                        ? 'remote'
                        : 'in-person'
                    : location && /remote/i.test(location)
                        ? 'remote'
                        : null;

                const jobText = [
                    title,
                    description
                ].filter(Boolean).join(' ');

                const experienceMatch = jobText.match(
                    /(\d+\+?\s*(?:years?|yrs?)(?:\s+of)?\s+experience)/i
                );

                const levelMatch = jobText.match(
                    /\b(Junior|Entry[- ]Level|Mid[- ]Level|Senior|Lead)\b/i
                );

                const openingsMatch = title.match(
                    /(\d+)\s+Positions?/i
                );

                const responsibilities = job.responsibilities
                    ? cleanText(job.responsibilities)
                    : null;

                const requirements = job.qualifications
                    ? cleanText(job.qualifications)
                    : null;

                items.push({
                    id,
                    title,

                    company: companyName,
                    company_status: 'extracted',
                    company_evidence: job.hiringOrganization?.name
                        ? 'JSON-LD JobPosting.hiringOrganization.name'
                        : 'Site-wide company identity: Careers | Aegis Software',

                    description,
                    description_status: description
                        ? 'extracted'
                        : 'site_absent',
                    description_evidence: description
                        ? 'JSON-LD JobPosting.description'
                        : 'JSON-LD JobPosting.description was empty',

                    date: publishedAt,
                    time: null,

                    location,
                    location_status: location
                        ? 'extracted'
                        : 'site_absent',
                    location_evidence: location
                        ? 'JSON-LD JobPosting.jobLocation.address'
                        : 'Checked JSON-LD jobLocation and address fields',

                    price: null,
                    organizer: companyName,
                    category: cleanText(
                        job.industry || job.occupationalCategory
                    ),
                    tags: [
                        employmentType,
                        levelMatch?.[1],
                        attendanceMode
                    ].filter(Boolean),

                    image,
                    image_status: image
                        ? 'extracted'
                        : 'site_absent',
                    image_evidence: image
                        ? 'JSON-LD JobPosting.image'
                        : 'No per-job image in JSON-LD JobPosting',

                    url,
                    url_status: 'extracted',
                    url_evidence: applicationUrl
                        ? 'JSON-LD applicationUrl, applyUrl, or url'
                        : 'No per-job URL; using careers listing URL',

                    registrationUrl: applicationUrl || CAREERS_URL,
                    attendanceMode,
                    source: 'aegishms',

                    employmentType,
                    employmentType_status: employmentType
                        ? 'extracted'
                        : 'site_absent',
                    employmentType_evidence: employmentType
                        ? 'JSON-LD JobPosting.employmentType'
                        : 'Checked JSON-LD employmentType',

                    applicationEndsRaw,
                    applicationEnds_status: applicationEndsRaw
                        ? 'extracted'
                        : 'site_absent',
                    applicationEnds_evidence: applicationEndsRaw
                        ? 'JSON-LD JobPosting.validThrough'
                        : 'Checked JSON-LD JobPosting.validThrough',

                    salary,
                    salary_status: salary
                        ? 'extracted'
                        : 'site_absent',
                    salary_evidence: salary
                        ? 'JSON-LD JobPosting.baseSalary'
                        : 'Checked JSON-LD JobPosting.baseSalary',

                    experience: cleanText(job.experienceRequirements)
                        || experienceMatch?.[1]
                        || null,

                    level: levelMatch?.[1] || null,

                    openings: openingsMatch?.[1] || null,

                    responsibilities,
                    requirements,

                    publishedAt,

                    companyUrl,
                    companyLogoUrl: absoluteUrl(
                        job.hiringOrganization?.logo?.url ||
                        job.hiringOrganization?.logo
                    )
                });
            } catch (_) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log('  [aegishms] extracted ' + items.length);

        return { items, meta };
    }
};