// VERDICT: CAREERS_PAGE
//
// Site type: listing-to-detail
// Card wrapper: div > div.relative > a.group[href^="/career/"]
// Detail links: /career/<uuid>
// Detail title: h2.primary-gradient-text
// Description: Extracted from the role-specific content around the detail title.
// Company: Black Tech Pvt. Ltd. (supported by the site's domain and logo context).

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { sanitizeJobFields } = require('../../jobs');

const BASE_URL = 'https://www.blacktech.com.np';
const LISTING_URL = `${BASE_URL}/career`;
const SOURCE = 'blacktech-2';

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];
        const seen = new Set();

        meta.atsEmpty = false;

        try {
            meta.pagesVisited++;
            await loadPage(page, LISTING_URL, { timeout: 60000 });
            await delay(1200);

            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                meta.listingHits = 0;
                return { items, meta };
            }

            const listingData = await page.evaluate(() => {
                const normalize = (value) =>
                    (value || '').replace(/\s+/g, ' ').trim();

                const bodyText = normalize(document.body.innerText);
                const emptyPatterns = [
                    /no open positions/i,
                    /no current openings/i,
                    /no job openings/i,
                    /no vacancies/i,
                    /no any vacancy/i,
                    /always hiring/i,
                    /always on the lookout/i,
                    /not hiring/i,
                    /check back soon/i,
                    /there are no (open|current)/i,
                    /sorry, no positions available at this time/i
                ];

                const cards = Array.from(
                    document.querySelectorAll('a.group[href^="/career/"]')
                );

                const entries = cards.map((card) => {
                    const title = normalize(
                        card.querySelector('p.text-2xl')?.textContent
                    );

                    const rows = Array.from(card.querySelectorAll('ul li'))
                        .map((li) => normalize(li.textContent))
                        .filter(Boolean);

                    const href = card.getAttribute('href');

                    return {
                        title,
                        href,
                        metadata: rows
                    };
                }).filter((entry) => entry.href && entry.title);

                return {
                    entries,
                    emptyState: emptyPatterns.some((pattern) =>
                        pattern.test(bodyText)
                    )
                };
            });

            if (listingData.emptyState && !listingData.entries.length) {
                meta.atsEmpty = true;
                meta.listingHits = 0;
                return { items, meta };
            }

            const entries = listingData.entries.filter((entry) => {
                if (seen.has(entry.href)) return false;
                seen.add(entry.href);
                return true;
            });

            meta.listingHits = entries.length;
            safeDiscovered(progress, entries.length);

            for (const entry of entries) {
                const url = new URL(entry.href, BASE_URL).href;

                try {
                    meta.pagesVisited++;
                    meta.detailPagesVisited++;

                    await loadPage(page, url, { timeout: 60000 });
                    await delay(700);

                    const raw = await page.evaluate(() => {
                        const normalize = (value) =>
                            (value || '').replace(/\s+/g, ' ').trim();

                        const text = (element) =>
                            element ? normalize(element.textContent) : null;

                        const titleEl = document.querySelector(
                            'h2.primary-gradient-text'
                        );

                        const title = text(titleEl);

                        // Find the role content without capturing the page chrome.
                        // The nearest substantial content ancestor is preferred.
                        let roleContainer = titleEl?.parentElement || null;
                        let bestContainer = null;
                        let bestLength = 0;

                        for (let depth = 0; roleContainer && depth < 7; depth++) {
                            const content = normalize(
                                roleContainer.innerText
                            );

                            if (
                                content.length > bestLength &&
                                content.length > 100 &&
                                !roleContainer.classList.contains('fixed')
                            ) {
                                bestContainer = roleContainer;
                                bestLength = content.length;
                            }

                            roleContainer = roleContainer.parentElement;
                        }

                        const container = bestContainer ||
                            titleEl?.parentElement ||
                            document.querySelector('main') ||
                            document.body;

                        const fullText = container.innerText || '';

                        const lines = fullText
                            .split('\n')
                            .map(normalize)
                            .filter(Boolean);

                        const excluded = [
                            /^home$/i,
                            /^company$/i,
                            /^career$/i,
                            /^contact us$/i,
                            /^apply now$/i,
                            /^black tech$/i
                        ];

                        const contentLines = lines.filter((line) =>
                            !excluded.some((pattern) => pattern.test(line))
                        );

                        const description = contentLines
                            .filter((line) => line !== title)
                            .join('\n')
                            .trim();

                        const locationMatch = lines.find((line) =>
                            /^(location|job location|work location)\s*:/i
                                .test(line)
                        );

                        const salaryMatch = lines.find((line) =>
                            /^(salary|compensation|pay|remuneration)\s*:/i
                                .test(line)
                        );

                        const deadlineMatch = lines.find((line) =>
                            /^(deadline|application deadline|apply before|last date)\s*:/i
                                .test(line)
                        );

                        const employmentMatch = lines.find((line) =>
                            /\b(full[ -]?time|part[ -]?time|contract|internship)\b/i
                                .test(line)
                        );

                        const experienceMatch = lines.find((line) =>
                            /\b\d+\s*\+?\s*years?\b/i.test(line)
                        );

                        const openingsMatch = lines.find((line) =>
                            /\b\d+\s*[-]?\s*openings?\b/i.test(line)
                        );

                        const applyLink = Array.from(
                            container.querySelectorAll('a[href]')
                        ).find((anchor) =>
                            /apply|application|jobs@blacktech/i.test(
                                normalize(anchor.textContent) + ' ' +
                                (anchor.getAttribute('href') || '')
                            )
                        );

                        const cleanValue = (value) => {
                            if (!value) return null;
                            return value.replace(/^[^:]+:\s*/, '').trim() || null;
                        };

                        const shortPlace = cleanValue(locationMatch);
                        const shortSalary = cleanValue(salaryMatch);

                        const logo = document.querySelector(
                            'header img[alt="Logo"]'
                        );

                        return {
                            title,
                            description,
                            location: shortPlace,
                            salary: shortSalary,
                            deadline: cleanValue(deadlineMatch),
                            employmentType: cleanValue(employmentMatch),
                            experience: cleanValue(experienceMatch),
                            openings: cleanValue(openingsMatch),
                            applyUrl: applyLink?.getAttribute('href') || null,
                            logoUrl: logo?.getAttribute('src') || null,
                            roleText: fullText
                        };
                    });

                    const title = raw.title || entry.title;

                    if (!title) {
                        meta.detailParseFailures++;
                        continue;
                    }

                    const company = 'Black Tech Pvt. Ltd.';

                    const normalizeAbsolute = (value) => {
                        if (!value) return null;
                        try {
                            return new URL(value, BASE_URL).href;
                        } catch {
                            return null;
                        }
                    };

                    const description = raw.description &&
                        raw.description.length > 40
                        ? raw.description
                        : null;

                    const location = raw.location &&
                        raw.location.length < 80
                        ? raw.location
                        : (
                            entry.metadata.find((value) =>
                                /onsite|remote|hybrid/i.test(value)
                            ) || null
                        );

                    const salary = raw.salary &&
                        raw.salary.length < 60 &&
                        /\d|rs\.?|npr|[$]/i.test(raw.salary)
                        ? raw.salary
                        : null;

                    const applicationEndsRaw = raw.deadline || (
                        entry.metadata.find((value) =>
                            /deadline:/i.test(value)
                        ) || null
                    );

                    const employmentType = raw.employmentType ||
                        entry.metadata.find((value) =>
                            /full[ -]?time|part[ -]?time|contract|internship/i
                                .test(value)
                        ) || null;

                    const job = {
                        id: `blacktech-2-${entry.href.split('/').pop()}`,
                        title,
                        company,
                        companyUrl: BASE_URL,
                        companyLogoUrl: normalizeAbsolute(raw.logoUrl),
                        description,
                        location,
                        employmentType,
                        attendanceMode: location &&
                            /remote/i.test(location)
                            ? 'Remote'
                            : location && /onsite/i.test(location)
                                ? 'Onsite'
                                : null,
                        salary,
                        experience: raw.experience || null,
                        level: entry.metadata.find((value) =>
                            /entry|junior|mid|senior|lead/i.test(value)
                        ) || null,
                        openings: raw.openings || null,
                        responsibilities: null,
                        requirements: null,
                        skills: [],
                        applicationEndsRaw,
                        applicationEndsDate: null,
                        publishedAt: null,
                        companyDescription: null,
                        companyLocation: null,
                        companyAddress: null,
                        url,
                        registrationUrl: normalizeAbsolute(raw.applyUrl) || url,
                        date: null,
                        time: null,
                        price: null,
                        organizer: company,
                        category: 'Jobs',
                        tags: [],
                        image: null,
                        source: SOURCE,

                        title_status: 'extracted',
                        company_status: 'extracted',
                        company_evidence:
                            'Black Tech branding and company identity on the official domain.',
                        url_status: 'extracted',
                        location_status: location
                            ? 'extracted'
                            : 'site_absent',
                        location_evidence: location
                            ? 'Extracted from role metadata or listing card.'
                            : 'Checked role detail text and listing metadata for location.',
                        description_status: description
                            ? 'extracted'
                            : 'extraction_failed',
                        description_evidence:
                            'Inspected the detail title ancestor and surrounding role content.',
                        employmentType_status: employmentType
                            ? 'extracted'
                            : 'site_absent',
                        employmentType_evidence:
                            'Checked detail text and listing card metadata.',
                        applicationEndsRaw_status: applicationEndsRaw
                            ? 'extracted'
                            : 'site_absent',
                        applicationEndsRaw_evidence:
                            'Checked deadline metadata on listing card and detail page.',
                        image_status: 'site_absent',
                        image_evidence:
                            'No per-role image found on the detail page.',
                        salary_status: salary
                            ? 'extracted'
                            : 'site_absent',
                        salary_evidence:
                            'Checked salary and compensation labels in role content.'
                    };

                    sanitizeJobFields(job);
                    items.push(job);
                } catch {
                    meta.detailParseFailures++;
                } finally {
                    safeUnitDone(progress);
                }
            }
        } catch (error) {
            console.error('[blacktech-2] extraction error:', error.message);
        }

        console.log('  [blacktech-2] extracted ' + items.length);
        return { items, meta };
    }
};