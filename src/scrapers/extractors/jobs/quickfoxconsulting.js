const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const {
    cleanDescriptionText
} = require('../../text');
const { sanitizeImageUrl } = require('../../sanitize');

const BASE_URL = 'https://quickfoxconsulting.com';
const LISTING_URL = `${BASE_URL}/careers`;

const CARD_SELECTOR = [
    'div.bg-white.rounded-xl.border.border-neutral-200.p-6'
].join('');

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];
        const seen = new Set();

        meta.pagesVisited = meta.pagesVisited || 0;
        meta.listingHits = 0;
        meta.detailPagesVisited = 0;
        meta.detailParseFailures = 0;

        // Load the careers listing.
        meta.pagesVisited++;
        await loadPage(page, LISTING_URL);
        await delay(1000);

        // Check for blocking on the first page only.
        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (e) {
            // Diagnostics are best-effort.
        }

        // Collect actual job cards and their detail links.
        const listing = await page.evaluate((cardSelector) => {
            const getText = (el) =>
                el ? el.textContent.replace(/\s+/g, ' ').trim() : null;

            const cards = Array.from(
                document.querySelectorAll(cardSelector)
            );

            const entries = cards.map((card) => {
                const link = card.querySelector(
                    'a[href^="/careers/"]'
                );

                const title = getText(card.querySelector('h3'));
                const href = link ? link.getAttribute('href') : null;

                const spans = Array.from(
                    card.querySelectorAll(
                        '.flex.flex-wrap.gap-4 span'
                    )
                ).map(getText).filter(Boolean);

                return {
                    title,
                    href,
                    metadata: spans,
                    description: getText(card.querySelector('p'))
                };
            }).filter((entry) => entry.href && entry.title);

            const bodyText = document.body.innerText.toLowerCase();

            const emptyPhrases = [
                'no open positions',
                'no current openings',
                'no job openings',
                'no vacancies',
                'no any vacancy',
                'not hiring',
                'check back soon',
                'sorry, no positions available at this time'
            ];

            const emptyState = emptyPhrases.some(
                (phrase) => bodyText.includes(phrase)
            );

            const company = document.querySelector(
                'meta[property="og:site_name"]'
            )?.content || null;

            return {
                entries,
                emptyState,
                company
            };
        }, CARD_SELECTOR);

        // Empty-state handling.
        if (listing.emptyState && listing.entries.length === 0) {
            meta.atsEmpty = true;
            return { items, meta };
        }

        const entries = listing.entries.filter((entry) => {
            if (seen.has(entry.href)) return false;
            seen.add(entry.href);
            return true;
        });

        meta.listingHits = entries.length;
        safeDiscovered(progress, entries.length);

        const company = listing.company || 'Quickfox Consulting';

        // Extract structured information from each detail page.
        for (const entry of entries) {
            const url = new URL(entry.href, BASE_URL).href;

            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                await loadPage(page, url);
                await delay(500);

                const raw = await page.evaluate(() => {
                    const getText = (el) =>
                        el
                            ? el.textContent.replace(/\s+/g, ' ').trim()
                            : null;

                    const title = getText(
                        document.querySelector('h1.text-display-md')
                    );

                    const companyName =
                        document.querySelector(
                            'meta[property="og:site_name"]'
                        )?.content || null;

                    // Extract the actual role description using
                    // the About the Role heading as an anchor.
                    const headings = Array.from(
                        document.querySelectorAll(
                            'main section.section-padding h2'
                        )
                    );

                    const aboutHeading = headings.find(
                        (heading) =>
                            getText(heading)?.toLowerCase() ===
                            'about the role'
                    );

                    const requirementsHeading = headings.find(
                        (heading) =>
                            getText(heading)?.toLowerCase() ===
                            'requirements'
                    );

                    let descriptionParts = [];

                    if (aboutHeading) {
                        const aboutContent = aboutHeading.nextElementSibling;

                        if (aboutContent) {
                            const text = getText(aboutContent);
                            if (text) descriptionParts.push(text);
                        }
                    }

                    if (requirementsHeading) {
                        const requirementsList =
                            requirementsHeading.nextElementSibling;

                        if (requirementsList) {
                            const requirements = Array.from(
                                requirementsList.querySelectorAll('li')
                            )
                                .map(getText)
                                .filter(Boolean);

                            if (requirements.length) {
                                descriptionParts.push(
                                    'Requirements:\n' +
                                    requirements.map(
                                        (item) => `• ${item}`
                                    ).join('\n')
                                );
                            }
                        }
                    }

                    // Read the visible job header metadata.
                    const header = document.querySelector(
                        'main > section:first-child'
                    );

                    const headerSpans = Array.from(
                        header?.querySelectorAll(
                            '.flex.flex-wrap.gap-4 span'
                        ) || []
                    ).map(getText).filter(Boolean);

                    const summary = {};
                    const summaryLabels = Array.from(
                        document.querySelectorAll(
                            'main section.section-padding p'
                        )
                    );

                    for (const label of summaryLabels) {
                        const key = getText(label);
                        const value = getText(label.nextElementSibling);

                        if (key && value) {
                            summary[key.toLowerCase()] = value;
                        }
                    }

                    // Search detail-page text for deadline and
                    // compensation information without treating
                    // unrelated prose as field values.
                    const bodyText = document.querySelector(
                        'main'
                    )?.innerText || '';

                    const lines = bodyText
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean);

                    const findLabeledValue = (patterns) => {
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];

                            if (patterns.some((pattern) =>
                                pattern.test(line)
                            )) {
                                const inline = line.split(/[:：]/);
                                if (inline.length > 1) {
                                    const value = inline
                                        .slice(1)
                                        .join(':')
                                        .trim();

                                    if (value) return value;
                                }

                                if (lines[i + 1]) {
                                    return lines[i + 1];
                                }
                            }
                        }

                        return null;
                    };

                    const salary = findLabeledValue([
                        /^salary\s*[:：]?$/i,
                        /^compensation\s*[:：]?$/i,
                        /^pay\s*[:：]?$/i
                    ]);

                    const applicationEndsRaw = findLabeledValue([
                        /^application deadline\s*[:：]?$/i,
                        /^apply by\s*[:：]?$/i,
                        /^closing date\s*[:：]?$/i,
                        /^application ends\s*[:：]?$/i
                    ]);

                    const imageElement = document.querySelector(
                        'main img'
                    );

                    const image = imageElement
                        ? (
                            imageElement.getAttribute('src') ||
                            imageElement.getAttribute('data-src') ||
                            null
                        )
                        : null;

                    const location =
                        summary.location ||
                        headerSpans.find((value) =>
                            /nepal|lalitpur|kathmandu|kupondole|remote/i
                                .test(value)
                        ) ||
                        null;

                    const employmentType =
                        summary['job type'] ||
                        headerSpans.find((value) =>
                            /full[- ]time|part[- ]time|internship|contract/i
                                .test(value)
                        ) ||
                        null;

                    const experience =
                        summary.experience ||
                        headerSpans.find((value) =>
                            /\d+\s*[-–]\s*\d+\s*years?/i.test(value)
                        ) ||
                        null;

                    const department =
                        summary.department ||
                        headerSpans.find((value) =>
                            /engineering|architecture|data|product|business/i
                                .test(value)
                        ) ||
                        null;

                    return {
                        title,
                        company: companyName,
                        description: descriptionParts.join('\n\n'),
                        location,
                        employmentType,
                        experience,
                        department,
                        salary,
                        applicationEndsRaw,
                        image
                    };
                });

                const finalTitle = raw.title || entry.title;

                if (!finalTitle) {
                    meta.detailParseFailures++;
                    continue;
                }

                const description = raw.description
                    ? cleanDescriptionText(raw.description)
                    : null;

                const salary = raw.salary &&
                    /[\d$€£₹₨,]+/.test(raw.salary) &&
                    raw.salary.length < 60
                    ? raw.salary
                    : null;

                const image = raw.image
                    ? sanitizeImageUrl(raw.image)
                    : null;

                const item = {
                    id: `quickfoxconsulting-${entry.href.split('/').pop()}`,

                    title: finalTitle,
                    title_status: 'extracted',

                    company: raw.company || company,
                    company_status: 'extracted',

                    companyUrl: null,
                    companyLogoUrl: null,

                    location: raw.location || null,
                    location_status: raw.location
                        ? 'extracted'
                        : 'extraction_failed',
                    location_evidence: raw.location
                        ? 'Extracted from detail header or Job Summary Location.'
                        : 'Tried main header metadata and Job Summary Location.',

                    employmentType: raw.employmentType || null,
                    employmentType_status: raw.employmentType
                        ? 'extracted'
                        : 'extraction_failed',
                    employmentType_evidence:
                        'Tried Job Summary Job Type and header metadata spans.',

                    attendanceMode: raw.location &&
                        /remote/i.test(raw.location)
                        ? 'Remote'
                        : null,

                    salary,
                    salary_status: salary
                        ? 'extracted'
                        : 'site_absent',
                    salary_evidence:
                        'Searched detail-page Salary, Compensation and Pay labels.',

                    experience: raw.experience || null,
                    level: null,
                    openings: null,

                    description: description || null,
                    description_status: description
                        ? 'extracted'
                        : 'extraction_failed',
                    description_evidence:
                        'Extracted About the Role and Requirements sections.',

                    responsibilities: '',
                    requirements: '',
                    skills: [],

                    companyDescription: null,
                    companyLocation: null,
                    companyAddress: null,

                    applicationEndsRaw: raw.applicationEndsRaw || null,
                    applicationEndsRaw_status: raw.applicationEndsRaw
                        ? 'extracted'
                        : 'site_absent',
                    applicationEndsRaw_evidence:
                        'Searched Application Deadline, Apply By, Closing Date and Application Ends labels.',

                    image: image || null,
                    image_status: image
                        ? 'extracted'
                        : 'site_absent',
                    image_evidence:
                        'Searched main img elements on the detail page.',

                    category: raw.department || null,
                    tags: [],

                    url,
                    registrationUrl: url,

                    source: 'quickfoxconsulting',
                    scrapedAt: Date.now()
                };

                items.push(item);
            } catch (error) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(
            '  [quickfoxconsulting] extracted ' + items.length
        );

        return { items, meta };
    }
};