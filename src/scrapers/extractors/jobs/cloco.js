module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const { delay, loadPage } = require('../../page');
        const { safeDiscovered, safeUnitDone } = require('../../progress');
        const { detectPageState } = require('../../diagnostics');

        const BASE_URL = 'https://cloco.com.np';
        const LISTING_URL = `${BASE_URL}/careers`;

        const items = [];

        meta.pagesVisited++;

        await loadPage(page, LISTING_URL, { timeout: 60000 });
        await delay(1500);

        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (_) {
            // Best-effort diagnostics.
        }

        const listing = await page.evaluate(() => {
            const clean = (el) => el
                ? (el.innerText || el.textContent || '')
                    .replace(/\s+/g, ' ')
                    .trim()
                : null;

            const body = clean(document.body) || '';
            const openingSection = Array.from(
                document.querySelectorAll('h2')
            ).find((el) => /current openings/i.test(clean(el)));

            const section = openingSection?.parentElement?.parentElement;

            const cards = section
                ? Array.from(section.querySelectorAll('a[href]'))
                    .filter((a) => {
                        const href = a.getAttribute('href') || '';
                        const text = clean(a);
                        return text &&
                            href &&
                            !href.startsWith('#') &&
                            !/^(tel:|mailto:|javascript:)/i.test(href);
                    })
                : [];

            const emptyPatterns = [
                /no open positions/i,
                /no current openings/i,
                /no job openings/i,
                /no vacancies/i,
                /not hiring/i,
                /check back soon/i,
                /there are no current/i,
                /sorry, no positions available/i
            ];

            const empty = emptyPatterns.some((pattern) =>
                pattern.test(body)
            );

            const company =
                document.querySelector('meta[property="og:site:name"]')
                    ?.content?.trim() ||
                clean(document.querySelector('header a[href="/"]'))
                    ?.replace(/^home$/i, '') ||
                'Cloco Nepal';

            return {
                body,
                empty,
                company,
                links: cards.map((a) => ({
                    href: a.getAttribute('href'),
                    text: clean(a)
                }))
            };
        });

        if (listing.empty && listing.links.length === 0) {
            meta.atsEmpty = true;
            meta.listingHits = 0;
            return { items, meta };
        }

        // The apparent six links in the wizard dump are navigation links,
        // not job-detail routes. The actual Current Openings section
        // must be inspected independently.
        const validLinks = listing.links.filter((entry) => {
            try {
                const url = new URL(entry.href, BASE_URL);
                return url.origin === BASE_URL &&
                    url.pathname !== '/careers' &&
                    url.pathname !== '/' &&
                    ![
                        '/about',
                        '/services',
                        '/blog',
                        '/contact',
                        '/gallery',
                        '/internship',
                        '/fellowship'
                    ].includes(url.pathname);
            } catch (_) {
                return false;
            }
        });

        const uniqueLinks = Array.from(
            new Map(
                validLinks.map((entry) => [
                    new URL(entry.href, BASE_URL).href,
                    entry
                ])
            ).entries()
        );

        meta.listingHits = uniqueLinks.length;
        safeDiscovered(progress, uniqueLinks.length);

        // No verified per-job detail routes exist in the supplied evidence.
        // Do not turn marketing content or navigation links into job records.
        if (uniqueLinks.length === 0) {
            const hasRoleCards = await page.evaluate(() => {
                const section = Array.from(
                    document.querySelectorAll('h2')
                ).find((el) =>
                    /current openings/i.test(el.textContent || '')
                )?.parentElement?.parentElement;

                if (!section) return false;

                return Array.from(
                    section.querySelectorAll('h1, h2, h3, h4, a, button')
                ).some((el) => {
                    const text = (el.innerText || el.textContent || '')
                        .replace(/\s+/g, ' ')
                        .trim();

                    return text.length > 3 &&
                        !/current openings|discover your next career/i.test(
                            text
                        );
                });
            });

            if (!hasRoleCards && listing.empty) {
                meta.atsEmpty = true;
            }

            console.log(
                '  [cloco] extracted 0; no verified job-detail routes'
            );

            return { items, meta };
        }

        // A future site update may expose genuine detail routes.
        for (const [url] of uniqueLinks) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                await loadPage(page, url, { timeout: 60000 });
                await delay(800);

                const raw = await page.evaluate(() => {
                    const clean = (el) => el
                        ? (el.innerText || el.textContent || '')
                            .replace(/\s+/g, ' ')
                            .trim()
                        : null;

                    const title = clean(
                        document.querySelector('h1.typing')
                    );

                    const descriptionSelectors = [
                        '[class*="job-description"]',
                        '[class*="role-body"]',
                        '[class*="job-detail"]',
                        'article'
                    ];

                    let description = null;

                    for (const selector of descriptionSelectors) {
                        const elements = Array.from(
                            document.querySelectorAll(selector)
                        );

                        const candidate = elements
                            .map(clean)
                            .filter((text) => text && text.length > 50)
                            .sort((a, b) => b.length - a.length)[0];

                        if (candidate) {
                            description = candidate;
                            break;
                        }
                    }

                    const text = clean(document.body) || '';

                    const findField = (patterns) => {
                        for (const pattern of patterns) {
                            const match = text.match(pattern);
                            if (match?.[1]) return match[1].trim();
                        }
                        return null;
                    };

                    const location = findField([
                        /Location\s*[:\-]\s*([^\n,]{2,70})/i,
                        /Job Location\s*[:\-]\s*([^\n,]{2,70})/i
                    ]);

                    const salary = findField([
                        /Salary\s*[:\-]\s*([^\n]{1,55})/i,
                        /Compensation\s*[:\-]\s*([^\n]{1,55})/i
                    ]);

                    const employmentType = findField([
                        /Employment Type\s*[:\-]\s*([^\n]{1,50})/i,
                        /Job Type\s*[:\-]\s*([^\n]{1,50})/i
                    ]);

                    const applicationEndsRaw = findField([
                        /Apply By\s*[:\-]\s*([^\n]{1,50})/i,
                        /Deadline\s*[:\-]\s*([^\n]{1,50})/i,
                        /Closing Date\s*[:\-]\s*([^\n]{1,50})/i
                    ]);

                    return {
                        title,
                        description,
                        location,
                        salary,
                        employmentType,
                        applicationEndsRaw,
                        company: 'Cloco Nepal'
                    };
                });

                if (!raw.title) {
                    meta.detailParseFailures++;
                    continue;
                }

                const fieldStatus = (value, evidence) => ({
                    status: value ? 'extracted' : 'site_absent',
                    evidence
                });

                const item = {
                    id: `cloco-${Buffer.from(url).toString('base64url')}`,
                    title: raw.title,
                    company: raw.company,
                    company_status: 'extracted',
                    company_evidence: 'og:site:name and site branding identify Cloco Nepal.',
                    url,
                    location: raw.location || null,
                    location_status: fieldStatus(
                        raw.location,
                        'Checked location and job-location labels in the detail page body.'
                    ).status,
                    location_evidence: 'Checked location and job-location labels in the detail page body.',
                    description: raw.description || null,
                    description_status: raw.description
                        ? 'extracted'
                        : 'site_absent',
                    description_evidence: 'Checked job-description, role-body, job-detail and article selectors.',
                    employmentType: raw.employmentType || null,
                    employmentType_status: raw.employmentType
                        ? 'extracted'
                        : 'site_absent',
                    employmentType_evidence: 'Checked employment-type and job-type labels.',
                    applicationEndsRaw: raw.applicationEndsRaw || null,
                    applicationEndsRaw_status: raw.applicationEndsRaw
                        ? 'extracted'
                        : 'site_absent',
                    applicationEndsRaw_evidence: 'Checked apply-by, deadline and closing-date labels.',
                    salary: raw.salary || null,
                    salary_status: raw.salary
                        ? 'extracted'
                        : 'site_absent',
                    salary_evidence: 'Checked salary and compensation labels.',
                    experience: null,
                    level: null,
                    openings: null,
                    responsibilities: null,
                    requirements: null,
                    skills: [],
                    image: null,
                    companyUrl: BASE_URL,
                    companyLogoUrl: null,
                    companyDescription: null,
                    companyLocation: null,
                    companyAddress: null,
                    registrationUrl: url,
                    attendanceMode: raw.location &&
                        /remote/i.test(raw.location)
                        ? 'Remote'
                        : null,
                    source: 'cloco',
                    scrapedAt: Date.now()
                };

                items.push(item);
            } catch (_) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log('  [cloco] extracted ' + items.length);

        return { items, meta };
    }
};