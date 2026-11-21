module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];
        const seen = new Set();

        const normalizeUrl = (href, base) => {
            if (!href) return null;
            try {
                return new URL(href, base).href;
            } catch {
                return null;
            }
        };

        const getText = (el) =>
            el ? el.textContent.replace(/\s+/g, ' ').trim() : null;

        const extractBoard = async () => {
            return page.evaluate(() => {
                const text = (el) =>
                    el ? (el.innerText || el.textContent || '')
                        .replace(/\s+/g, ' ').trim() : '';

                const absolute = (href) => {
                    try {
                        return new URL(href, location.href).href;
                    } catch {
                        return null;
                    }
                };

                const jobs = [];
                const seenUrls = new Set();

                // Prefer authoritative JobPosting structured data.
                document.querySelectorAll(
                    'script[type="application/ld+json"]'
                ).forEach((script) => {
                    try {
                        const parsed = JSON.parse(script.textContent);
                        const nodes = Array.isArray(parsed)
                            ? parsed
                            : [parsed];

                        const visit = (node) => {
                            if (!node || typeof node !== 'object') return;

                            if (Array.isArray(node)) {
                                node.forEach(visit);
                                return;
                            }

                            const type = node['@type'];
                            if (
                                type === 'JobPosting' ||
                                (Array.isArray(type) &&
                                    type.includes('JobPosting'))
                            ) {
                                jobs.push({
                                    jsonLd: node,
                                    href: node.url || node['@id'] || null,
                                    title: node.title || null,
                                    text: node.description || ''
                                });
                            }

                            if (node['@graph']) visit(node['@graph']);
                        };

                        visit(parsed);
                    } catch {
                        // Ignore malformed structured data.
                    }
                });

                // Discover actual job links, not generic navigation links.
                const anchors = Array.from(
                    document.querySelectorAll('a[href]')
                );

                for (const anchor of anchors) {
                    const href = absolute(anchor.getAttribute('href'));
                    const title = text(anchor);

                    if (!href || !title || title.length < 4) continue;
                    if (/^(view|apply|read more|learn more|know more)$/i.test(
                        title
                    )) continue;

                    if (
                        /\/(about|contact|leadership|careers|home|blog)(\/|$)/i
                        .test(new URL(href).pathname)
                    ) continue;

                    const parent = anchor.closest(
                        'article, li, [class*="job"], [class*="career"], ' +
                        '[class*="opening"], [class*="position"], ' +
                        '[class*="vacancy"]'
                    );

                    const card = parent || anchor.parentElement;
                    const cardText = text(card);

                    if (!cardText || cardText.length < 10) continue;
                    if (seenUrls.has(href)) continue;

                    seenUrls.add(href);

                    jobs.push({
                        href,
                        title,
                        text: cardText,
                        cardHtml: card ? card.innerHTML : ''
                    });
                }

                // Also inspect semantic job cards without detail links.
                const cardSelectors = [
                    'article',
                    '[class*="job-card"]',
                    '[class*="career-card"]',
                    '[class*="opening-card"]',
                    '[class*="position-card"]',
                    '[class*="job-listing"]',
                    '[class*="vacancy-card"]'
                ];

                for (const selector of cardSelectors) {
                    document.querySelectorAll(selector).forEach((card) => {
                        const cardText = text(card);
                        if (!cardText || cardText.length < 25) return;

                        const heading = card.querySelector(
                            'h1, h2, h3, h4, [class*="title"]'
                        );

                        const title = text(heading);
                        if (!title || title.length < 4) return;

                        const link = card.querySelector('a[href]');
                        const href = link
                            ? absolute(link.getAttribute('href'))
                            : null;

                        const key = href || `card:${title}:${cardText.length}`;
                        if (seenUrls.has(key)) return;

                        seenUrls.add(key);

                        jobs.push({
                            href,
                            title,
                            text: cardText,
                            cardHtml: card.innerHTML
                        });
                    });
                }

                return {
                    jobs,
                    bodyText: text(document.body),
                    pageTitle: document.title,
                    canonical: document.querySelector(
                        'link[rel="canonical"]'
                    )?.href || null
                };
            });
        };

        const extractDetail = async (fallback) => {
            return page.evaluate((fallbackData) => {
                const text = (el) =>
                    el ? (el.innerText || el.textContent || '')
                        .replace(/\s+/g, ' ').trim() : null;

                const clean = (value) => {
                    if (!value) return null;
                    return value.replace(/\s+/g, ' ').trim() || null;
                };

                const metaContent = (selector) =>
                    clean(document.querySelector(selector)?.content);

                const jsonLdJobs = [];

                document.querySelectorAll(
                    'script[type="application/ld+json"]'
                ).forEach((script) => {
                    try {
                        const parsed = JSON.parse(script.textContent);
                        const visit = (node) => {
                            if (!node || typeof node !== 'object') return;
                            if (Array.isArray(node)) {
                                node.forEach(visit);
                                return;
                            }

                            const type = node['@type'];
                            if (
                                type === 'JobPosting' ||
                                (Array.isArray(type) &&
                                    type.includes('JobPosting'))
                            ) {
                                jsonLdJobs.push(node);
                            }

                            if (node['@graph']) visit(node['@graph']);
                        };
                        visit(parsed);
                    } catch {
                        // Ignore invalid JSON-LD.
                    }
                });

                const structured = jsonLdJobs[0] || {};

                const heading = document.querySelector(
                    'h1, [class*="job-title"], [class*="position-title"]'
                );

                const title =
                    clean(structured.title) ||
                    text(heading) ||
                    fallbackData.title;

                const bodyCandidates = [
                    '[class*="job-description"]',
                    '[class*="description"]',
                    '[class*="job-detail"]',
                    '[class*="job-content"]',
                    '[class*="role-description"]',
                    'article',
                    'main'
                ];

                let description = null;

                for (const selector of bodyCandidates) {
                    const elements = Array.from(
                        document.querySelectorAll(selector)
                    );

                    const candidate = elements
                        .map((el) => text(el))
                        .filter((value) => value && value.length > 80)
                        .sort((a, b) => b.length - a.length)[0];

                    if (candidate) {
                        description = candidate;
                        break;
                    }
                }

                if (!description) {
                    description = fallbackData.text || null;
                }

                const body = text(document.body) || '';

                const findLabel = (labels) => {
                    for (const label of labels) {
                        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g,
                            '\\$&');

                        const match = body.match(
                            new RegExp(
                                escaped + '\\s*[:\\-]?\\s*' +
                                '([^|\\n]{2,100})',
                                'i'
                            )
                        );

                        if (match && match[1]) {
                            const value = clean(match[1]);
                            if (value && value.length < 100) return value;
                        }
                    }
                    return null;
                };

                const locationObject = structured.jobLocation;
                let location = null;

                if (locationObject) {
                    const loc = Array.isArray(locationObject)
                        ? locationObject[0]
                        : locationObject;

                    const address = loc?.address;
                    if (typeof address === 'string') {
                        location = clean(address);
                    } else if (address) {
                        location = [
                            address.addressLocality,
                            address.addressRegion,
                            address.addressCountry?.name ||
                                address.addressCountry
                        ].filter(Boolean).join(', ');
                    }
                }

                location = location ||
                    findLabel(['Location', 'Job Location', 'Work Location']);

                if (location && location.length > 80) location = null;

                const salaryObject = structured.baseSalary;
                let salary = null;

                if (salaryObject) {
                    const value = salaryObject.value || salaryObject;
                    salary = [
                        value.currency,
                        value.value || value.minValue
                    ].filter(Boolean).join(' ');
                }

                if (!salary) {
                    const salaryMatch = body.match(
                        /(?:salary|compensation|pay)\s*[:\-]?\s*([$£€]?\s*[\d,]+(?:\.\d+)?(?:\s*[-–to]+\s*[$£€]?\s*[\d,]+)?\s*(?:USD|GBP|EUR|NPR|per annum|annually|monthly|\/month|\/year)?)/i
                    );
                    salary = salaryMatch ? clean(salaryMatch[1]) : null;
                }

                if (salary && salary.length > 60) salary = null;

                const employmentType = Array.isArray(
                    structured.employmentType
                )
                    ? structured.employmentType.join(', ')
                    : clean(structured.employmentType) ||
                        findLabel(['Employment Type', 'Job Type']);

                const deadline =
                    clean(structured.validThrough) ||
                    findLabel([
                        'Application Deadline',
                        'Apply Before',
                        'Closing Date',
                        'Deadline'
                    ]);

                const imageEl = document.querySelector(
                    'main img[src], article img[src]'
                );

                const image = imageEl
                    ? imageEl.getAttribute('src')
                    : metaContent('meta[property="og:image"]');

                const company =
                    clean(structured.hiringOrganization?.name) ||
                    clean(document.querySelector(
                        '[class*="company-name"], [class*="employer-name"]'
                    )?.textContent) ||
                    'Genese Solution';

                const companyUrl =
                    structured.hiringOrganization?.sameAs ||
                    structured.hiringOrganization?.url ||
                    null;

                return {
                    title,
                    company,
                    companyUrl,
                    location,
                    salary,
                    employmentType,
                    deadline,
                    description,
                    image,
                    experience: findLabel([
                        'Experience',
                        'Years of Experience'
                    ]),
                    level: findLabel([
                        'Job Level',
                        'Seniority',
                        'Career Level'
                    ]),
                    openings: findLabel([
                        'Number of Openings',
                        'Vacancies',
                        'Openings'
                    ]),
                    responsibilities: findLabel([
                        'Responsibilities',
                        'Key Responsibilities'
                    ]),
                    requirements: findLabel([
                        'Requirements',
                        'Qualifications'
                    ]),
                    skills: [],
                    url: location.href,
                    body
                };
            }, fallback);
        };

        try {
            meta.pagesVisited = meta.pagesVisited || 0;
            meta.listingHits = 0;
            meta.detailPagesVisited = 0;
            meta.detailParseFailures = 0;

            meta.pagesVisited++;
            await loadPage(page, LISTING_URL);
            await delay(1200);

            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }

            // The main careers page contains an external ATS iframe.
            const iframeUrl = await page.evaluate(() => {
                const iframe = document.querySelector(
                    'iframe[src*="pyjamahr.com"]'
                );
                return iframe ? iframe.src : null;
            });

            if (!iframeUrl) {
                meta.listingHits = 0;
                return { items, meta };
            }

            // The iframe is the real listing, not the site's marketing page.
            meta.pagesVisited++;
            await loadPage(page, iframeUrl, { timeout: 60000 });
            await delay(2500);

            const boardState = await detectPageState(page);

            if (boardState.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }

            let board = await extractBoard();

            // Allow client-rendered ATS content time to appear.
            if (!board.jobs.length) {
                await delay(2500);
                board = await extractBoard();
            }

            const emptyPattern =
                /no open positions|no current openings|no job openings|no vacancies|no any vacancy|check back soon|there are no (open|current)|sorry, no positions available/i;

            if (emptyPattern.test(board.bodyText) && !board.jobs.length) {
                meta.atsEmpty = true;
                meta.listingHits = 0;
                return { items, meta };
            }

            const validEntries = board.jobs.filter((entry) => {
                const title = (entry.title || '').trim();

                if (!title || title.length < 4 || title.length > 160) {
                    return false;
                }

                if (/^(view|apply|read more|learn more)$/i.test(title)) {
                    return false;
                }

                if (/^(careers|home|about|contact|leadership)$/i.test(
                    title
                )) {
                    return false;
                }

                return true;
            });

            meta.listingHits = validEntries.length;
            safeDiscovered(progress, validEntries.length);

            for (const entry of validEntries) {
                const detailUrl = normalizeUrl(
                    entry.href,
                    page.url()
                );

                const key = detailUrl || entry.title;

                if (seen.has(key)) {
                    safeUnitDone(progress);
                    continue;
                }

                seen.add(key);

                try {
                    let raw = null;
                    let finalUrl = detailUrl || page.url();

                    // Only navigate to genuine distinct job URLs.
                    if (
                        detailUrl &&
                        detailUrl !== page.url() &&
                        new URL(detailUrl).origin === new URL(page.url()).origin
                    ) {
                        meta.pagesVisited++;
                        meta.detailPagesVisited++;

                        await loadPage(page, detailUrl);
                        await delay(900);

                        raw = await extractDetail(entry);
                        finalUrl = page.url();
                    } else {
                        raw = await extractDetail(entry);
                    }

                    if (!raw || !raw.title) {
                        meta.detailParseFailures++;
                        continue;
                    }

                    const description = raw.description || null;
                    const company = raw.company || COMPANY;

                    const job = {
                        id: `genesesolution-${Buffer.from(
                            key
                        ).toString('base64').replace(/[^a-zA-Z0-9]/g, '')
                            .slice(0, 24)}`,

                        title: raw.title,
                        company,
                        company_status: 'extracted',
                        company_evidence:
                            'Employer identified from ATS hiring organization ' +
                            'or the careers page iframe company parameter.',

                        companyUrl: raw.companyUrl
                            ? normalizeUrl(raw.companyUrl, finalUrl)
                            : BASE_URL,

                        location: raw.location,
                        location_status: raw.location
                            ? 'extracted'
                            : 'site_absent',
                        location_evidence: raw.location
                            ? 'Extracted from JobPosting jobLocation or ' +
                                'location-labelled detail content.'
                            : 'Checked JobPosting jobLocation and location ' +
                                'labels on the ATS detail page and listing card.',

                        employmentType: raw.employmentType,
                        employmentType_status: raw.employmentType
                            ? 'extracted'
                            : 'site_absent',
                        employmentType_evidence: raw.employmentType
                            ? 'Extracted from JobPosting employmentType or ' +
                                'employment type labels.'
                            : 'Checked structured JobPosting data and ' +
                                'employment type labels.',

                        salary: raw.salary,
                        salary_status: raw.salary
                            ? 'extracted'
                            : 'site_absent',
                        salary_evidence: raw.salary
                            ? 'Extracted from structured salary data or ' +
                                'salary-labelled content.'
                            : 'Checked JobPosting baseSalary and salary labels.',

                        applicationEndsRaw: raw.deadline,
                        applicationEndsRaw_status: raw.deadline
                            ? 'extracted'
                            : 'site_absent',
                        applicationEndsRaw_evidence: raw.deadline
                            ? 'Extracted from validThrough or application ' +
                                'deadline labels.'
                            : 'Checked validThrough and deadline labels.',

                        description,
                        description_status: description
                            ? 'extracted'
                            : 'site_absent',
                        description_evidence: description
                            ? 'Extracted from the ATS detail body or listing card.'
                            : 'Checked job description, detail, article, main ' +
                                'and listing card content.',

                        image: raw.image
                            ? normalizeUrl(raw.image, finalUrl)
                            : null,
                        image_status: raw.image
                            ? 'extracted'
                            : 'site_absent',
                        image_evidence: raw.image
                            ? 'Extracted from detail image or og:image.'
                            : 'Checked detail images and OpenGraph image metadata.',

                        experience: raw.experience,
                        level: raw.level,
                        openings: raw.openings,
                        responsibilities: raw.responsibilities,
                        requirements: raw.requirements,
                        skills: raw.skills,

                        companyLogoUrl: null,
                        companyDescription: null,
                        companyLocation: null,
                        companyAddress: null,

                        attendanceMode: raw.location &&
                            /remote/i.test(raw.location)
                            ? 'Remote'
                            : null,

                        url: finalUrl,
                        registrationUrl: finalUrl,
                        source: 'genesesolution',
                        scrapedAt: Date.now()
                    };

                    // Avoid leaking a board-wide description into records.
                    if (
                        job.description &&
                        job.description.length > 4000 &&
                        job.description === board.bodyText
                    ) {
                        job.description = entry.text || null;
                        job.description_status = job.description
                            ? 'extracted'
                            : 'site_absent';
                    }

                    sanitizeJobFields(job);
                    items.push(job);
                } catch {
                    meta.detailParseFailures++;
                } finally {
                    safeUnitDone(progress);
                }
            }
        } catch {
            // A failed ATS request should not crash the scraper batch.
        }

        console.log(
            '  [genesesolution] extracted ' + items.length
        );

        return { items, meta };
    }
};