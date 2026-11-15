// src/scrapers/extractors/jobs/evolveasia.js
// Site-specific extractor. See ../README.md for the contract.
//
// VERDICT: CAREERS_PAGE -- /layouts/job-list.html is the careers listing.
//
// Strategy: listing-to-detail. The listing page exposes 8 cards
// (div.job-list__item.icon), each with an h3.title > a pointing at a
// per-role detail page (e.g. /customer-success-executive.html).
// The detail page has NO JSON-LD and its H1s are marketing headings
// ("Building effective distribution.", "We're hiring") -- not the job
// title. So the authoritative title comes from the listing card anchor.
// Description body lives in div.col-xsmall-12.col-small-7 (3947 chars
// on the sample) with a teaser <p> on the listing card as fallback.
//
// Field notes:
//  - company: "Evolve Pvt Ltd" (page <title>) / "Evolve Asia" (brand);
//    every job is on this site's own careers page, so the employer is
//    the site itself.
//  - location / employmentType / applicationEndsRaw / salary: the field
//    evidence dump shows no dedicated element for any of these. We probe
//    common containers on the detail page; whatever is genuinely absent
//    is reported as site_absent with what was searched.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const LISTING_URL = 'https://www.evolveasia.co/layouts/job-list.html';
const COMPANY_NAME = 'Evolve Asia';
const COMPANY_EVIDENCE =
    'page <title> is "Evolve Pvt Ltd"; brand header/footer identifies the site as Evolve Asia; ' +
    'all roles are posted on this site\'s own careers page';

module.exports = {
    preprocessItem(item) { return item; },

    async extract(page, { progress, meta }) {
        console.log('??? [evolveasia] Scraping Evolve Asia jobs...');

        meta.pagesVisited++;
        await loadPage(page, LISTING_URL, { timeout: 60000 });

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            meta.looksBlocked = true;
            console.log('  [evolveasia] looksBlocked=true, aborting');
            return { items: [], meta };
        }

        try {
            await page.waitForSelector('div.job-list__item.icon', { timeout: 15000 });
        } catch (e) { /* fall through -- the harvest below will return [] */ }
        await delay(1200);

        // ---- Stage 1: harvest listing cards ----
        const listing = await page.evaluate((base) => {
            const norm = (s) =>
                (s || '')
                    .replace(/[\u200B-\u200D\uFEFF]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

            const cards = Array.from(document.querySelectorAll('div.job-list__item.icon'));
            return cards.map((card, i) => {
                const titleLink =
                    card.querySelector('h3.title > a') ||
                    card.querySelector('h3.title a') ||
                    card.querySelector('h3 a') ||
                    card.querySelector('a[href]');
                const rawHref = titleLink ? titleLink.getAttribute('href') : null;
                let abs = null;
                if (rawHref && !rawHref.startsWith('#')) {
                    try { abs = new URL(rawHref, base).href; } catch (e) {}
                }
                const titleEl = card.querySelector('h3.title') || card.querySelector('h3');
                const title = norm(
                    titleLink ? titleLink.textContent : (titleEl ? titleEl.textContent : '')
                );
                const pEl = card.querySelector('p');
                const teaser = pEl ? norm(pEl.textContent) : null;
                const id = card.getAttribute('id') || null;
                return { title, href: abs, teaser, id, index: i };
            }).filter((x) => x.title && x.href);
        }, LISTING_URL);

        if (listing.length === 0) {
            meta.listingHits = 0;
            meta.atsEmpty = true;
            console.log('  [evolveasia] extracted 0 (no listing cards)');
            return { items: [], meta };
        }

        // Multiple anchors per card point at the same detail page -- dedupe
        // on the path without hash so we only visit each role once.
        const byUrl = new Map();
        for (const c of listing) {
            const key = c.href.split('#')[0];
            if (!byUrl.has(key)) byUrl.set(key, c);
        }
        const uniqueJobs = Array.from(byUrl.values());
        meta.listingHits = uniqueJobs.length;
        safeDiscovered(progress, uniqueJobs.length);

        const items = [];

        // ---- Stage 2: per-role detail page ----
        for (const job of uniqueJobs) {
            const detailUrl = job.href.split('#')[0];
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                await loadPage(page, detailUrl, { timeout: 60000 });
                await delay(600);

                const detail = await page.evaluate(() => {
                    const norm = (s) =>
                        (s || '')
                            .replace(/[\u200B-\u200D\uFEFF]/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();

                    // Body block -- wizard cited div.col-xsmall-12.col-small-7
                    // (3947 chars on the sample).
                    const bodyEl =
                        document.querySelector('div.col-xsmall-12.col-small-7') ||
                        document.querySelector('main .col-small-7') ||
                        document.querySelector('article');
                    const bodyText = bodyEl ? norm(bodyEl.textContent) : null;

                    // Sidebar probe -- other column of the same grid may hold
                    // location / type metadata.
                    const sidebarEl = document.querySelector('div.col-xsmall-12.col-small-5');
                    const sidebarText = sidebarEl ? norm(sidebarEl.textContent) : null;

                    // Location -- no dedicated element was in the field dump;
                    // probe common class hints on both columns.
                    let location = null;
                    const locSels = [
                        '[class*="location"]',
                        '[class*="Location"]',
                        '[class*="place"]',
                        '[class*="city"]',
                        '[class*="address"]'
                    ];
                    for (const sel of locSels) {
                        const el = document.querySelector(sel);
                        if (!el) continue;
                        const t = norm(el.textContent);
                        if (t && t.length >= 2 && t.length <= 120) { location = t; break; }
                    }

                    // Employment type -- probe sidebar first, then role body,
                    // then page text (last-resort).
                    let employmentType = null;
                    const scanFor = (txt) => {
                        if (!txt) return null;
                        if (/\bfull[\s-]?time\b/i.test(txt)) return 'full-time';
                        if (/\bpart[\s-]?time\b/i.test(txt)) return 'part-time';
                        if (/\bcontract(or)?\b/i.test(txt)) return 'contract';
                        if (/\bintern(ship)?\b/i.test(txt)) return 'internship';
                        return null;
                    };
                    employmentType =
                        scanFor(sidebarText) ||
                        scanFor(bodyText);
                    if (!employmentType) {
                        // Constrained last-resort: only job-title-adjacent
                        // blocks at the top of the page.
                        const heads = Array.from(
                            document.querySelectorAll('header, .job-header, .job-detail, .entry-header')
                        ).map((e) => norm(e.textContent)).join(' ');
                        employmentType = scanFor(heads);
                    }

                    // Application deadline -- no evidence in dump; probe common
                    // class hints only.
                    let applicationEndsRaw = null;
                    const dlSels = [
                        '[class*="deadline"]',
                        '[class*="Deadline"]',
                        '[class*="apply-by"]',
                        '[class*="applyBy"]',
                        '[class*="closing"]',
                        '[class*="last-date"]'
                    ];
                    for (const sel of dlSels) {
                        const el = document.querySelector(sel);
                        if (!el) continue;
                        const t = norm(el.textContent);
                        if (t) { applicationEndsRaw = t; break; }
                    }

                    return {
                        bodyText,
                        sidebarText,
                        location,
                        employmentType,
                        applicationEndsRaw,
                        finalUrl: window.location.href
                    };
                });

                const description = detail.bodyText || job.teaser || null;

                const item = {
                    id: `evolveasia-${job.id || job.index}`,
                    title: job.title,
                    title_status: 'extracted',
                    company: COMPANY_NAME,
                    company_status: 'extracted',
                    company_evidence: COMPANY_EVIDENCE,
                    url: detail.finalUrl || detailUrl,
                    registrationUrl: `${detailUrl}#form-section`,
                    location: detail.location,
                    location_status: detail.location ? 'extracted' : 'site_absent',
                    location_evidence: detail.location
                        ? undefined
                        : 'searched detail page for [class*="location"|"place"|"city"|"address"] and the 5-col sidebar column; no location text found',
                    description,
                    description_status: description ? 'extracted' : 'site_absent',
                    description_evidence: description
                        ? undefined
                        : 'div.col-xsmall-12.col-small-7 yielded no text and listing <p> teaser was empty',
                    employmentType: detail.employmentType,
                    applicationEndsRaw: detail.applicationEndsRaw,
                    salary: null,
                    salary_status: 'site_absent',
                    salary_evidence: 'no salary/compensation element in field dump or on detail page; searched [class*="salary"|"compensation"|"ctc"]',
                    image: null,
                    source: 'evolveasia'
                };

                items.push(item);
            } catch (error) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        if (items.length === 0) meta.atsEmpty = true;

        console.log('  [evolveasia] extracted ' + items.length);
        return { items, meta };
    }
};