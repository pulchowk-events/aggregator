const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { sanitizeImageUrl } = require('../../sanitize');
const { cleanDescriptionText } = require('../../text');

const BASE_URL = 'https://aayulogic.com';
const LISTING_URL = `${BASE_URL}/careers/`;

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        meta.atsEmpty = false;

        // The actual structure is a careers listing with role-specific
        // routes. /about/ is a navigation link, not a job detail route.
        meta.pagesVisited++;
        await loadPage(page, LISTING_URL);
        await delay(1000);

        // Detect blocking on the first page only.
        try {
            const state = await detectPageState(page);

            if (state.looksBlocked) {
                meta.looksBlocked = true;
                meta.listingHits = 0;
                console.log('  [aayulogic] listing blocked');
                return { items, meta };
            }
        } catch (e) {
            // Diagnostics are best-effort.
        }

        // Harvest actual role links from the open-roles section.
        const listing = await page.evaluate(() => {
            const normalize = (value) =>
                (value || '').replace(/\s+/g, ' ').trim();

            const section = document.querySelector('#open-roles');
            if (!section) {
                return { entries: [], empty: false };
            }

            const sectionText = normalize(section.innerText).toLowerCase();

            const emptyPatterns = [
                'no open positions',
                'no current openings',
                'no job openings',
                'no vacancies',
                'no any vacancy',
                'not hiring',
                'check back soon',
                'there are no open',
                'there are no current',
                'sorry, no positions available at this time'
            ];

            const empty = emptyPatterns.some((pattern) =>
                sectionText.includes(pattern)
            );

            const entries = [];
            const seen = new Set();

            const links = Array.from(
                section.querySelectorAll('a[href]')
            );

            for (const link of links) {
                const href = link.getAttribute('href') || '';

                // Only accept actual individual career routes.
                if (!/^\/careers\/[^/?#]+\/?$/.test(href)) {
                    continue;
                }

                if (seen.has(href)) continue;
                seen.add(href);

                const titleElement = link.querySelector('h3');
                const title = normalize(
                    titleElement?.textContent
                );

                if (!title) continue;

                const divs = Array.from(link.children)
                    .flatMap((child) => [
                        child,
                        ...Array.from(child.querySelectorAll(':scope > div'))
                    ]);

                const department = normalize(
                    divs.find((el) =>
                        el.className.includes('text-sm') &&
                        el.className.includes('text-slate-600')
                    )?.textContent
                );

                const employmentType = normalize(
                    divs.find((el) =>
                        el.className.includes('text-sm') &&
                        el.className.includes('text-slate-500')
                    )?.textContent
                );

                const badges = Array.from(
                    link.querySelectorAll('span')
                )
                    .map((el) => normalize(el.textContent))
                    .filter(Boolean);

                entries.push({
                    href,
                    title,
                    department: department || null,
                    employmentType: employmentType || null,
                    badges
                });
            }

            return { entries, empty };
        });

        if (listing.empty && listing.entries.length === 0) {
            meta.atsEmpty = true;
            meta.listingHits = 0;
            console.log('  [aayulogic] extracted 0');
            return { items, meta };
        }

        const entries = listing.entries;

        meta.listingHits = entries.length;

        safeDiscovered(progress, entries.length);

        // No pagination was detected on the listing page.
        // The page currently exposes individual career detail links.
        for (const entry of entries) {
            const detailUrl = new URL(
                entry.href,
                BASE_URL
            ).href;

            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                await loadPage(page, detailUrl);
                await delay(500);

                const raw = await page.evaluate(() => {
                    const normalize = (value) =>
                        (value || '').replace(/\s+/g, ' ').trim();

                    const main = document.querySelector('main');

                    if (!main) {
                        return null;
                    }

                    const title = normalize(
                        main.querySelector('h1')?.textContent
                    );

                    const headings = Array.from(
                        main.querySelectorAll('h2')
                    );

                    // Extract content belonging to a particular
                    // section without including the rest of the page.
                    const extractSection = (headingText) => {
                        const heading = headings.find((el) =>
                            normalize(el.textContent)
                                .toLowerCase()
                                .includes(headingText.toLowerCase())
                        );

                        if (!heading) return '';

                        const nodes = Array.from(
                            main.querySelectorAll('h2, h3, p, li')
                        );

                        const start = nodes.indexOf(heading);
                        if (start < 0) return '';

                        const result = [];

                        for (let i = start + 1; i < nodes.length; i++) {
                            const node = nodes[i];

                            if (node.tagName === 'H2') break;

                            const text = normalize(node.textContent);

                            if (!text) continue;

                            if (node.tagName === 'LI') {
                                result.push(`• ${text}`);
                            } else {
                                result.push(text);
                            }
                        }

                        return result.join('\n');
                    };

                    const description = extractSection(
                        'Job Description'
                    );

                    const specification = extractSection(
                        'Job Specification'
                    );

                    // The detail page identifies the employer beside
                    // the role title.
                    const titleHeading = main.querySelector('h1');

                    const nearbyText = normalize(
                        titleHeading?.parentElement?.innerText ||
                        titleHeading?.parentElement?.parentElement?.innerText
                    );

                    const companyMatch = nearbyText.match(
                        /(?:Client Support|Aayulogic)\s*[·|]\s*(Aayulogic)/i
                    );

                    const company = companyMatch
                        ? companyMatch[1]
                        : (
                            /\bAayulogic\b/i.test(nearbyText)
                                ? 'Aayulogic'
                                : null
                        );

                    const mainText = normalize(main.innerText);

                    // Extract deadline from the job header.
                    const deadlineMatch = mainText.match(
                        /Deadline:\s*([^|]+?)(?=\s+(?:Job Description|Type:|Openings:)|$)/i
                    );

                    const typeMatch = mainText.match(
                        /\bType:\s*(FULL[\s-]*TIME|PART[\s-]*TIME|CONTRACT|INTERNSHIP)\b/i
                    );

                    const openingsMatch = mainText.match(
                        /\bOpenings:\s*(\d+)/i
                    );

                    const experienceMatch = (
                        description + '\n' + specification
                    ).match(
                        /\b(\d+\s*[-–]\s*\d+\s+years?|\d+\+?\s+years?)\b/i
                    );

                    const levelMatch = mainText.match(
                        /Employment level\s+([^\n]+)/i
                    );

                    const applyLink = Array.from(
                        main.querySelectorAll('a[href]')
                    ).find((a) =>
                        /apply now|apply for this role/i.test(
                            normalize(a.textContent)
                        )
                    );

                    const applyUrl = applyLink
                        ? applyLink.href
                        : null;

                    // Prefer a role-specific image if one exists.
                    // Generic company branding is not a job image.
                    const roleImage = Array.from(
                        main.querySelectorAll('img')
                    ).find((img) => {
                        const alt = normalize(img.alt).toLowerCase();

                        return alt &&
                            !alt.includes('aayulogic') &&
                            !alt.includes('headquarters') &&
                            !alt.includes('logo');
                    });

                    const image = roleImage
                        ? (
                            roleImage.currentSrc ||
                            roleImage.src ||
                            null
                        )
                        : null;

                    // Extract a JSON-LD JobPosting if the page
                    // provides one. Organization/WebSite alone
                    // are not treated as job records.
                    let jobPosting = null;

                    for (const script of document.querySelectorAll(
                        'script[type="application/ld+json"]'
                    )) {
                        try {
                            const parsed = JSON.parse(script.textContent);

                            const objects = Array.isArray(parsed)
                                ? parsed
                                : [parsed];

                            for (const obj of objects) {
                                if (obj['@type'] === 'JobPosting') {
                                    jobPosting = obj;
                                    break;
                                }

                                if (Array.isArray(obj['@graph'])) {
                                    jobPosting = obj['@graph'].find(
                                        (item) =>
                                            item['@type'] === 'JobPosting'
                                    ) || null;
                                }
                            }

                            if (jobPosting) break;
                        } catch (e) {
                            // Ignore malformed JSON-LD.
                        }
                    }

                    return {
                        title,
                        company,
                        description,
                        specification,
                        deadline: deadlineMatch
                            ? normalize(deadlineMatch[1])
                            : null,
                        employmentType: typeMatch
                            ? typeMatch[1]
                            : null,
                        openings: openingsMatch
                            ? Number(openingsMatch[1])
                            : null,
                        experience: experienceMatch
                            ? experienceMatch[1]
                            : null,
                        level: levelMatch
                            ? normalize(levelMatch[1])
                            : null,
                        applyUrl,
                        image,
                        jobPosting
                    };
                });

                if (!raw || (!raw.title && !entry.title)) {
                    meta.detailParseFailures++;
                    continue;
                }

                const jobPosting = raw.jobPosting || {};

                const title =
                    jobPosting.title ||
                    raw.title ||
                    entry.title;

                const company =
                    jobPosting.hiringOrganization?.name ||
                    raw.company ||
                    'Aayulogic';

                const descriptionParts = [];

                if (raw.description) {
                    descriptionParts.push(raw.description);
                }

                if (raw.specification) {
                    descriptionParts.push(
                        'Job Specification:\n' + raw.specification
                    );
                }

                let description = descriptionParts.join('\n\n');

                if (description) {
                    description = cleanDescriptionText(description);
                }

                if (!description) {
                    description = null;
                }

                const rawLocation =
                    jobPosting.jobLocation?.address?.addressLocality ||
                    jobPosting.jobLocation?.address?.addressRegion ||
                    null;

                const employmentType =
                    jobPosting.employmentType ||
                    raw.employmentType ||
                    entry.employmentType ||
                    null;

                const applicationEndsRaw =
                    jobPosting.validThrough ||
                    raw.deadline ||
                    null;

                const image = raw.image
                    ? sanitizeImageUrl(raw.image, BASE_URL)
                    : null;

                const registrationUrl = raw.applyUrl &&
                    /^https?:\/\//i.test(raw.applyUrl)
                    ? raw.applyUrl
                    : detailUrl;

                const finalJob = {
                    id: `aayulogic-${detailUrl
                        .split('/')
                        .filter(Boolean)
                        .pop()}`,

                    title,
                    company,

                    company_status: 'extracted',
                    company_evidence:
                        'Found beside the role title on the detail page; ' +
                        'also confirmed by the listing site branding.',

                    url: detailUrl,

                    url_status: 'extracted',
                    url_evidence:
                        'Individual role route harvested from #open-roles.',

                    location: rawLocation,

                    location_status: rawLocation
                        ? 'extracted'
                        : 'site_absent',

                    location_evidence: rawLocation
                        ? 'Extracted from JobPosting location.'
                        : 'Checked listing role row, detail header, ' +
                          'JobPosting location and At a glance section; ' +
                          'no physical job location published.',

                    description,

                    description_status: description
                        ? 'extracted'
                        : 'extraction_failed',

                    description_evidence:
                        'Read main h2, h3, p and li nodes between ' +
                        'Job Description and Job Specification headings.',

                    employmentType,

                    employmentType_status: employmentType
                        ? 'extracted'
                        : 'site_absent',

                    employmentType_evidence:
                        'Checked listing row employment label, detail ' +
                        'Type field and JobPosting employmentType.',

                    applicationEndsRaw,

                    applicationEndsRaw_status: applicationEndsRaw
                        ? 'extracted'
                        : 'site_absent',

                    applicationEndsRaw_evidence:
                        'Checked detail page Deadline field and ' +
                        'JobPosting validThrough.',

                    image,

                    image_status: image
                        ? 'extracted'
                        : 'site_absent',

                    image_evidence:
                        'Searched detail main img elements for a ' +
                        'role-specific image; generic company branding ' +
                        'was excluded.',

                    salary: null,

                    salary_status: 'site_absent',

                    salary_evidence:
                        'Checked listing role row, Job Description, ' +
                        'Job Specification and At a glance section; ' +
                        'no compensation figure published.',

                    experience: raw.experience ||
                        jobPosting.experienceRequirements ||
                        null,

                    level: raw.level ||
                        entry.badges.find((badge) =>
                            /^(junior|mid|senior|lead|executive)$/i.test(badge)
                        ) ||
                        null,

                    openings: raw.openings,

                    responsibilities: raw.description || '',

                    requirements: raw.specification || '',

                    skills: [],

                    companyUrl: BASE_URL,

                    companyLogoUrl: null,

                    companyDescription: null,

                    companyLocation: null,

                    companyAddress: null,

                    registrationUrl,

                    attendanceMode: null,

                    date: null,
                    time: null,
                    price: null,
                    organizer: company,
                    category: entry.department || null,

                    tags: [
                        ...(entry.department ? [entry.department] : []),
                        ...(employmentType ? [employmentType] : []),
                        ...(entry.badges || [])
                    ].filter(Boolean),

                    source: 'aayulogic',

                    scrapedAt: Date.now()
                };

                items.push(finalJob);
            } catch (error) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log('  [aayulogic] extracted ' + items.length);

        return { items, meta };
    }
};