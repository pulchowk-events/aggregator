const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const CAREERS_URL = 'https://alpastechnology.com/careers';
const COMPANY = 'Alpas Technology';
const SOURCE = 'alpastechnology-2';

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        // VERDICT: CAREERS_PAGE
        // The entry URL is the careers page, but the six section.mb-14
        // matches are page sections, not individual job cards.
        // The only representative section contains marketing copy.
        // Open roles must be inspected independently.

        try {
            meta.pagesVisited++;
            await loadPage(page, CAREERS_URL, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });
            await delay(500);
        } catch (err) {
            console.warn(
                '  [alpastechnology-2] failed to load: ' + err.message
            );
            return { items, meta };
        }

        // Check for access restrictions once on the first load.
        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (_) {
            // Best effort.
        }

        const harvested = await page.evaluate(() => {
            const clean = (value) => {
                if (!value) return null;
                return value.replace(/\s+/g, ' ').trim() || null;
            };

            const absoluteUrl = (value) => {
                if (!value) return null;
                try {
                    return new URL(value, location.href).href;
                } catch (_) {
                    return null;
                }
            };

            const getMeta = (name) => {
                const element = document.querySelector(
                    `meta[property="${name}"], meta[name="${name}"]`
                );
                return element ? clean(element.content) : null;
            };

            // Collect authoritative JobPosting JSON-LD if present.
            const jobPosting = [];
            const visited = new Set();

            const inspectJsonLd = (value) => {
                if (!value || typeof value !== 'object') return;

                if (Array.isArray(value)) {
                    value.forEach(inspectJsonLd);
                    return;
                }

                const type = value['@type'];
                const types = Array.isArray(type) ? type : [type];

                if (types.includes('JobPosting')) {
                    jobPosting.push(value);
                }

                if (value['@graph']) inspectJsonLd(value['@graph']);
            };

            document.querySelectorAll(
                'script[type="application/ld+json"]'
            ).forEach((script) => {
                try {
                    inspectJsonLd(JSON.parse(script.textContent));
                } catch (_) {
                    // Ignore malformed JSON-LD.
                }
            });

            const emptyPatterns = [
                /no open positions/i,
                /no current openings/i,
                /no job openings/i,
                /no vacancies/i,
                /not hiring/i,
                /check back soon/i,
                /there are no (open|current)/i,
                /sorry, no positions available/i
            ];

            const bodyText = clean(document.body.innerText) || '';

            const explicitEmpty = emptyPatterns.some(
                (pattern) => pattern.test(bodyText)
            );

            const extractLocation = (value) => {
                if (!value) return null;

                if (typeof value === 'string') {
                    return clean(value);
                }

                if (typeof value === 'object') {
                    const address = value.address || value;
                    const parts = [
                        address.addressLocality,
                        address.addressRegion,
                        address.addressCountry
                    ].filter(Boolean);

                    return clean(parts.join(', '));
                }

                return null;
            };

            const extractDate = (value) => {
                if (!value) return null;
                return String(value);
            };

            const cards = jobPosting.map((job) => {
                const title = clean(job.title);
                const description = clean(
                    job.description
                        ? job.description.replace(/<[^>]*>/g, ' ')
                        : null
                );

                const hiring = job.hiringOrganization || {};
                const locationData = job.jobLocation;
                const locations = Array.isArray(locationData)
                    ? locationData
                    : locationData ? [locationData] : [];

                const location = locations
                    .map((entry) => extractLocation(entry.address))
                    .filter(Boolean)
                    .join(' / ') || null;

                return {
                    title,
                    description,
                    company: clean(hiring.name) || COMPANY,
                    location,
                    employmentType: clean(
                        Array.isArray(job.employmentType)
                            ? job.employmentType.join(', ')
                            : job.employmentType
                    ),
                    salary: clean(
                        job.baseSalary
                            ? JSON.stringify(job.baseSalary)
                            : null
                    ),
                    applicationEndsRaw: extractDate(
                        job.validThrough
                    ),
                    date: extractDate(job.datePosted),
                    url: absoluteUrl(
                        job.url || job.applicationUrl
                    ),
                    image: absoluteUrl(
                        typeof job.image === 'string'
                            ? job.image
                            : job.image && job.image.url
                    ),
                    experience: clean(
                        job.experienceRequirements
                    ),
                    level: clean(job.seniorityLevel),
                    openings: clean(job.totalJobOpenings),
                    companyUrl: absoluteUrl(hiring.sameAs),
                    sourceType: 'jsonld'
                };
            }).filter((job) => job.title);

            // The section.mb-14 selector is a page section, not a job
            // card. Locate the actual Open roles section and inspect
            // its list items instead.
            const headings = Array.from(
                document.querySelectorAll('h1, h2, h3')
            );

            const openRolesHeading = headings.find((heading) =>
                /^open roles$/i.test(clean(heading.textContent) || '')
            );

            let roleSection = null;

            if (openRolesHeading) {
                roleSection = openRolesHeading.closest('section');

                if (!roleSection) {
                    let current = openRolesHeading.parentElement;
                    while (current && current !== document.body) {
                        if (
                            current.querySelectorAll('li').length ||
                            current.querySelectorAll('article').length
                        ) {
                            roleSection = current;
                            break;
                        }
                        current = current.parentElement;
                    }
                }
            }

            const domCards = [];

            if (roleSection) {
                const candidates = Array.from(
                    roleSection.querySelectorAll(
                        'article, li, [class*="job"], [class*="role"]'
                    )
                );

                const seen = new Set();

                for (const element of candidates) {
                    if (element.closest('header, footer, nav')) continue;

                    const heading = element.querySelector(
                        'h2, h3, h4, h5'
                    );

                    if (!heading) continue;

                    const title = clean(heading.textContent);
                    if (!title || title.length > 150) continue;

                    // Exclude nested duplicates.
                    if (seen.has(title)) continue;

                    const text = clean(element.innerText) || '';
                    if (text.length < 15) continue;

                    seen.add(title);

                    const links = Array.from(
                        element.querySelectorAll('a[href]')
                    );

                    const applyLink = links.find((link) =>
                        /apply|application|job|career/i.test(
                            (link.textContent || '') + ' ' +
                            link.getAttribute('href')
                        )
                    );

                    const locationMatch = text.match(
                        /(?:Location|Based in|Office)\s*[:\-]?\s*([^\n|]{2,70})/i
                    );

                    const salaryMatch = text.match(
                        /(?:Salary|Compensation|NPR|USD|Rs\.?)\s*[:\-]?\s*([^\n|]{2,60})/i
                    );

                    const employmentMatch = text.match(
                        /\b(Full[- ]?Time|Part[- ]?Time|Contract|Internship|Temporary)\b/i
                    );

                    const deadlineMatch = text.match(
                        /(?:Deadline|Apply by|Applications close)\s*[:\-]?\s*([^\n|]{3,40})/i
                    );

                    domCards.push({
                        title,
                        description: null,
                        company: COMPANY,
                        location: locationMatch
                            ? clean(locationMatch[1])
                            : null,
                        salary: salaryMatch
                            ? clean(salaryMatch[1])
                            : null,
                        employmentType: employmentMatch
                            ? clean(employmentMatch[1])
                            : null,
                        applicationEndsRaw: deadlineMatch
                            ? clean(deadlineMatch[1])
                            : null,
                        url: applyLink
                            ? absoluteUrl(applyLink.href)
                            : null,
                        image: null,
                        sourceType: 'dom'
                    });
                }
            }

            return {
                cards,
                domCards,
                explicitEmpty,
                hasOpenRolesHeading: !!openRolesHeading,
                company: getMeta('og:site_name') || COMPANY
            };
        });

        // JSON-LD is authoritative when actual JobPosting records exist.
        // Otherwise use only verified role-shaped DOM elements.
        const cards = harvested.cards.length
            ? harvested.cards
            : harvested.domCards;

        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);

        if (!cards.length) {
            if (harvested.explicitEmpty) {
                meta.atsEmpty = true;
            }

            console.log('  [alpastechnology-2] extracted 0');
            return { items, meta };
        }

        for (const card of cards) {
            try {
                const title = card.title;
                if (!title) continue;

                const description = card.description || null;
                const company = card.company || harvested.company || COMPANY;
                const location = card.location || null;
                const url = card.url || CAREERS_URL;

                items.push({
                    id: 'alpastechnology-2-' +
                        title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),

                    title,
                    title_status: 'extracted',
                    title_evidence: 'JobPosting JSON-LD or heading inside Open roles',

                    company,
                    company_status: 'extracted',
                    company_evidence: 'og:site_name Alpas Technology',

                    description,
                    description_status: description
                        ? 'extracted'
                        : 'site_absent',
                    description_evidence: description
                        ? 'JobPosting description'
                        : 'No role-specific description found in listing DOM or JobPosting JSON-LD',

                    location,
                    location_status: location
                        ? 'extracted'
                        : 'site_absent',
                    location_evidence: location
                        ? 'JobPosting jobLocation or role card location label'
                        : 'Checked JobPosting jobLocation and role-card location labels',

                    url,
                    url_status: card.url
                        ? 'extracted'
                        : 'site_absent',
                    url_evidence: card.url
                        ? 'JobPosting URL or role-card application link'
                        : 'No per-role URL; using careers listing URL',

                    date: card.date || null,
                    time: null,
                    price: null,
                    organizer: company,
                    category: null,
                    tags: [
                        card.employmentType,
                        card.level
                    ].filter(Boolean),

                    image: card.image || null,
                    image_status: card.image
                        ? 'extracted'
                        : 'site_absent',
                    image_evidence: card.image
                        ? 'JobPosting image'
                        : 'No per-role image found in JobPosting JSON-LD',

                    registrationUrl: card.url || null,
                    attendanceMode: null,
                    source: SOURCE,

                    employmentType: card.employmentType || null,
                    employmentType_status: card.employmentType
                        ? 'extracted'
                        : 'site_absent',
                    employmentType_evidence: card.employmentType
                        ? 'JobPosting employmentType or role card text'
                        : 'Checked JobPosting employmentType and role-card text',

                    applicationEndsRaw: card.applicationEndsRaw || null,
                    applicationEnds_status: card.applicationEndsRaw
                        ? 'extracted'
                        : 'site_absent',
                    applicationEnds_evidence: card.applicationEndsRaw
                        ? 'JobPosting validThrough or role-card deadline'
                        : 'Checked JobPosting validThrough and role-card deadline',

                    salary: card.salary || null,
                    salary_status: card.salary
                        ? 'extracted'
                        : 'site_absent',
                    salary_evidence: card.salary
                        ? 'JobPosting baseSalary or role-card salary text'
                        : 'Checked JobPosting baseSalary and role-card salary text',

                    experience: card.experience || null,
                    level: card.level || null,
                    openings: card.openings || null,
                    companyUrl: card.companyUrl || null
                });
            } catch (_) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(
            '  [alpastechnology-2] extracted ' + items.length
        );

        return { items, meta };
    }
};