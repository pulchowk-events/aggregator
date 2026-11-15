// src/scrapers/extractors/jobs/ycotek.js
// Site-specific extractor. See ../README.md for the contract.
//
// Structural shape (corrected): /careers-at-yco/ is a single-page jobs
// listing. There are no per-job detail URLs -- the wizard's "detail-link
// pattern /" and "span.yco-word card wrapper" hints were noise (yco-word
// is a decorative text-reveal animation, and the anchors are nav links to
// /capabilities/* and /contact/). Each open role renders as a <main>
// <article> with title + "N OPENING" + "FULL TIME" + "Posted: X" +
// "Apply before: <date>" + "APPLY NOW" CTA. Extract straight from each
// article (single-page-cards).
//
// Card selector provenance:
//   main article  -- field evidence: article text =
//     "Senior Data & Analytics Engineer 1 OPENING FULL TIME Posted: 1mo ago
//      Apply before: December 3, 2026 APPLY NOW "

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { cleanDescriptionText } = require('../../text');

const LISTING_URL = 'https://ycotek.com/careers-at-yco/';
const COMPANY = 'Ycotek';
const COMPANY_URL = 'https://ycotek.com/';
const COMPANY_LOCATION = 'Minneapolis, MN, USA';

function classifyEmploymentType(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    if (t.includes('intern')) return 'internship';
    if (t.includes('trainee')) return 'internship';
    if (t.includes('part-time') || t.includes('part time')) return 'part-time';
    if (t.includes('full-time') || t.includes('full time')) return 'full-time';
    if (t.includes('full time')) return 'full-time';
    if (t.includes('contract')) return 'contract';
    return null;
}

module.exports = {
    preprocessItem(item) { return item; },
    async extract(page, { progress, meta }) {
        const items = [];

        try {
            meta.pagesVisited++;
            await loadPage(page, LISTING_URL);
            await delay(Math.random() * 800 + 400);
        } catch (e) {
            console.warn(`[ycotek] listing load failed: ${e.message}`);
            return { items: [], meta };
        }

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items: [], meta };
            }
        } catch (e) { /* best-effort */ }

        const cards = await page.evaluate(() => {
            const out = [];
            const els = document.querySelectorAll('main article');
            for (const art of els) {
                const text = (art.innerText || art.textContent || '')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (!text) continue;
                // Only treat as job card if it carries a deadline/opening
                // signal -- avoids unrelated marketing <article>s.
                if (!/(OPENING|FULL\s*TIME|Apply\s*before|APPLY\s*NOW)/i.test(text)) {
                    continue;
                }

                const heading =
                    art.querySelector('h1, h2, h3, h4, h5, strong') ||
                    null;
                let title = heading ? heading.textContent.trim() : null;

                if (!title) {
                    // Fallback: leading text before the first metadata token.
                    const m = text.match(
                        /^(.*?)\s+(?:\d+\s+OPENING|FULL\s*TIME|PART\s*TIME|INTERN|Posted\s*:)/
                    );
                    if (m) title = m[1].trim();
                }
                if (!title || title.length < 3 || title.length > 120) continue;

                const openingM = text.match(/(\d+)\s+OPENING/i);
                const postedM = text.match(/Posted\s*:\s*([^\s].*?)(?=\s+(?:Apply\s*before|APPLY\s*NOW|$))/i);
                const beforeM = text.match(/Apply\s*before\s*:\s*([A-Za-z]+\s+\d{1,2},?\s*\d{4})/i);

                const applyA = art.querySelector('a[href]');
                const applyHref = applyA ? applyA.getAttribute('href') : null;

                out.push({
                    title,
                    openingCount: openingM ? openingM[1] : null,
                    postedAt: postedM ? postedM[1].trim() : null,
                    applyBefore: beforeM ? beforeM[1].trim() : null,
                    applyHref,
                    text
                });
            }
            return out;
        });

        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);

        for (const card of cards) {
            try {
                // Strip the title from the article text for description.
                let body = card.text || '';
                if (body.toLowerCase().startsWith(card.title.toLowerCase())) {
                    body = body.slice(card.title.length).trim();
                }
                // Remove trailing CTA boilerplate.
                body = body
                    .replace(/APPLY\s*NOW\s*(?:|->)?\s*$/i, '')
                    .replace(/^[\d]+\s+OPENING\s*/i, '')
                    .trim();

                const description = body ? cleanDescriptionText(body) : null;

                const hay = (card.text || '').toLowerCase();
                const employmentType = classifyEmploymentType(card.text);

                let applyUrl = null;
                if (card.applyHref) {
                    applyUrl = card.applyHref.startsWith('http')
                        ? card.applyHref
                        : COMPANY_URL.replace(/\/$/, '') + card.applyHref;
                }

                const item = {
                    id: `ycotek-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                    title: card.title,
                    company: COMPANY,
                    companyUrl: COMPANY_URL,
                    url: LISTING_URL,
                    registrationUrl: applyUrl,
                    location: /minneapolis|minnesota|\bmn\b/i.test(hay)
                        ? COMPANY_LOCATION
                        : null,
                    description,
                    employmentType,
                    applicationEndsRaw: card.applyBefore || null,
                    salary: null,
                    image: null,
                    openings: card.openingCount || null,
                    publishedAt: card.postedAt || null,
                    source: 'ycotek'
                };

                if (!description) {
                    item.description_status = 'extraction_failed';
                    item.description_evidence =
                        'main article body collapsed to empty after stripping title ' +
                        'and APPLY NOW CTA';
                }
                if (!employmentType) {
                    item.employmentType_status = 'site_absent';
                    item.employmentType_evidence =
                        'no FULL TIME / PART TIME / INTERN / CONTRACT token in ' +
                        'main article text';
                }
                if (!card.applyBefore) {
                    item.applicationEndsRaw_status = 'extraction_failed';
                    item.applicationEndsRaw_evidence =
                        'main article text did not contain /Apply before: <Month D, YYYY>/';
                }
                if (!applyUrl) {
                    item.registrationUrl_status = 'extraction_failed';
                    item.registrationUrl_evidence =
                        'no a[href] inside main article for the APPLY NOW CTA';
                }
                if (!item.location) {
                    item.location_status = 'site_absent';
                    item.location_evidence =
                        'no Minneapolis/MN/Minnesota token in article; company ' +
                        'address (2909 S Wayzata Blvd Minneapolis, MN 55405) is ' +
                        'footer chrome, not per-job';
                }
                item.salary_status = 'site_absent';
                item.salary_evidence =
                    'no salary/compensation element on career card';
                item.image_status = 'site_absent';
                item.image_evidence =
                    'career card carries no per-job image; only company-culture ' +
                    'photos in div.cell are page-level';

                items.push(item);
            } catch (e) {
                meta.detailParseFailures++;
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`  [ycotek] extracted ${items.length}`);
        return { items, meta };
    }
};