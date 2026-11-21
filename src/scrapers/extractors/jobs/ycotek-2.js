const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { sanitizeJobFields } = require('../../jobs');

const BASE_URL = 'https://ycotek.com';
const LISTING_URL = `${BASE_URL}/careers-at-yco/`;
const SOURCE = 'ycotek-2';

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];
        const seen = new Set();

        meta.atsEmpty = false;

        const absoluteUrl = (href) => {
            if (!href) return null;
            try {
                return new URL(href, BASE_URL).href;
            } catch {
                return null;
            }
        };

        const listing = async () => page.evaluate(() => {
            const text = (el) =>
                el ? el.textContent.replace(/\s+/g, ' ').trim() : '';

            const articles = Array.from(
                document.querySelectorAll('main article')
            );

            return articles.map((article) => {
                const links = Array.from(
                    article.querySelectorAll('a[href]')
                );

                const detailLink = links.find((a) => {
                    const href = a.getAttribute('href') || '';
                    return /\/careers\/[^/?#]+/.test(href);
                });

                const title = text(
                    article.querySelector('h1, h2, h3')
                );

                const articleText = text(article);

                const applyDate = articleText.match(
                    /Apply before:\s*(.+?)(?:APPLY NOW|$)/i
                );

                const employment = articleText.match(
                    /\b(Full Time|Part Time|Contract|Internship)\b/i
                );

                const openings = articleText.match(
                    /(\d+)\s+OPENING(?:S)?/i
                );

                return {
                    title,
                    href: detailLink
                        ? detailLink.getAttribute('href')
                        : null,
                    applyDate: applyDate ? applyDate[1].trim() : null,
                    employmentType: employment
                        ? employment[1]
                        : null,
                    openings: openings ? openings[1] : null,
                    text: articleText
                };
            }).filter((item) => item.title || item.href);
        });

        const scrapeDetail = async () => page.evaluate(() => {
            const text = (el) =>
                el ? el.textContent.replace(/\s+/g, ' ').trim() : '';

            const metaContent = (selector) => {
                const el = document.querySelector(selector);
                return el ? el.getAttribute('content') : null;
            };

            const titleFromMeta = metaContent(
                'meta[property="og:title"]'
            );

            const title = text(document.querySelector('main h1')) ||
                text(document.querySelector('main h2')) ||
                titleFromMeta?.replace(/\s*-\s*Ycotek$/i, '') ||
                document.title.replace(/\s*-\s*Ycotek$/i, '');

            const company = metaContent(
                'meta[property="og:site_name"]'
            ) || 'Ycotek';

            const main = document.querySelector('main');
            const article = main?.querySelector('article');

            const descriptionRoot = article || main;

            let description = '';

            if (descriptionRoot) {
                const sections = Array.from(
                    descriptionRoot.querySelectorAll(
                        'h2, h3, h4, p, li'
                    )
                );

                description = sections
                    .map((el) => {
                        const value = text(el);
                        if (!value) return '';
                        if (el.tagName === 'LI') {
                            return `• ${value}`;
                        }
                        return value;
                    })
                    .filter(Boolean)
                    .join('\n');

                description = description.trim();
            }

            const ogImage = metaContent(
                'meta[property="og:image"]'
            );

            const image = ogImage ||
                (descriptionRoot?.querySelector('img')
                    ? descriptionRoot.querySelector('img')
                        .getAttribute('src')
                    : null);

            const fullText = text(descriptionRoot);

            const locationMatch = fullText.match(
                /(?:Location|Based in|Work location)\s*[:\-]\s*([^.;\n]+)/i
            );

            const salaryMatch = fullText.match(
                /(?:Salary|Compensation|Pay)\s*[:\-]\s*([^.;\n]+)/i
            );

            const expiryMatch = fullText.match(
                /(?:Apply before|Application deadline|Closing date)\s*[:\-]\s*([^.;\n]+)/i
            );

            const employmentMatch = fullText.match(
                /\b(Full[- ]?Time|Part[- ]?Time|Contract|Internship)\b/i
            );

            const jsonLdJobs = [];

            const collectJobs = (value) => {
                if (!value) return;

                if (Array.isArray(value)) {
                    value.forEach(collectJobs);
                    return;
                }

                if (typeof value !== 'object') return;

                const type = value['@type'];
                const types = Array.isArray(type) ? type : [type];

                if (types.includes('JobPosting')) {
                    jsonLdJobs.push(value);
                }

                if (value['@graph']) {
                    collectJobs(value['@graph']);
                }
            };

            document.querySelectorAll(
                'script[type="application/ld+json"]'
            ).forEach((script) => {
                try {
                    collectJobs(JSON.parse(script.textContent));
                } catch {
                    // Ignore malformed JSON-LD.
                }
            });

            const job = jsonLdJobs[0] || null;

            const jsonLocation = job?.jobLocation;
            let structuredLocation = null;

            if (jsonLocation) {
                const locations = Array.isArray(jsonLocation)
                    ? jsonLocation
                    : [jsonLocation];

                structuredLocation = locations.map((entry) => {
                    const address = entry?.address;
                    if (typeof address === 'string') return address;

                    if (!address) return null;

                    return [
                        address.addressLocality,
                        address.addressRegion,
                        address.addressCountry
                    ].filter(Boolean).join(', ');
                }).filter(Boolean).join('; ') || null;
            }

            const jsonSalary = job?.baseSalary;
            let structuredSalary = null;

            if (jsonSalary) {
                const value = jsonSalary.value;
                if (value && typeof value === 'object') {
                    structuredSalary = [
                        value.minValue,
                        value.maxValue,
                        value.currency
                    ].filter(Boolean).join(' - ');
                } else {
                    structuredSalary = String(value || '');
                }
            }

            const jsonDescription = job?.description
                ? job.description.replace(/<[^>]*>/g, ' ')
                    .replace(/\s+/g, ' ').trim()
                : null;

            return {
                title: job?.title || title,
                company: job?.hiringOrganization?.name || company,
                companyUrl: job?.hiringOrganization?.sameAs ||
                    job?.hiringOrganization?.url || null,
                description: jsonDescription || description || null,
                location: structuredLocation ||
                    locationMatch?.[1]?.trim() || null,
                salary: structuredSalary ||
                    salaryMatch?.[1]?.trim() || null,
                employmentType: job?.employmentType
                    ? (Array.isArray(job.employmentType)
                        ? job.employmentType.join(', ')
                        : job.employmentType)
                    : employmentMatch?.[1] || null,
                applicationEndsRaw: job?.validThrough ||
                    expiryMatch?.[1]?.trim() || null,
                image,
                publishedAt: job?.datePosted || null,
                experience: null,
                level: null,
                openings: null
            };
        });

        try {
            meta.pagesVisited++;
            await loadPage(page, LISTING_URL);

            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }

            await delay(1000);

            const entries = await listing();

            const emptyState = await page.evaluate(() => {
                const body = (
                    document.body?.innerText || ''
                ).toLowerCase();

                const phrases = [
                    'no open positions',
                    'no current openings',
                    'no job openings',
                    'no vacancies',
                    'no any vacancy',
                    'we are always hiring',
                    'always on the lookout',
                    'not hiring',
                    'check back soon',
                    'there are no open',
                    'there are no current',
                    'sorry, no positions available at this time'
                ];

                return phrases.some((phrase) =>
                    body.includes(phrase)
                );
            });

            if (emptyState && entries.length === 0) {
                meta.atsEmpty = true;
                meta.listingHits = 0;
                return { items, meta };
            }

            const validEntries = entries.filter((entry) => {
                const url = absoluteUrl(entry.href);

                return url &&
                    new URL(url).hostname === 'ycotek.com' &&
                    new URL(url).pathname.startsWith('/careers/');
            });

            const uniqueEntries = validEntries.filter((entry) => {
                const url = absoluteUrl(entry.href);
                if (!url || seen.has(url)) return false;

                seen.add(url);
                return true;
            });

            meta.listingHits = uniqueEntries.length;
            safeDiscovered(progress, uniqueEntries.length);

            for (const entry of uniqueEntries) {
                const url = absoluteUrl(entry.href);

                try {
                    meta.pagesVisited++;
                    meta.detailPagesVisited++;

                    await loadPage(page, url);
                    await delay(800);

                    const raw = await scrapeDetail(page);

                    const title = raw.title || entry.title;

                    if (!title) {
                        meta.detailParseFailures++;
                        continue;
                    }

                    const company = raw.company || 'Ycotek';

                    const finalJob = {
                        id: `ycotek-${Buffer.from(url)
                            .toString('base64url')
                            .slice(0, 32)}`,

                        title,
                        company,

                        company_status: 'extracted',

                        companyUrl: absoluteUrl(raw.companyUrl),

                        companyLogoUrl: null,

                        companyDescription: null,
                        companyLocation: null,
                        companyAddress: null,

                        location: raw.location,
                        location_status: raw.location
                            ? 'extracted'
                            : 'site_absent',
                        location_evidence: raw.location
                            ? 'Extracted from JobPosting or role-body location text.'
                            : 'Checked JobPosting.jobLocation and role-body text for location labels; none found.',

                        employmentType: raw.employmentType,
                        employmentType_status: raw.employmentType
                            ? 'extracted'
                            : 'site_absent',
                        employmentType_evidence: raw.employmentType
                            ? 'Extracted from JobPosting or role-body text.'
                            : 'Checked JobPosting.employmentType and role-body text for employment type.',

                        salary: raw.salary,
                        salary_status: raw.salary
                            ? 'extracted'
                            : 'site_absent',
                        salary_evidence: raw.salary
                            ? 'Extracted from JobPosting or compensation text.'
                            : 'Checked JobPosting.baseSalary and role-body compensation labels; no salary published.',

                        experience: raw.experience,
                        level: raw.level,
                        openings: raw.openings ||
                            entry.openings || null,

                        description: raw.description,
                        description_status: raw.description
                            ? 'extracted'
                            : 'extraction_failed',
                        description_evidence: raw.description
                            ? 'Extracted from JobPosting.description or main article headings, paragraphs and lists.'
                            : 'Attempted JobPosting.description and main article/main h2, h3, h4, p and li.',

                        responsibilities: '',
                        requirements: '',
                        skills: [],

                        applicationEndsRaw: raw.applicationEndsRaw ||
                            entry.applyDate || null,
                        applicationEndsRaw_status:
                            (raw.applicationEndsRaw || entry.applyDate)
                                ? 'extracted'
                                : 'site_absent',
                        applicationEndsRaw_evidence:
                            'Checked JobPosting.validThrough, role-body deadline labels and listing article Apply before text.',

                        publishedAt: raw.publishedAt,

                        attendanceMode: raw.location &&
                            /remote/i.test(raw.location)
                                ? 'Remote'
                                : null,

                        image: raw.image
                            ? absoluteUrl(raw.image)
                            : null,

                        url,
                        registrationUrl: url,

                        source: SOURCE,
                        scrapedAt: Date.now()
                    };

                    if (!finalJob.companyUrl) {
                        finalJob.companyUrl_status = 'site_absent';
                        finalJob.companyUrl_evidence =
                            'Checked JobPosting.hiringOrganization and sameAs/url fields.';
                    }

                    if (!finalJob.image) {
                        finalJob.image_status = 'site_absent';
                        finalJob.image_evidence =
                            'Checked og:image and images inside the main role content.';
                    }

                    if (!finalJob.publishedAt) {
                        finalJob.publishedAt_status = 'site_absent';
                        finalJob.publishedAt_evidence =
                            'Checked JobPosting.datePosted; no publication date found.';
                    }

                    sanitizeJobFields(finalJob);

                    items.push(finalJob);
                } catch (error) {
                    meta.detailParseFailures++;
                } finally {
                    safeUnitDone(progress);
                }
            }
        } catch (error) {
            console.error(
                `[${SOURCE}] extraction failed:`,
                error.message
            );
        }

        console.log(
            `  [${SOURCE}] extracted ${items.length} job(s)`
        );

        return { items, meta };
    }
};