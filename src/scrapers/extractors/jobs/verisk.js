// VERDICT: CAREERS_PAGE
// Correction: The entry URL is a general SmartRecruiters job board,
// not a Verisk-specific careers page. Results are filtered to Verisk.
// Correct detail title: h1.job-title[itemprop="title"].
// Correct description: section#st-jobDescription and related job sections.
// The proposed H1.isn-overlay-dialog-header is an Internet Explorer warning.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { sanitizeJobFields } = require('../../jobs');

const BASE_URL = 'https://jobs.smartrecruiters.com/';
const COMPANY_NAME = 'Verisk';
const MAX_SCROLL_STEPS = 10;

function absoluteUrl(url) {
    if (!url) return null;

    try {
        return new URL(url, BASE_URL).href;
    } catch {
        return null;
    }
}

function cleanText(value) {
    return value
        ? value.replace(/\s+/g, ' ').trim()
        : null;
}

function extractSalary(text) {
    if (!text) return null;

    const patterns = [
        /\$\s?[\d,]+(?:\.\d{2})?\s*[-–]\s*\$?\s?[\d,]+(?:\.\d{2})?/,
        /(?:USD|EUR|GBP)\s?[\d,]+(?:\s*[-–]\s*[\d,]+)?/i,
        /\$\s?[\d,]+(?:\.\d{2})?\s*(?:per|\/)\s*(?:year|hour)/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) return cleanText(match[0]);
    }

    return null;
}

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];
        const entries = new Map();

        meta.atsEmpty = false;

        await loadPage(page, BASE_URL);
        meta.pagesVisited++;

        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch {
            // Page-state detection is best-effort.
        }

        const listingState = await page.evaluate(() => {
            const text = (document.body.innerText || '').toLowerCase();

            const emptyPatterns = [
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

            const emptyMessage = emptyPatterns.some(
                pattern => text.includes(pattern)
            );

            const cards = Array.from(
                document.querySelectorAll('li.jobs-item')
            );

            return {
                emptyMessage,
                hasCards: cards.length > 0
            };
        });

        if (listingState.emptyMessage && !listingState.hasCards) {
            meta.atsEmpty = true;
            meta.listingHits = 0;
            return { items, meta };
        }

        const harvestListings = async () => {
            const rows = await page.evaluate((companyName) => {
                const getText = (el) => el
                    ? el.textContent.replace(/\s+/g, ' ').trim()
                    : null;

                return Array.from(
                    document.querySelectorAll('li.jobs-item')
                ).map(card => {
                    const link = card.querySelector('a.job[href]');
                    if (!link) return null;

                    const href = link.getAttribute('href');

                    const title = getText(
                        card.querySelector('.job-title')
                    );

                    const details = Array.from(
                        card.querySelectorAll('.job-details li')
                    ).map(getText).filter(Boolean);

                    const company = details[0] || null;

                    if (
                        !company ||
                        company.toLowerCase() !== companyName.toLowerCase()
                    ) {
                        return null;
                    }

                    const locationElement = card.querySelector(
                        '.job-location spl-job-location'
                    );

                    const locationText = getText(
                        card.querySelector('.job-location')
                    );

                    const workplaceType = locationElement
                        ? locationElement.getAttribute('workplacetype')
                        : null;

                    const image = card.querySelector('.job-logo img');

                    return {
                        href,
                        title,
                        company,
                        location: locationText ||
                            (workplaceType === 'remote' ? 'Remote' : null),
                        workplaceType,
                        image: image ? image.src : null
                    };
                }).filter(Boolean);
            }, COMPANY_NAME);

            for (const row of rows) {
                const url = absoluteUrl(row.href);

                if (url && !entries.has(url)) {
                    entries.set(url, {
                        ...row,
                        url
                    });
                }
            }
        };

        await harvestListings();

        // SmartRecruiters may load additional jobs while scrolling.
        for (let i = 0; i < MAX_SCROLL_STEPS; i++) {
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
            });

            await delay(1000);

            await harvestListings();
        }

        const linkEntries = Array.from(entries.values());

        meta.listingHits = linkEntries.length;
        safeDiscovered(progress, linkEntries.length);

        if (linkEntries.length === 0) {
            meta.atsEmpty = true;
            console.log('[verisk] extracted 0');
            return { items, meta };
        }

        const scrapeDetail = async () => page.evaluate(() => {
            const getText = (el) => el
                ? el.textContent.replace(/\s+/g, ' ').trim()
                : null;

            const getMeta = (selector) => {
                const el = document.querySelector(selector);
                return el
                    ? el.getAttribute('content')
                    : null;
            };

            const title = getText(
                document.querySelector('h1.job-title[itemprop="title"]')
            ) || getMeta('meta[property="og:title"]');

            const company = getMeta(
                '[itemprop="hiringOrganization"] [itemprop="name"]'
            ) || getMeta('meta[property="og:site_name"]');

            const companyLogoUrl = getMeta(
                '[itemprop="hiringOrganization"] [itemprop="logo"]'
            );

            const locationElement = document.querySelector(
                'spl-job-location[formattedaddress]'
            );

            const locationMeta = document.querySelector(
                '[itemprop="addressLocality"]'
            );

            const location = locationElement
                ? locationElement.getAttribute('formattedaddress')
                : [
                    locationMeta?.getAttribute('content'),
                    document.querySelector('[itemprop="addressRegion"]')
                        ?.getAttribute('content'),
                    document.querySelector('[itemprop="addressCountry"]')
                        ?.getAttribute('content')
                ].filter(Boolean).join(', ') || null;

            const employmentType = getText(
                document.querySelector('[itemprop="employmentType"]')
            );

            const datePosted = getMeta('[itemprop="datePosted"]');

            const descriptionSections = [
                '#st-jobDescription',
                '#st-qualifications',
                '#st-additionalInformation'
            ];

            const sectionTexts = {};

            for (const selector of descriptionSections) {
                const section = document.querySelector(selector);

                if (!section) continue;

                const content = section.querySelector(
                    '.wysiwyg.spl-wysiwyg'
                );

                if (!content) continue;

                const paragraphs = Array.from(
                    content.querySelectorAll('p, li')
                ).map(el => {
                    const text = getText(el);

                    return el.tagName === 'LI'
                        ? `• ${text}`
                        : text;
                }).filter(Boolean);

                sectionTexts[selector] = paragraphs.join('\n');
            }

            const description = Object.values(sectionTexts)
                .filter(Boolean)
                .join('\n\n');

            const responsibilities = sectionTexts['#st-jobDescription'] || '';
            const requirements = sectionTexts['#st-qualifications'] || '';

            const fullDescription = description;

            const salary = (() => {
                const text = sectionTexts['#st-qualifications'] || '';
                const patterns = [
                    /\$\s?[\d,]+(?:\.\d{2})?\s*[-–]\s*\$?\s?[\d,]+(?:\.\d{2})?/,
                    /(?:USD|EUR|GBP)\s?[\d,]+(?:\s*[-–]\s*[\d,]+)?/i
                ];

                for (const pattern of patterns) {
                    const match = text.match(pattern);
                    if (match) return match[0];
                }

                return null;
            })();

            const applyLink = Array.from(
                document.querySelectorAll('a[href]')
            ).find(a => {
                const text = (a.textContent || '').trim();
                return /\bapply\b/i.test(text);
            });

            const experienceMatch = fullDescription.match(
                /\b(\d+\+?\s*(?:years?|months?))\s+(?:of\s+)?experience\b/i
            );

            const levelMatch = title
                ? title.match(
                    /\b(senior|junior|lead|principal|director|manager|intern)\b/i
                )
                : null;

            const image = getMeta(
                '[itemprop="hiringOrganization"] [itemprop="logo"]'
            );

            return {
                title,
                company,
                companyLogoUrl: image,
                location,
                employmentType,
                datePosted,
                description: fullDescription || null,
                responsibilities: responsibilities || null,
                requirements: requirements || null,
                salary,
                experience: experienceMatch
                    ? experienceMatch[0]
                    : null,
                level: levelMatch
                    ? levelMatch[0]
                    : null,
                applyUrl: applyLink
                    ? applyLink.href
                    : null
            };
        });

        for (const entry of linkEntries) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                await loadPage(page, entry.url);
                await delay(500);

                const raw = await scrapeDetail();

                const title = raw.title || entry.title || null;

                if (!title) {
                    meta.detailParseFailures++;
                    continue;
                }

                // Avoid accidentally collecting other employers'
                // jobs from the general SmartRecruiters marketplace.
                if (
                    raw.company &&
                    raw.company.toLowerCase() !== COMPANY_NAME.toLowerCase()
                ) {
                    meta.detailParseFailures++;
                    continue;
                }

                const description = raw.description || null;
                const location = raw.location || entry.location || null;

                const salary = raw.salary || null;

                const applicationEndsRaw = null;

                const finalJob = {
                    id: `verisk-${entry.url.split('/').pop()}`,

                    title,
                    company: raw.company || entry.company || null,

                    company_status: (
                        raw.company || entry.company
                    ) ? 'extracted' : 'site_absent',

                    company_evidence: (
                        raw.company || entry.company
                    ) ? null :
                        'Checked hiringOrganization name, og:site_name, ' +
                        'and listing job-details company label.',

                    companyUrl: null,

                    companyLogoUrl: raw.companyLogoUrl ||
                        entry.image ||
                        null,

                    location,

                    location_status: location
                        ? 'extracted'
                        : 'extraction_failed',

                    location_evidence: location
                        ? null
                        : 'Tried spl-job-location formattedaddress, ' +
                          'PostalAddress metadata and listing .job-location.',

                    employmentType: raw.employmentType || null,

                    employmentType_status: raw.employmentType
                        ? 'extracted'
                        : 'site_absent',

                    employmentType_evidence: raw.employmentType
                        ? null
                        : 'Checked [itemprop="employmentType"] on detail page.',

                    description,

                    description_status: description
                        ? 'extracted'
                        : 'extraction_failed',

                    description_evidence: description
                        ? null
                        : 'Checked #st-jobDescription, #st-qualifications ' +
                          'and #st-additionalInformation .wysiwyg.spl-wysiwyg.',

                    responsibilities: raw.responsibilities || '',
                    requirements: raw.requirements || '',

                    skills: [],
                    experience: raw.experience,
                    level: raw.level,
                    openings: null,

                    salary,

                    salary_status: salary
                        ? 'extracted'
                        : 'site_absent',

                    salary_evidence: salary
                        ? null
                        : 'Checked compensation text in #st-qualifications.',

                    applicationEndsRaw,

                    applicationEndsRaw_status: 'site_absent',

                    applicationEndsRaw_evidence:
                        'No application deadline element was found in ' +
                        'the supplied detail HTML or field evidence.',

                    publishedAt: raw.datePosted || null,

                    image: entry.image || raw.companyLogoUrl || null,

                    url: entry.url,

                    registrationUrl: raw.applyUrl || entry.url,

                    attendanceMode: (
                        entry.workplaceType === 'remote' ||
                        /remote/i.test(location || '')
                    ) ? 'Remote' : null,

                    companyDescription: null,
                    companyLocation: null,
                    companyAddress: null,

                    source: 'verisk',
                    scrapedAt: Date.now()
                };

                sanitizeJobFields(finalJob);

                items.push(finalJob);
            } catch (error) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log('[verisk] extracted ' + items.length);

        return { items, meta };
    }
};