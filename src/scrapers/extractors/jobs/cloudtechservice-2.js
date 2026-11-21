// VERDICT: CAREERS_PAGE
//
// Corrections to wizard assumptions:
// - div.cr-benefit-card.sr-reveal contains employee benefits, NOT job listings.
//   The raw HTML confirms "Social Security Fund" and benefit descriptions.
// - The actual job title selector is [class*="position-title"] (h3).
// - The listing contains "CURRENT OPPORTUNITIES", "Open Positions",
//   and actual role titles such as "AI Enablement Lead".
// - The sample detail URL (/services/) is unrelated marketing content.
// - No JobPosting JSON-LD is present. Only generic ProfessionalService,
//   WebSite, WebPage, Person and Article structured data.
// - Do not navigate to /services/ or use its H1/accordion as job details.
// - Company is confirmed by og:site:name: CloudTech Services.
// - Office addresses are site-wide and must not be assigned to individual jobs.
// - Extract directly from the careers listing and inspect title ancestors
//   for role-specific descriptions and metadata.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const CTS_URL = 'https://cloudtechservice.com/careers/';
const CTS_COMPANY = 'CloudTech Services';
const SOURCE = 'cloudtechservice-2';

function clean(value) {
    return value
        ? String(value).replace(/\s+/g, ' ').trim()
        : null;
}

function parseJobText(text) {
    const out = {};

    if (!text) return out;

    const employmentPatterns = [
        /\b(full[- ]?time)\b/i,
        /\b(part[- ]?time)\b/i,
        /\b(contract(?:or)?)\b/i,
        /\b(internship|intern)\b/i,
        /\b(temporary|freelance)\b/i
    ];

    for (const pattern of employmentPatterns) {
        const match = text.match(pattern);
        if (match) {
            out.employmentType = match[1];
            break;
        }
    }

    const mode = text.match(/\b(remote|hybrid|on[- ]site)\b/i);
    if (mode) {
        out.attendanceMode = mode[1]
            .toLowerCase()
            .replace(/[- ]/g, '');
    }

    const levelPatterns = [
        /\b(entry[- ]level|junior)\b/i,
        /\b(mid[- ]level|intermediate)\b/i,
        /\b(senior|lead|principal|director)\b/i
    ];

    for (const pattern of levelPatterns) {
        const match = text.match(pattern);
        if (match) {
            out.level = match[1];
            break;
        }
    }

    const experience = text.match(
        /\b(\d+\+?\s*(?:years?|yrs?)(?:\s+of\s+experience)?)\b/i
    );

    if (experience) out.experience = experience[1];

    const openings = text.match(
        /\b(\d+)\s*(?:openings?|positions?|vacancies)\b/i
    );

    if (openings) out.openings = openings[1];

    const deadlinePatterns = [
        /(?:application\s+)?deadline\s*[:\-]?\s*([^\n|]{3,50})/i,
        /apply\s+by\s*[:\-]?\s*([^\n|]{3,50})/i,
        /applications?\s+close\s*[:\-]?\s*([^\n|]{3,50})/i
    ];

    for (const pattern of deadlinePatterns) {
        const match = text.match(pattern);
        if (match) {
            out.applicationEndsRaw = clean(match[1]);
            break;
        }
    }

    const salary = text.match(
        /(?:salary|compensation|pay)\s*[:\-]?\s*([^\n|]{2,55})/i
    );

    const currency = text.match(
        /(?:NPR|USD|Rs\.?|[$])\s*[\d,]+(?:\s*[-–]\s*[$\d,]+)?/i
    );

    if (salary) {
        out.salary = clean(salary[1]);
    } else if (currency) {
        out.salary = clean(currency[0]);
    }

    const locationPatterns = [
        /(?:job\s+)?location\s*[:\-]?\s*([^\n|]{2,70})/i,
        /based\s+in\s*[:\-]?\s*([^\n|]{2,70})/i,
        /work\s+location\s*[:\-]?\s*([^\n|]{2,70})/i
    ];

    for (const pattern of locationPatterns) {
        const match = text.match(pattern);
        if (match) {
            const value = clean(match[1]);
            if (value && value.length < 80) {
                out.location = value;
                break;
            }
        }
    }

    return out;
}

function makeId(title) {
    return SOURCE + '-' + title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];
        const seen = new Set();

        try {
            meta.pagesVisited++;

            await loadPage(page, CTS_URL, {
                waitUntil: 'networkidle2',
                timeout: 30000
            });

            await delay(700);
        } catch (err) {
            console.warn(
                '  [' + SOURCE + '] careers page load failed: ' + err.message
            );
            return { items, meta };
        }

        // Check blocking once, immediately after the first load.
        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (_) {
            // Diagnostics are best-effort.
        }

        try {
            await page.waitForSelector(
                '[class*="position-title"]',
                { timeout: 10000 }
            );
        } catch (_) {
            // Empty-state detection below handles missing titles.
        }

        const harvested = await page.evaluate(() => {
            const cleanText = (value) => {
                return value
                    ? value.replace(/\s+/g, ' ').trim()
                    : null;
            };

            const bodyText = document.body
                ? document.body.innerText || ''
                : '';

            const titleNodes = Array.from(
                document.querySelectorAll('[class*="position-title"]')
            );

            const jsonLdJobs = [];

            // Only JobPosting JSON-LD is relevant.
            document.querySelectorAll(
                'script[type="application/ld+json"]'
            ).forEach((script) => {
                try {
                    const data = JSON.parse(script.textContent || '{}');
                    const entries = Array.isArray(data)
                        ? data
                        : [data];

                    const collect = (entry) => {
                        if (!entry || typeof entry !== 'object') return;

                        if (Array.isArray(entry)) {
                            entry.forEach(collect);
                            return;
                        }

                        const type = entry['@type'];

                        if (
                            type === 'JobPosting' ||
                            (Array.isArray(type) && type.includes('JobPosting'))
                        ) {
                            jsonLdJobs.push(entry);
                        }

                        if (entry['@graph']) collect(entry['@graph']);
                    };

                    collect(entries);
                } catch (_) {
                    // Ignore malformed JSON-LD.
                }
            });

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

            const emptyMessage = emptyPatterns.some(
                (pattern) => pattern.test(bodyText)
            );

            const companyMeta = document.querySelector(
                'meta[property="og:site_name"]'
            );

            const company = cleanText(
                companyMeta
                    ? companyMeta.getAttribute('content')
                    : null
            );

            const siteDescription = document.querySelector(
                'meta[property="og:description"]'
            );

            const jobs = [];
            const processedTitles = new Set();

            for (const titleNode of titleNodes) {
                const title = cleanText(titleNode.innerText);

                if (
                    !title ||
                    title.length < 3 ||
                    title.length > 180 ||
                    processedTitles.has(title.toLowerCase())
                ) {
                    continue;
                }

                processedTitles.add(title.toLowerCase());

                // Walk upward from the verified title element.
                // Avoid the entire listing section and unrelated page content.
                let bestContainer = null;
                let current = titleNode.parentElement;

                for (let depth = 0; current && depth < 7; depth++) {
                    const text = cleanText(current.innerText);

                    if (!text) {
                        current = current.parentElement;
                        continue;
                    }

                    const otherTitles = Array.from(
                        current.querySelectorAll('[class*="position-title"]')
                    ).filter((node) => node !== titleNode);

                    if (
                        otherTitles.length === 0 &&
                        text.length > title.length + 20 &&
                        text.length < 6000
                    ) {
                        bestContainer = current;
                        break;
                    }

                    current = current.parentElement;
                }

                const containerText = cleanText(
                    bestContainer ? bestContainer.innerText : null
                );

                let description = null;

                if (containerText) {
                    description = containerText;

                    // Remove the job title from the beginning.
                    description = description
                        .replace(
                            new RegExp(
                                '^' + title.replace(
                                    /[.*+?^${}()|[\]\\]/g,
                                    '\\$&'
                                ) + '\\s*',
                                'i'
                            ),
                            ''
                        )
                        .trim();

                    // Remove generic application CTA text.
                    description = description
                        .replace(/\bApply Now\b/gi, '')
                        .replace(/\bView Details\b/gi, '')
                        .trim();

                    if (
                        description.length < 30 ||
                        description.toLowerCase() === title.toLowerCase()
                    ) {
                        description = null;
                    }
                }

                // Look for a role-specific link inside the container.
                let jobUrl = null;

                if (bestContainer) {
                    const links = Array.from(
                        bestContainer.querySelectorAll('a[href]')
                    );

                    const link = links.find((anchor) => {
                        const href = anchor.getAttribute('href') || '';
                        const label = cleanText(anchor.innerText) || '';

                        return (
                            href &&
                            !href.startsWith('#') &&
                            !href.startsWith('mailto:') &&
                            !href.startsWith('tel:') &&
                            !href.startsWith('javascript:') &&
                            /apply|job details|view position/i.test(label)
                        );
                    });

                    if (link) {
                        try {
                            jobUrl = new URL(
                                link.getAttribute('href'),
                                location.href
                            ).href;
                        } catch (_) {
                            // Ignore invalid links.
                        }
                    }
                }

                // Look for an image inside the role container.
                let image = null;

                if (bestContainer) {
                    const img = bestContainer.querySelector('img');

                    if (img) {
                        try {
                            image = window.__resolveImageSrc(img);
                        } catch (_) {
                            image = img.currentSrc || img.src || null;
                        }
                    }
                }

                // Role-specific structured data takes precedence.
                const structured = jsonLdJobs.find((job) => {
                    return cleanText(job.title)?.toLowerCase() ===
                        title.toLowerCase();
                });

                jobs.push({
                    title,
                    description,
                    url: jobUrl,
                    image,
                    text: containerText,
                    structured
                });
            }

            return {
                jobs,
                company,
                bodyText,
                emptyMessage,
                titleCount: titleNodes.length,
                jsonLdCount: jsonLdJobs.length,
                pageTitle: document.title,
                ogDescription: cleanText(
                    siteDescription
                        ? siteDescription.getAttribute('content')
                        : null
                )
            };
        });

        const cards = harvested.jobs || [];

        // No role-shaped cards plus an explicit empty-state message.
        if (harvested.emptyMessage && cards.length === 0) {
            meta.atsEmpty = true;
            meta.listingHits = 0;
            safeDiscovered(progress, 0);
            console.log('  [' + SOURCE + '] extracted 0');
            return { items, meta };
        }

        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);

        // Build the final normalized items.
        for (const card of cards) {
            try {
                const structured = card.structured || {};
                const text = card.text || '';
                const parsed = parseJobText(text);

                const title = clean(card.title);
                if (!title) continue;

                if (seen.has(title.toLowerCase())) continue;
                seen.add(title.toLowerCase());

                // JSON-LD location takes precedence when available.
                let structuredLocation = null;

                if (structured.jobLocation) {
                    const locations = Array.isArray(
                        structured.jobLocation
                    )
                        ? structured.jobLocation
                        : [structured.jobLocation];

                    const first = locations[0];

                    if (first && first.address) {
                        const address = first.address;

                        structuredLocation = [
                            address.addressLocality,
                            address.addressRegion,
                            address.addressCountry
                        ].filter(Boolean).join(', ');
                    }
                }

                const location = structuredLocation || parsed.location || null;

                const description = clean(
                    typeof structured.description === 'string'
                        ? structured.description.replace(/<[^>]*>/g, ' ')
                        : card.description
                );

                const employmentType = structured.employmentType
                    ? clean(
                        Array.isArray(structured.employmentType)
                            ? structured.employmentType.join(', ')
                            : structured.employmentType
                    )
                    : parsed.employmentType || null;

                const salary = structured.baseSalary
                    ? clean(
                        JSON.stringify(structured.baseSalary)
                    )
                    : parsed.salary || null;

                const deadline = structured.validThrough
                    || parsed.applicationEndsRaw
                    || null;

                const url = card.url || CTS_URL;

                const item = {
                    id: makeId(title),
                    title,

                    title_status: 'extracted',
                    title_evidence:
                        '[class*="position-title"] heading on careers page',

                    company: harvested.company || CTS_COMPANY,
                    company_status: 'extracted',
                    company_evidence:
                        'og:site_name metadata: CloudTech Services',

                    description,
                    description_status: description
                        ? 'extracted'
                        : 'site_absent',
                    description_evidence: description
                        ? 'Role-specific title ancestor text or matching JobPosting JSON-LD'
                        : 'Inspected ancestors of [class*="position-title"]; no substantive role body found',

                    url,
                    url_status: 'extracted',
                    url_evidence: card.url
                        ? 'Role-specific application link inside title ancestor'
                        : 'No per-role detail link found; using careers listing URL',

                    location,
                    location_status: location
                        ? 'extracted'
                        : 'site_absent',
                    location_evidence: location
                        ? 'JobPosting jobLocation or role-specific location label'
                        : 'Inspected role text and JobPosting jobLocation; site-wide office addresses excluded',

                    employmentType,
                    employmentType_status: employmentType
                        ? 'extracted'
                        : 'site_absent',
                    employmentType_evidence: employmentType
                        ? 'JobPosting employmentType or employment-type keyword in role text'
                        : 'No employment type found in role text or matching JobPosting JSON-LD',

                    applicationEndsRaw: deadline,
                    applicationEnds_status: deadline
                        ? 'extracted'
                        : 'site_absent',
                    applicationEnds_evidence: deadline
                        ? 'JobPosting validThrough or deadline label in role text'
                        : 'No validThrough or application deadline found',

                    salary,
                    salary_status: salary
                        ? 'extracted'
                        : 'site_absent',
                    salary_evidence: salary
                        ? 'JobPosting baseSalary or salary/currency token in role text'
                        : 'No salary or compensation information found',

                    image: card.image || null,
                    image_status: card.image
                        ? 'extracted'
                        : 'site_absent',
                    image_evidence: card.image
                        ? 'Image inside role-specific title ancestor'
                        : 'No image found inside role-specific title ancestor',

                    companyUrl: 'https://cloudtechservice.com/',
                    companyLogoUrl: null,
                    companyDescription: harvested.ogDescription || null,

                    experience: parsed.experience || null,
                    level: parsed.level || null,
                    openings: parsed.openings || null,

                    attendanceMode: parsed.attendanceMode || null,

                    date: null,
                    time: null,
                    price: null,
                    organizer: harvested.company || CTS_COMPANY,
                    category: null,
                    tags: [
                        employmentType,
                        parsed.level,
                        parsed.attendanceMode
                    ].filter(Boolean),

                    registrationUrl: card.url || null,
                    source: SOURCE
                };

                items.push(item);
            } catch (_) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(
            '  [' + SOURCE + '] extracted ' + items.length
        );

        return { items, meta };
    }
};