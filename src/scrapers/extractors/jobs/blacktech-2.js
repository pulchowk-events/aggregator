const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const {
    cleanDescriptionText,
    trimDescriptionToLastSentence
} = require('../../text');
const { sanitizeJobFields } = require('../../jobs');

const BASE_URL = 'https://www.blacktech.com.np';
const LISTING_URL = `${BASE_URL}/career`;
const SOURCE = 'blacktech-2';

async function harvestListing(page) {
    return page.evaluate(() => {
        const clean = (value) =>
            value ? value.replace(/\s+/g, ' ').trim() : null;

        const anchors = Array.from(
            document.querySelectorAll('a[href*="/career/"]')
        );

        const entries = new Map();

        for (const anchor of anchors) {
            const href = anchor.getAttribute('href');
            if (!href || !/^\/career\/[a-z0-9-]+\/?$/i.test(href)) {
                continue;
            }

            const card = anchor;
            const text = clean(card.innerText || card.textContent);
            if (!text) continue;

            const titleEl = card.querySelector(
                'p.text-white\\/80.font-medium'
            );

            const title = clean(titleEl?.textContent);
            if (!title) continue;

            const lines = Array.from(
                card.querySelectorAll('ul li')
            ).map((el) => clean(el.textContent)).filter(Boolean);

            const findLine = (pattern) =>
                lines.find((line) => pattern.test(line)) || null;

            entries.set(href, {
                href,
                title,
                cardText: text,
                location: findLine(/onsite|remote|hybrid/i),
                employmentType: findLine(
                    /full[\s-]*time|part[\s-]*time|contract|internship/i
                ),
                experience: findLine(/\b\d+\s*\+?\s*(years?|yrs?|months?)\b/i),
                openings: findLine(/\b\d+\s*[-–]?\s*openings?\b/i),
                deadline: (() => {
                    const line = findLine(/deadline/i);
                    return line ? line.replace(/^deadline\s*:\s*/i, '') : null;
                })()
            });
        }

        return Array.from(entries.values());
    });
}

async function scrapeDetail(page) {
    return page.evaluate(() => {
        const clean = (value) =>
            value ? value.replace(/\s+/g, ' ').trim() : null;

        const titleEl = document.querySelector(
            'h2.primary-gradient-text'
        );

        const title = clean(titleEl?.textContent);

        const bodyText = document.body?.innerText || '';

        const getMeta = (name) =>
            document.querySelector(`meta[property="${name}"]`)
                ?.getAttribute('content') || null;

        const getLabelValue = (patterns) => {
            const elements = Array.from(
                document.querySelectorAll('p, span, li, div, strong, dt, dd')
            );

            for (const el of elements) {
                if (el.children.length > 3) continue;

                const text = clean(el.textContent);
                if (!text || text.length > 180) continue;

                for (const pattern of patterns) {
                    const match = text.match(pattern);
                    if (match && match[1]) {
                        return clean(match[1]);
                    }
                }
            }

            return null;
        };

        const location = getLabelValue([
            /^(?:location|job location)\s*:\s*(.+)$/i
        ]);

        const salary = getLabelValue([
            /^(?:salary|compensation|pay)\s*:\s*(.+)$/i
        ]);

        const employmentType = getLabelValue([
            /^(?:employment type|job type)\s*:\s*(.+)$/i
        ]);

        const deadline = getLabelValue([
            /^(?:deadline|application deadline|apply before|closing date)\s*:\s*(.+)$/i
        ]);

        const descriptionCandidates = [];

        if (titleEl) {
            let current = titleEl.parentElement;

            for (let depth = 0; current && depth < 7; depth++) {
                const clone = current.cloneNode(true);

                clone.querySelectorAll(
                    'header, footer, nav, script, style, svg, button, a'
                ).forEach((el) => el.remove());

                const text = clean(clone.innerText || clone.textContent);

                if (
                    text &&
                    text.length >= 150 &&
                    text.length <= 5000 &&
                    !descriptionCandidates.some((item) => item.text === text)
                ) {
                    descriptionCandidates.push({
                        text,
                        length: text.length
                    });
                }

                current = current.parentElement;
            }
        }

        let description = null;

        if (descriptionCandidates.length) {
            descriptionCandidates.sort((a, b) => b.length - a.length);

            description = descriptionCandidates[0].text;

            if (title && description.startsWith(title)) {
                description = description.slice(title.length).trim();
            }

            if (description.length < 100) {
                description = null;
            }
        }

        return {
            title,
            ogTitle: getMeta('og:title'),
            location,
            salary,
            employmentType,
            deadline,
            description,
            bodyText: clean(bodyText),
            image: null
        };
    });
}

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

        try {
            meta.pagesVisited++;
            await loadPage(page, LISTING_URL);
            await delay(1000);

            try {
                const state = await detectPageState(page);

                if (state.looksBlocked) {
                    meta.looksBlocked = true;
                    return { items, meta };
                }
            } catch (_) {
                // Page-state detection is best-effort.
            }

            const listingState = await page.evaluate(() => {
                const text = (document.body?.innerText || '')
                    .toLowerCase();

                const emptyPatterns = [
                    'no open positions',
                    'no current openings',
                    'no job openings',
                    'no vacancies',
                    'no any vacancy',
                    'not hiring',
                    'check back soon',
                    'sorry, no positions available at this time'
                ];

                return {
                    empty: emptyPatterns.some((phrase) =>
                        text.includes(phrase)
                    ),
                    hasJobLinks: Array.from(
                        document.querySelectorAll('a[href*="/career/"]')
                    ).some((a) =>
                        /^\/career\/[a-z0-9-]+\/?$/i.test(
                            a.getAttribute('href') || ''
                        )
                    )
                };
            });

            if (listingState.empty && !listingState.hasJobLinks) {
                meta.atsEmpty = true;
                return { items, meta };
            }

            const entries = await harvestListing(page);

            meta.listingHits = entries.length;
            safeDiscovered(progress, entries.length);

            if (!entries.length) {
                return { items, meta };
            }

            for (const entry of entries) {
                const url = new URL(entry.href, BASE_URL).href;

                if (seen.has(url)) {
                    safeUnitDone(progress);
                    continue;
                }

                seen.add(url);

                try {
                    meta.pagesVisited++;
                    meta.detailPagesVisited++;

                    await loadPage(page, url);
                    await delay(500);

                    const raw = await scrapeDetail(page);

                    const title = raw.title || entry.title;

                    if (!title) {
                        meta.detailParseFailures++;
                        continue;
                    }

                    let description = raw.description || null;

                    if (description) {
                        description = cleanDescriptionText(description);
                        description = trimDescriptionToLastSentence(
                            description
                        );
                    }

                    const company = 'Black Tech';

                    const resolvedLocation = raw.location || null;

                    const resolvedEmploymentType =
                        raw.employmentType ||
                        entry.employmentType ||
                        null;

                    const applicationEndsRaw =
                        raw.deadline ||
                        entry.deadline ||
                        null;

                    const salary = raw.salary || null;

                    const finalJob = {
                        id: `blacktech-${url.split('/').pop()}`,

                        title,
                        company,
                        companyUrl: BASE_URL,
                        companyLogoUrl: null,

                        location: resolvedLocation,
                        employmentType: resolvedEmploymentType,

                        attendanceMode:
                            entry.location &&
                            /remote/i.test(entry.location)
                                ? 'Remote'
                                : entry.location &&
                                  /hybrid/i.test(entry.location)
                                    ? 'Hybrid'
                                    : entry.location &&
                                      /onsite/i.test(entry.location)
                                        ? 'Onsite'
                                        : null,

                        salary,

                        experience: entry.experience || null,
                        level: (() => {
                            const match = entry.cardText.match(
                                /\b(entry|junior|mid|mid level|senior|lead)\b/i
                            );
                            return match ? match[0] : null;
                        })(),

                        openings: entry.openings || null,

                        description,
                        responsibilities: '',
                        requirements: '',
                        skills: [],

                        companyDescription: null,
                        companyLocation: null,
                        companyAddress: null,

                        applicationEndsRaw,
                        applicationEndsDate: null,

                        image: raw.image,
                        url,
                        registrationUrl: url,

                        source: SOURCE,
                        scrapedAt: Date.now(),

                        title_status: 'extracted',
                        company_status: 'extracted',
                        url_status: 'extracted',

                        location_status: resolvedLocation
                            ? 'extracted'
                            : 'site_absent',
                        location_evidence: resolvedLocation
                            ? 'Extracted from labeled location field on detail page.'
                            : 'Checked labeled location fields on detail page; listing only provides work mode (Onsite), not a physical location.',

                        description_status: description
                            ? 'extracted'
                            : 'site_absent',
                        description_evidence: description
                            ? 'Extracted from the detail-page content surrounding h2.primary-gradient-text.'
                            : 'Checked detail-page content surrounding h2.primary-gradient-text; no usable role description found.',

                        employmentType_status: resolvedEmploymentType
                            ? 'extracted'
                            : 'site_absent',
                        employmentType_evidence: resolvedEmploymentType
                            ? 'Extracted from the listing card or labeled detail-page field.'
                            : 'Checked listing-card metadata and labeled employment type fields on the detail page.',

                        applicationEndsRaw_status: applicationEndsRaw
                            ? 'extracted'
                            : 'site_absent',
                        applicationEndsRaw_evidence: applicationEndsRaw
                            ? 'Extracted from the listing card Deadline field or detail page.'
                            : 'Checked listing-card Deadline metadata and detail-page deadline labels.',

                        image_status: 'site_absent',
                        image_evidence: 'No per-job image was found in the listing or sample detail-page evidence.',

                        salary_status: salary
                            ? 'extracted'
                            : 'site_absent',
                        salary_evidence: salary
                            ? 'Extracted from the labeled salary field on the detail page.'
                            : 'Checked labeled salary, compensation and pay fields on the detail page.',

                        company_evidence:
                            'Employer identified from the site title "Black Tech." and the blacktech.com.np domain.'
                    };

                    sanitizeJobFields(finalJob);

                    items.push(finalJob);
                } catch (_) {
                    meta.detailParseFailures++;
                } finally {
                    safeUnitDone(progress);
                }
            }
        } catch (_) {
            // Preserve successfully extracted items if a page fails.
        }

        console.log(
            '  [blacktech-2] extracted ' + items.length
        );

        return { items, meta };
    }
};