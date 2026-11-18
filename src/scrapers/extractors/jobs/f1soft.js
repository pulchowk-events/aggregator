// VERDICT: CAREERS_PAGE
// Entry URL https://career.f1soft.com/ is the F1Soft careers homepage with a
// "Featured Jobs" section (6 cards in div.features-job) and a "Find Jobs" nav
// link to https://career.f1soft.com/jobs on the same domain.
//
// Corrected wizard assumptions:
//   - Site type: single-page-cards with optional detail-page fallback.
//     Wizard detailLinkCandidates were /categories/* and /organizations/* hub
//     pages — false positives per wizard warnings, not per-job detail routes.
//   - JSON-LD on listing: no useful JobPosting (only WebPage type).
//   - Card wrapper: div.features-job inside div.col-lg-6 (NOT <link>; the
//     <link> count of 13 is HTML chrome — false positive).
//   - Detail-link pattern: bare / matches every nav anchor — false positive.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne, pickAll } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const F1SOFT_LISTING_URLS = [
    'https://career.f1soft.com/jobs',
    'https://career.f1soft.com/'
];

const EMPTY_STATE_PATTERNS = [
    'no open positions', 'no current openings', 'no job openings',
    'no vacancies', 'no any vacancy', 'we are always hiring',
    'always on the lookout', 'check back soon', 'there are no open',
    'there are no current', 'sorry, no positions available at this time'
];

const DETAIL_DESC_SELECTORS = [
    '[class*="job-description"]',
    '[class*="role-body"]',
    '[class*="job-detail"]',
    'article p',
    '.job-content p',
    '.description p',
    '.job-description p',
    'main p'
];

const DETAIL_DEADLINE_SELECTORS = [
    '[class*="deadline"]',
    '[class*="apply-by"]',
    '[class*="expiry"]',
    '[class*="closing"]',
    '[class*="end-date"]',
    '[class*="last-date"]'
];

function isHubLink(href) {
    return /\/(categories|organizations|types|levels)\//.test(href);
}

module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        const items = [];
        const seenKeys = new Set();

        for (const listingUrl of F1SOFT_LISTING_URLS) {
            try {
                meta.pagesVisited++;
                await loadPage(page, listingUrl);
                await delay(Math.random() * 1000 + 500);
            } catch (error) {
                continue;
            }

            if (meta.pagesVisited === 1) {
                try {
                    const state = await detectPageState(page);
                    if (state.looksBlocked) {
                        meta.looksBlocked = true;
                        return { items, meta };
                    }
                } catch (e) { /* best-effort */ }
            }

            try {
                await page.waitForSelector(
                    'div.features-job, div.job-archive-header',
                    { timeout: 10000 }
                );
            } catch (e) {
                try {
                    const bodyText = await page.evaluate(() =>
                        document.body.innerText.toLowerCase()
                    );
                    if (EMPTY_STATE_PATTERNS.some((p) => bodyText.includes(p))) {
                        meta.atsEmpty = true;
                        return { items, meta };
                    }
                } catch (e2) { /* best-effort */ }
                continue;
            }

            const cards = await page.evaluate(() => {
                const cardEls = Array.from(document.querySelectorAll('div.features-job'));
                const getText = (el) => (el ? el.textContent.trim().replace(/\s+/g, ' ') : null);

                const HUB = /\/(categories|organizations|types|levels)\//;
                const SOCIAL = /(facebook|twitter|x\.com|linkedin|instagram|whatsapp|youtube)/i;
                const SKIP = /^(javascript:|#|tel:|mailto:)/i;
                const TYPE_RE = /^(full[\s-]?time|part[\s-]?time|contract|internship|temporary|permanent|freelance)$/i;

                return cardEls.map((card) => {
                    const titleEl = card.querySelector(
                        'h3 a, h4 a, h5 a, h3, h4, h5, .job-title a, .job-title, [class*="job-title"] a, [class*="job-title"]'
                    );
                    const title = titleEl ? getText(titleEl) : null;

                    const allLinks = Array.from(card.querySelectorAll('a[href]'));
                    let detailUrl = null;
                    for (const a of allLinks) {
                        const href = a.href;
                        if (!href || HUB.test(href) || href.includes('/search')) continue;
                        if (SKIP.test(href) || SOCIAL.test(href)) continue;
                        if (href.includes('/jobs/') || href.includes('/job/')) {
                            detailUrl = href;
                            break;
                        }
                    }
                    if (!detailUrl) {
                        for (const a of allLinks) {
                            const href = a.href;
                            if (!href || HUB.test(href) || href.includes('/search')) continue;
                            if (SKIP.test(href) || SOCIAL.test(href)) continue;
                            if (a.textContent.trim() === title) {
                                detailUrl = href;
                                break;
                            }
                        }
                    }

                    let company = null;
                    const logoImg = card.querySelector('.logo-company img, [class*="logo-company"] img');
                    if (logoImg) {
                        const alt = logoImg.getAttribute('alt') || logoImg.getAttribute('title');
                        if (alt && !/^(logo|image|photo|company logo)$/i.test(alt)) {
                            company = alt.trim();
                        }
                    }
                    if (!company) {
                        const companyEl = card.querySelector(
                            '[class*="company-name"], [class*="company"] .name, .company-title, [class*="employer"]'
                        );
                        company = companyEl ? getText(companyEl) : null;
                    }

                    const locationEl = card.querySelector('[class*="location"], .job-location');
                    let location = locationEl ? getText(locationEl) : null;
                    if (location && location.length > 80) location = location.substring(0, 80);

                    let employmentType = null;
                    const typeLinks = Array.from(card.querySelectorAll(
                        'a[href*="/types/"], [class*="job-type"], .badge'
                    ));
                    for (const t of typeLinks) {
                        const txt = getText(t);
                        if (txt && TYPE_RE.test(txt)) {
                            employmentType = txt;
                            break;
                        }
                    }

                    const imgEl = card.querySelector('.logo-company img, [class*="logo-company"] img');
                    const image = imgEl ? window.__resolveImageSrc(imgEl) : null;

                    let category = null;
                    const catLink = card.querySelector('a[href*="/categories/"]');
                    if (catLink) category = getText(catLink);

                    let level = null;
                    const levelLink = card.querySelector('a[href*="/levels/"]');
                    if (levelLink) level = getText(levelLink);

                    let description = null;
                    const descEl = card.querySelector('.job-description, [class*="description"], p');
                    if (descEl) {
                        const txt = getText(descEl);
                        if (txt && txt.length > 30) description = txt;
                    }

                    let salary = null;
                    const salaryEl = card.querySelector(
                        '[class*="salary"], [class*="compensation"], [class*="remuneration"]'
                    );
                    if (salaryEl) {
                        const txt = getText(salaryEl);
                        if (txt && txt.length < 60 && /[0-9]/.test(txt)) salary = txt;
                    }

                    return {
                        title, detailUrl, company, location, employmentType,
                        image, category, level, description, salary
                    };
                }).filter((c) => c.title);
            });

            meta.listingHits += cards.length;
            safeDiscovered(progress, cards.length);

            for (const card of cards) {
                if (!card.title) continue;
                const dedupKey = card.detailUrl || card.title.toLowerCase();
                if (seenKeys.has(dedupKey)) continue;
                seenKeys.add(dedupKey);

                const item = {
                    id: `f1soft-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    title: card.title,
                    company: card.company || 'F1Soft International',
                    company_status: card.company ? 'extracted' : 'site_absent',
                    company_evidence: card.company
                        ? 'from card .logo-company img[alt] or [class*="company-name"]'
                        : 'searched .logo-company img[alt], [class*="company-name"], [class*="employer"] in card -- none; site og:description and /organizations/f1soft identify employer as F1Soft International',
                    url: card.detailUrl || listingUrl,
                    location: card.location || null,
                    location_status: card.location ? 'extracted' : 'site_absent',
                    location_evidence: card.location
                        ? 'from card [class*="location"]'
                        : 'searched [class*="location"], .job-location in card -- none; site footer mentions Pulchowk, Lalitpur, Nepal as HQ',
                    description: card.description || null,
                    description_status: card.description ? 'extracted' : 'extraction_failed',
                    description_evidence: card.description
                        ? 'from card .job-description / [class*="description"] / p'
                        : 'searched .job-description, [class*="description"], p in card -- no role body; will fetch detail page if link exists',
                    employmentType: card.employmentType || null,
                    employmentType_status: card.employmentType ? 'extracted' : 'site_absent',
                    employmentType_evidence: card.employmentType
                        ? 'from card a[href*="/types/"] or .badge'
                        : 'searched a[href*="/types/"], .badge in card -- none found',
                    image: card.image || null,
                    category: card.category || null,
                    level: card.level || null,
                    tags: [card.category, card.level].filter(Boolean),
                    salary: card.salary || null,
                    salary_status: card.salary ? 'extracted' : 'site_absent',
                    salary_evidence: card.salary
                        ? 'from card [class*="salary"]'
                        : 'searched [class*="salary"], [class*="compensation"] in card -- none found',
                    source: 'f1soft'
                };

                if (card.detailUrl && card.detailUrl !== listingUrl && !isHubLink(card.detailUrl)) {
                    try {
                        meta.pagesVisited++;
                        meta.detailPagesVisited++;
                        await loadPage(page, card.detailUrl);
                        await delay(Math.random() * 1000 + 500);

                        const detail = await page.evaluate((descSels, deadlineSels) => {
                            const getText = (el) => (el ? el.textContent.trim().replace(/\s+/g, ' ') : null);
                            const TYPE_RE = /^(full[\s-]?time|part[\s-]?time|contract|internship|temporary|permanent|freelance)$/i;

                            let description = null;
                            for (const sel of descSels) {
                                const el = document.querySelector(sel);
                                if (el) {
                                    const txt = getText(el);
                                    if (txt && txt.length > 50 && txt.length < 8000) {
                                        description = txt;
                                        break;
                                    }
                                }
                            }

                            const locEl = document.querySelector('[class*="location"], .job-location');
                            const location = locEl ? getText(locEl) : null;

                            let employmentType = null;
                            const typeLinks = Array.from(document.querySelectorAll(
                                'a[href*="/types/"], [class*="job-type"], .badge'
                            ));
                            for (const t of typeLinks) {
                                const txt = getText(t);
                                if (txt && TYPE_RE.test(txt)) {
                                    employmentType = txt;
                                    break;
                                }
                            }

                            let applicationEndsRaw = null;
                            for (const sel of deadlineSels) {
                                const el = document.querySelector(sel);
                                if (el) {
                                    const txt = getText(el);
                                    if (txt && txt.length < 100) {
                                        applicationEndsRaw = txt;
                                        break;
                                    }
                                }
                            }

                            let salary = null;
                            const salaryEl = document.querySelector(
                                '[class*="salary"], [class*="compensation"], [class*="remuneration"]'
                            );
                            if (salaryEl) {
                                const txt = getText(salaryEl);
                                if (txt && txt.length < 60 && /[0-9]/.test(txt)) salary = txt;
                            }

                            const companyLogoEl = document.querySelector(
                                'header [class*="logo"] img, .company-logo img, [class*="company-logo"] img'
                            );
                            const companyLogoUrl = companyLogoEl ? (companyLogoEl.src || null) : null;

                            const companyUrlEl = document.querySelector('a[href*="/organizations/"]');
                            const companyUrl = companyUrlEl ? companyUrlEl.href : null;

                            return {
                                description, location, employmentType,
                                applicationEndsRaw, salary, companyLogoUrl, companyUrl
                            };
                        }, DETAIL_DESC_SELECTORS, DETAIL_DEADLINE_SELECTORS);

                        if (detail.description) {
                            item.description = detail.description;
                            item.description_status = 'extracted';
                            item.description_evidence = 'from detail page [class*="job-description"] / article p';
                        }
                        if (detail.location && !item.location) {
                            item.location = detail.location;
                            item.location_status = 'extracted';
                            item.location_evidence = 'from detail page [class*="location"]';
                        }
                        if (detail.employmentType && !item.employmentType) {
                            item.employmentType = detail.employmentType;
                            item.employmentType_status = 'extracted';
                            item.employmentType_evidence = 'from detail page a[href*="/types/"] or .badge';
                        }
                        if (detail.applicationEndsRaw) {
                            item.applicationEndsRaw = detail.applicationEndsRaw;
                        }
                        if (detail.salary && !item.salary) {
                            item.salary = detail.salary;
                            item.salary_status = 'extracted';
                            item.salary_evidence = 'from detail page [class*="salary"]';
                        }
                        if (detail.companyLogoUrl) {
                            item.companyLogoUrl = detail.companyLogoUrl;
                        }
                        if (detail.companyUrl) {
                            item.companyUrl = detail.companyUrl;
                        }
                    } catch (error) {
                        meta.detailParseFailures++;
                    } finally {
                        safeUnitDone(progress);
                    }
                }

                items.push(item);
            }

            if (cards.length > 0 && listingUrl === F1SOFT_LISTING_URLS[0]) break;
        }

        if (items.length === 0 && !meta.atsEmpty) {
            try {
                const bodyText = await page.evaluate(() =>
                    document.body.innerText.toLowerCase()
                );
                if (EMPTY_STATE_PATTERNS.some((p) => bodyText.includes(p))) {
                    meta.atsEmpty = true;
                }
            } catch (e) { /* best-effort */ }
        }

        console.log(`  [f1soft] extracted ${items.length}`);
        return { items, meta };
    }
};