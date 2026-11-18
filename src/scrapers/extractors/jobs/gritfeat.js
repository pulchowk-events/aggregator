// src/scrapers/extractors/jobs/gritfeat.js
// Site-specific extractor. See ../README.md for the contract.
//
// Structural shape: single careers landing page (https://www.gritfeat.com/careers)
// with a #we-are-hiring section. As of the evidence dump, the section renders
// an empty-state block ("No open positions right now" + "Please check back
// soon for new opportunities."). There are NO role cards, NO /careers/<role>
// detail links, and NO JobPosting JSON-LD. The only JSON-LD present is
// FAQPage. The wizard's "link" cardCandidates are <link rel="preload"> image
// hints, and the "/" detail-link pattern matches nav anchors (/about,
// /services, /contact, /insights) and /services/* marketing pages -- all
// rejected per the false-positive rules.
//
// Selector drift history:
//   2026-11-17: initial -- empty-state confirmed; defensive harvest added
//               so the extractor still works if GritFeat publishes roles
//               later without changing the empty-state copy.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne, pickAll } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const ENTRY_URL = 'https://www.gritfeat.com/careers';

// Phrases confirmed present in the #we-are-hiring empty-state block.
// Each kept short (<60 chars) to stay well under the 200-char regex cap.
const EMPTY_PATTERNS = [
    /no\s+open\s+positions/i,
    /no\s+current\s+openings/i,
    /no\s+job\s+openings/i,
    /check\s+back\s+soon/i,
    /no\s+vacancies/i,
    /no\s+any\s+vacancy/i,
    /no\s+positions\s+available/i
];

// Routes that are NOT per-job detail pages.
const NON_JOB_HREF = /^(#|tel:|mailto:|javascript:)/i;
const NON_JOB_DOMAIN = /(facebook|twitter|x\.com|linkedin|instagram|whatsapp|youtube)/i;
const NON_JOB_PATH = /\/(home|about|contact|blog|services|solutions|products|news|resources|industries|insights)(\/|$)/i;

// Detail-link harvest selectors. Tried in order; first non-empty wins.
// Kept broad so a future role-card structure is still caught.
const LISTING_SEL = [
    'a[href*="/careers/"]',
    'a[href*="/jobs/"]',
    'a[href*="/job/"]',
    'a[href*="/role/"]',
    'a[href*="/position/"]',
    'a[href*="/vacancy/"]',
    '#we-are-hiring a[href]',
    'section[id*="hiring"] a[href]',
    'section[id*="roles"] a[href]',
    'section[id*="open"] a[href]'
];

// Detail-page title selectors.
const TITLE_SEL = [
    'h1[class*="font-bold"]',
    'h1[class*="font-semibold"]',
    'h1',
    'h2[class*="job-title"]',
    'h2[class*="role-title"]',
    'h2[class*="font-bold"]',
    'h2'
];

// Detail-page description selectors, in priority order.
const DESC_SEL = [
    '[class*="job-description"]',
    '[class*="role-body"]',
    '[class*="job-detail"]',
    '[class*="role-description"]',
    'article p',
    'main p'
];

function isJobHref(href) {
    if (!href) return false;
    if (NON_JOB_HREF.test(href)) return false;
    if (NON_JOB_DOMAIN.test(href)) return false;
    if (NON_JOB_PATH.test(href)) return false;
    return true;
}

module.exports = {
    preprocessItem(item) { return item; },
    async extract(page, { progress, meta }) {
        const items = [];

        meta.pagesVisited++;
        try {
            await loadPage(page, ENTRY_URL);
            await delay(Math.random() * 1000 + 500);
        } catch (error) {
            console.warn(`⚠️ [gritfeat] failed to load entry URL: ${error.message}`);
            return { items, meta };
        }

        // Block / captcha check on first load.
        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`⚠️ [gritfeat] listing looks blocked — body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        // Empty-state detection (do this FIRST).
        // The GritFeat careers page renders "No open positions right now"
        // and "Please check back soon for new opportunities." inside
        // #we-are-hiring when there are zero openings.
        let pageText = '';
        try {
            pageText = await page.evaluate(() => document.body ? document.body.innerText : '');
        } catch (e) {
            pageText = '';
        }
        const isEmptyState = EMPTY_PATTERNS.some((re) => re.test(pageText));

        // Verify no role-shaped anchors exist before short-circuiting.
        // The site's only <a> elements are nav, social, and "Connect via
        // LinkedIn" team-member cards -- none point to per-job routes.
        let jobCardCount = 0;
        try {
            jobCardCount = await page.evaluate(() => {
                const anchors = Array.from(document.querySelectorAll('a[href]'));
                return anchors.filter((a) => {
                    const href = a.getAttribute('href') || '';
                    return /\/(job|jobs|career|careers|role|roles|position|positions|vacancy|vacancies)\/./i.test(href);
                }).length;
            });
        } catch (e) { /* best-effort */ }

        if (isEmptyState && jobCardCount === 0) {
            meta.atsEmpty = true;
            meta.listingHits = 0;
            console.log('  [gritfeat] no open positions — empty state detected');
            return { items, meta };
        }

        // Defensive harvest: if GritFeat starts publishing jobs later
        // without changing the empty-state copy, this catches them.
        let listing = { values: [], count: 0 };
        try {
            listing = await pickAll(page, LISTING_SEL, { label: 'listing' });
        } catch (e) {
            listing = { values: [], count: 0 };
        }
        meta.listingHits += listing.count;

        const detailLinks = (listing.values || [])
            .filter(isJobHref)
            .filter((href, idx, arr) => arr.indexOf(href) === idx)
            .slice(0, 80);

        safeDiscovered(progress, detailLinks.length);

        if (detailLinks.length === 0) {
            // No empty-state copy and no detail links either -- still empty.
            meta.atsEmpty = true;
            console.log('  [gritfeat] no job detail links found on listing page');
            return { items, meta };
        }

        for (const link of detailLinks) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await loadPage(page, link);
                await delay(Math.random() * 1000 + 500);

                const titleResult = await pickOne(page, TITLE_SEL, { label: `detail title (${link})` });

                const extras = await page.evaluate((descSels) => {
                    const getText = (el) => (el ? el.textContent.trim() : null);

                    const ogSiteName = document.querySelector('meta[property="og:site_name"]');
                    const ogCompany = ogSiteName ? ogSiteName.getAttribute('content') : null;

                    let company = ogCompany;
                    if (!company) {
                        const logoImg = document.querySelector('header img[alt], a[href="/"] img[alt]');
                        if (logoImg) company = (logoImg.getAttribute('alt') || '').trim() || null;
                    }

                    let description = null;
                    for (const sel of descSels) {
                        const el = document.querySelector(sel);
                        if (el) {
                            const txt = getText(el);
                            if (txt && txt.length > 50) {
                                description = txt;
                                break;
                            }
                        }
                    }

                    let location = null;
                    const locSels = [
                        '[class*="job-location"]',
                        '[class*="location"]',
                        '[data-location]'
                    ];
                    for (const sel of locSels) {
                        const el = document.querySelector(sel);
                        if (el) {
                            const txt = getText(el);
                            if (txt && txt.length < 80) {
                                location = txt;
                                break;
                            }
                        }
                    }

                    let employmentType = null;
                    const typeSels = [
                        '[class*="employment-type"]',
                        '[class*="job-type"]',
                        '[data-employment-type]'
                    ];
                    for (const sel of typeSels) {
                        const el = document.querySelector(sel);
                        if (el) {
                            employmentType = getText(el);
                            break;
                        }
                    }

                    let salary = null;
                    const salarySels = [
                        '[class*="salary"]',
                        '[class*="compensation"]',
                        '[data-salary]'
                    ];
                    for (const sel of salarySels) {
                        const el = document.querySelector(sel);
                        if (el) {
                            const txt = getText(el);
                            if (txt && txt.length < 60 && /[0-9]/.test(txt)) {
                                salary = txt;
                                break;
                            }
                        }
                    }

                    let image = null;
                    const imgEl = document.querySelector('article img, main img');
                    if (imgEl && typeof window.__resolveImageSrc === 'function') {
                        image = window.__resolveImageSrc(imgEl);
                    }

                    return {
                        company,
                        description,
                        location,
                        employmentType,
                        salary,
                        image,
                        finalUrl: window.location.href
                    };
                }, DESC_SEL);

                if (!titleResult.value) {
                    meta.detailParseFailures++;
                    continue;
                }

                const company = extras.company || null;
                const location = extras.location || null;
                const description = extras.description || null;
                const salary = extras.salary || null;

                items.push({
                    id: `gritfeat-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    title: titleResult.value,
                    company,
                    company_status: company ? 'extracted' : 'site_absent',
                    company_evidence: company
                        ? 'og:site_name meta or header logo alt'
                        : 'searched [class*="company"], [class*="employer"], header logo, og:site_name -- none found',
                    url: extras.finalUrl || link,
                    location,
                    location_status: location ? 'extracted' : 'site_absent',
                    location_evidence: location
                        ? '[class*="job-location"] / [class*="location"]'
                        : 'searched [class*="job-location"], [class*="location"], [data-location] -- none under 80 chars',
                    description,
                    description_status: description ? 'extracted' : 'site_absent',
                    description_evidence: description
                        ? 'matched one of [class*="job-description"], [class*="role-body"], article p, main p'
                        : 'searched [class*="job-description"], [class*="role-body"], [class*="job-detail"], article p, main p -- none with >50 chars',
                    employmentType: extras.employmentType || null,
                    applicationEndsRaw: null,
                    image: extras.image,
                    salary,
                    salary_status: salary ? 'extracted' : 'site_absent',
                    salary_evidence: salary
                        ? '[class*="salary"] / [class*="compensation"]'
                        : 'searched [class*="salary"], [class*="compensation"], [data-salary] -- none found',
                    source: 'gritfeat',
                    tags: [],
                    registrationUrl: extras.finalUrl || link
                });
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    continue;
                }
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log('  [gritfeat] extracted ' + items.length);
        return { items, meta };
    }
};