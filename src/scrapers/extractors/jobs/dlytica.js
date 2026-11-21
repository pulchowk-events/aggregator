// VERDICT: CAREERS_PAGE
// Structure: careers listing -> individual /career/:slug job detail pages.
// The /solutions/* links are navigation links, not job detail routes.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { sanitizeJobFields } = require('../../jobs');

const BASE_URL = 'https://dlytica.com';
const LISTING_URL = `${BASE_URL}/career`;
const COMPANY = 'Dlytica AI';

function absoluteUrl(href) {
    if (!href) return null;
    try {
        return new URL(href, BASE_URL).href;
    } catch {
        return null;
    }
}

function cleanText(value) {
    return value
        ? value.replace(/\s+/g, ' ').trim()
        : null;
}

function extractLabeledValue(text, labels) {
    if (!text) return null;

    const pattern = new RegExp(
        `(?:^|\\n)\\s*(?:${labels.join('|')})\\s*:\\s*([^\\n]+)`,
        'i'
    );

    const match = text.match(pattern);
    return match ? cleanText(match[1]) : null;
}

function classifyEmploymentType(text) {
    if (!text) return null;

    const value = text.toLowerCase();

    if (/\bintern(ship)?\b/.test(value)) return 'Internship';
    if (/\bpart[\s-]?time\b/.test(value)) return 'Part-time';
    if (/\bfull[\s-]?time\b/.test(value)) return 'Full-time';
    if (/\bcontract\b/.test(value)) return 'Contract';
    if (/\btemporary\b/.test(value)) return 'Temporary';

    return null;
}

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];
        const seen = new Set();

        meta.atsEmpty = false;

        // ---------------------------------------------------------
        // 1. Load careers listing and detect blocking.
        // ---------------------------------------------------------

        meta.pagesVisited++;

        await loadPage(page, LISTING_URL, { timeout: 60000 });
        await delay(1200);

        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch {
            // Page-state detection is best effort.
        }

        // ---------------------------------------------------------
        // 2. Harvest actual job links.
        // Ignore /solutions/*, /services/* and navigation links.
        // ---------------------------------------------------------

        const listing = await page.evaluate(() => {
            const getText = (el) => el
                ? el.textContent.replace(/\s+/g, ' ').trim()
                : null;

            const cards = Array.from(
                document.querySelectorAll('div.single-circular-box.job-card')
            );

            const entries = [];

            for (const card of cards) {
                const link = card.querySelector(
                    'a[href^="/career/"], a[href*="dlytica.com/career/"]'
                );

                if (!link) continue;

                const href = link.getAttribute('href');
                const title = getText(
                    card.querySelector('h3, h2') || link
                );

                if (!href || !title) continue;

                const dateEl = card.querySelector('time[datetime]');

                entries.push({
                    href,
                    title,
                    excerpt: getText(
                        card.querySelector('.job-card-excerpt')
                    ),
                    postedAt: dateEl
                        ? dateEl.getAttribute('datetime')
                        : null,
                    postedText: dateEl ? getText(dateEl) : null
                });
            }

            // Also capture other opening types, including tutor
            // openings, if they use different card wrappers.
            const main = document.querySelector('main') || document.body;

            for (const link of main.querySelectorAll('a[href]')) {
                const href = link.getAttribute('href') || '';

                if (!/^\/career\/[^/#?]+\/?$/.test(href)) continue;

                const title = getText(link);

                if (!title || /apply this job/i.test(title)) {
                    const card = link.closest(
                        'div.single-circular-box.job-card'
                    );

                    if (!card) continue;
                }

                const card = link.closest(
                    'div.single-circular-box.job-card'
                );

                const dateEl = card
                    ? card.querySelector('time[datetime]')
                    : null;

                entries.push({
                    href,
                    title: card
                        ? getText(card.querySelector('h3, h2')) || title
                        : title,
                    excerpt: card
                        ? getText(card.querySelector('.job-card-excerpt'))
                        : null,
                    postedAt: dateEl
                        ? dateEl.getAttribute('datetime')
                        : null,
                    postedText: dateEl ? getText(dateEl) : null
                });
            }

            const emptyText = document.body.innerText.toLowerCase();

            const emptyPatterns = [
                'no open positions',
                'no current openings',
                'no job openings',
                'no vacancies',
                'not hiring',
                'check back soon',
                'no positions available'
            ];

            return {
                entries,
                empty: emptyPatterns.some(
                    (pattern) => emptyText.includes(pattern)
                ),
                bodyText: document.body.innerText
            };
        });

        // ---------------------------------------------------------
        // 3. Empty-state handling.
        // ---------------------------------------------------------

        if (!listing.entries.length) {
            meta.listingHits = 0;
            meta.atsEmpty = Boolean(listing.empty);
            return { items, meta };
        }

        // Deduplicate URLs while preserving listing metadata.
        const entries = [];

        for (const entry of listing.entries) {
            const url = absoluteUrl(entry.href);

            if (!url || !url.startsWith(`${BASE_URL}/career/`)) {
                continue;
            }

            if (seen.has(url)) continue;

            seen.add(url);

            entries.push({
                ...entry,
                url
            });
        }

        meta.listingHits = entries.length;
        safeDiscovered(progress, entries.length);

        // ---------------------------------------------------------
        // 4. Extract each individual job detail page.
        // ---------------------------------------------------------

        for (const entry of entries) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                await loadPage(page, entry.url, { timeout: 60000 });
                await delay(700);

                const raw = await page.evaluate(() => {
                    const getText = (el) => el
                        ? el.textContent.replace(/\s+/g, ' ').trim()
                        : null;

                    const main = document.querySelector('main') ||
                        document.body;

                    const title = getText(
                        main.querySelector('h1')
                    );

                    const metaContent = (selector) => {
                        const el = document.querySelector(selector);
                        return el ? el.getAttribute('content') : null;
                    };

                    // Remove website chrome before reading role content.
                    const contentRoot = main.cloneNode(true);

                    contentRoot.querySelectorAll(
                        'header, footer, nav, script, style, iframe, ' +
                        '.menu-container, .mobile-menu-area, ' +
                        '.desktop_menu, .mobile-menu'
                    ).forEach((el) => el.remove());

                    const allText = contentRoot.innerText || '';

                    // Prefer structured role paragraphs and lists.
                    // This avoids collecting the entire website body.
                    const contentNodes = Array.from(
                        contentRoot.querySelectorAll('p, li')
                    );

                    const descriptionParts = contentNodes
                        .map((el) => {
                            const text = getText(el);

                            if (!text || text.length < 15) return null;

                            if (/^(home|career|solutions|products)$/i.test(text)) {
                                return null;
                            }

                            return el.tagName === 'LI'
                                ? `• ${text}`
                                : text;
                        })
                        .filter(Boolean);

                    const description = [
                        ...new Set(descriptionParts)
                    ].join('\n');

                    // Extract metadata from the actual job content.
                    const location = (() => {
                        const match = allText.match(
                            /Location\s*:\s*([^\n]+)/i
                        );

                        if (match) return match[1].trim();

                        const office = allText.match(
                            /Office Location\s+([^\n]+)/i
                        );

                        return office ? office[1].trim() : null;
                    })();

                    const jobType = (() => {
                        const match = allText.match(
                            /Job type\s*:\s*([^\n]+)/i
                        );

                        if (match) return match[1].trim();

                        const alternate = allText.match(
                            /Job Type\s+([^\n]+)/i
                        );

                        return alternate ? alternate[1].trim() : null;
                    })();

                    const experience = (() => {
                        const match = allText.match(
                            /Experience\s*:\s*([^\n]+)/i
                        );

                        if (match) return match[1].trim();

                        const alternate = allText.match(
                            /Experience\s+([^\n]+)/i
                        );

                        return alternate ? alternate[1].trim() : null;
                    })();

                    const openings = (() => {
                        const match = allText.match(
                            /(?:Total openings|Vacancy)\s*:\s*(\d+)/i
                        );

                        if (match) return Number(match[1]);

                        const alternate = allText.match(
                            /Vacancy\s+(\d+)/i
                        );

                        return alternate ? Number(alternate[1]) : null;
                    })();

                    const salary = (() => {
                        const match = allText.match(
                            /(?:Salary|Compensation|Remuneration)\s*:\s*([^\n]+)/i
                        );

                        return match ? match[1].trim() : null;
                    })();

                    const applyLink = Array.from(
                        contentRoot.querySelectorAll('a[href]')
                    ).find((a) => {
                        return /apply now|apply this job/i.test(
                            getText(a) || ''
                        );
                    });

                    const applyUrl = applyLink
                        ? applyLink.getAttribute('href')
                        : null;

                    const image = (() => {
                        const images = Array.from(
                            contentRoot.querySelectorAll('img')
                        );

                        const img = images.find((el) => {
                            const src = el.getAttribute('src') || '';

                            return src &&
                                !/logo|placeholder|icon/i.test(
                                    src + ' ' + (el.alt || '')
                                );
                        });

                        return img
                            ? (img.currentSrc || img.getAttribute('src'))
                            : null;
                    })();

                    const deadlineMatch = allText.match(
                        /(?:application deadline|apply before|closing date|last date to apply)\s*:?\s*([^\n]+)/i
                    );

                    const companyMeta = metaContent(
                        'meta[property="og:site_name"]'
                    );

                    const company = companyMeta ||
                        'Dlytica AI';

                    const publishedAt = (() => {
                        const time = document.querySelector(
                            'time[datetime]'
                        );

                        return time
                            ? time.getAttribute('datetime')
                            : null;
                    })();

                    return {
                        title,
                        company,
                        description,
                        location,
                        jobType,
                        experience,
                        openings,
                        salary,
                        applyUrl,
                        image,
                        deadlineRaw: deadlineMatch
                            ? deadlineMatch[1].trim()
                            : null,
                        publishedAt,
                        allText,
                        companyMeta
                    };
                });

                // -------------------------------------------------
                // 5. Resolve title and description.
                // -------------------------------------------------

                const title = cleanText(raw.title || entry.title);

                if (!title) {
                    meta.detailParseFailures++;
                    continue;
                }

                const description = cleanText(raw.description) ||
                    cleanText(entry.excerpt) ||
                    null;

                // -------------------------------------------------
                // 6. Location fallback.
                // Never use the company's general address as the
                // individual job location.
                // -------------------------------------------------

                let location = cleanText(raw.location);

                if (location) {
                    location = location.replace(
                        /^(?:location|office location)\s*:\s*/i,
                        ''
                    );
                }

                // Listing excerpts sometimes include job summary
                // fields that are not repeated in the detail body.
                if (!location && entry.excerpt) {
                    const match = entry.excerpt.match(
                        /Location\s*:\s*([^.\n]+(?:,\s*[^.\n]+)*)/i
                    );

                    if (match) location = cleanText(match[1]);
                }

                if (location && location.length > 80) {
                    location = null;
                }

                // -------------------------------------------------
                // 7. Construct normalized job object.
                // -------------------------------------------------

                const employmentType = classifyEmploymentType(
                    raw.jobType || raw.allText
                );

                const applicationUrl = raw.applyUrl
                    ? absoluteUrl(raw.applyUrl)
                    : null;

                const item = {
                    id: `dlytica-${entry.url.split('/').pop()}`,
                    title,

                    company: cleanText(raw.company) || COMPANY,
                    company_status: 'extracted',
                    company_evidence:
                        'og:site_name on detail page or Dlytica AI site branding',

                    companyUrl: BASE_URL,
                    companyLogoUrl: null,

                    description,

                    description_status: description
                        ? 'extracted'
                        : 'site_absent',

                    description_evidence: description
                        ? 'Detail-page main content paragraphs and list items; listing excerpt fallback'
                        : 'Searched detail-page main paragraphs, list items and listing excerpt',

                    location,

                    location_status: location
                        ? 'extracted'
                        : 'site_absent',

                    location_evidence: location
                        ? 'Detail-page Job Summary Location or Office Location; listing excerpt fallback'
                        : 'Searched Job Summary Location, Office Location and listing excerpt; no job-specific location found',

                    employmentType,

                    employmentType_status: employmentType
                        ? 'extracted'
                        : 'site_absent',

                    employmentType_evidence: employmentType
                        ? 'Detail-page Job type or employment wording'
                        : 'Searched Job type and employment wording on detail page',

                    attendanceMode: /remote/i.test(raw.jobType || '')
                        ? 'Remote'
                        : /hybrid/i.test(raw.jobType || '')
                            ? 'Hybrid'
                            : /onsite|on-site/i.test(raw.jobType || '')
                                ? 'On-site'
                                : null,

                    salary: raw.salary
                        ? cleanText(raw.salary)
                        : null,

                    salary_status: raw.salary
                        ? 'extracted'
                        : 'site_absent',

                    salary_evidence:
                        'Searched Salary, Compensation and Remuneration labels on detail page',

                    experience: cleanText(raw.experience),
                    level: null,
                    openings: raw.openings,
                    responsibilities: '',
                    requirements: '',
                    skills: [],

                    applicationEndsRaw: raw.deadlineRaw,
                    applicationEndsRaw_status: raw.deadlineRaw
                        ? 'extracted'
                        : 'site_absent',

                    applicationEndsRaw_evidence:
                        'Searched application deadline, apply before, closing date and last date to apply labels',

                    publishedAt: raw.publishedAt || entry.postedAt || null,

                    image: raw.image
                        ? absoluteUrl(raw.image)
                        : null,

                    url: entry.url,

                    registrationUrl: applicationUrl &&
                        /^https?:\/\//i.test(applicationUrl)
                        ? applicationUrl
                        : entry.url,

                    source: 'dlytica',
                    scrapedAt: Date.now()
                };

                // Include experience/openings only when published.
                if (!item.experience) {
                    item.experience_status = 'site_absent';
                    item.experience_evidence =
                        'Searched Experience label in Job Summary';
                } else {
                    item.experience_status = 'extracted';
                }

                if (item.openings === null) {
                    item.openings_status = 'site_absent';
                    item.openings_evidence =
                        'Searched Total openings and Vacancy labels';
                }

                if (!item.image) {
                    item.image_status = 'site_absent';
                    item.image_evidence =
                        'No suitable non-logo image found in job detail content';
                }

                sanitizeJobFields(item);

                items.push(item);
            } catch {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(
            '  [dlytica] extracted ' + items.length +
            ' jobs from ' + entries.length + ' detail pages'
        );

        return { items, meta };
    }
};