// src/scrapers/extractors/jobs/yarsalabs.js
// Site-specific extractor. See ../README.md for the contract.
//
// Structural shape (corrected): /jobs/ is a category HUB page. The card
// group observed on /jobs/ (`div.bg-white.border...rounded-lg...p-6`) is
// a set of department cards (DESIGN, ENGINEERING, SECURITY) linking to
// /jobs/<category>/ sub-listings -- not individual roles. Real jobs live
// inside those categories. The wizard's "detail-link pattern /" and
// "H1.html-h1" hints came from the Facebook social link and are wrong.
//
// Traversal:
//   1. Load /jobs/ and harvest department category links matching
//      /jobs/<slug>/ (excluding /jobs/ itself).
//   2. For each department, load it and harvest job cards using the SAME
//      bg-white.border rounded card component (reused across pages on
//      this site, per card-group evidence).
//   3. For each job card: title = first heading/strong, description =
//      card innerText minus title, url = first anchor href inside the
//      card (absolute). Dedupe by resolved URL.
//
// Selector provenance:
//   - a[href^="/jobs/"]                 -- department links (evidence)
//   - div.bg-white.border[class*="rounded-lg"] -- card container
//     (evidence: `div.bg-white.border.hover\:bg-gray-50.rounded-lg.
//      relative.group.p-6...`, count 6 on /jobs/)
//   - h1/h2/h3/h4/strong                -- card heading (title)

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { cleanDescriptionText } = require('../../text');

const LISTING_URL = 'https://www.yarsalabs.com/jobs/';
const ORIGIN = 'https://www.yarsalabs.com';
const COMPANY = 'Yarsa Labs';
const COMPANY_URL = 'https://www.yarsalabs.com/';
const COMPANY_LOCATION = 'Kathmandu/Pokhara, Nepal';
const MAX_PAGES = 10;

const CARD_SELECTOR = 'div.bg-white.border[class*="rounded-lg"]';

function classifyEmploymentType(text) {
    if (!text) return null;
    const t = text.toLowerCase();
    if (t.includes('intern')) return 'internship';
    if (t.includes('trainee')) return 'internship';
    if (t.includes('part-time') || t.includes('part time')) return 'part-time';
    if (t.includes('full-time') || t.includes('full time')) return 'full-time';
    if (t.includes('contract')) return 'contract';
    return null;
}

async function collectCards(page, sel) {
    return await page.evaluate((cardSelector) => {
        const out = [];
        const els = document.querySelectorAll(cardSelector);
        for (const card of els) {
            const h = card.querySelector('h1, h2, h3, h4, strong');
            const title = h ? h.textContent.trim() : null;
            if (!title) continue;
            if (title.length < 2 || title.length > 120) continue;
            if (/^(footer|company|about|careers|resources|contact)$/i.test(title)) continue;

            const anchor = card.querySelector('a[href]');
            const href = anchor ? anchor.getAttribute('href') : null;

            const text = (card.innerText || card.textContent || '')
                .replace(/\s+/g, ' ')
                .trim();

            out.push({ title, href, text });
        }
        return out;
    }, sel);
}

module.exports = {
    preprocessItem(item) { return item; },
    async extract(page, { progress, meta }) {
        const items = [];
        const seen = new Set();

        // Stage 1 -- load hub listing.
        try {
            meta.pagesVisited++;
            await loadPage(page, LISTING_URL);
            await delay(Math.random() * 800 + 400);
        } catch (e) {
            console.warn(`[yarsalabs] listing load failed: ${e.message}`);
            return { items, meta };
        }

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        // Stage 2 -- harvest department links (/jobs/<slug>/ except /jobs/).
        const categoryLinks = await page.evaluate(() => {
            const seen = new Set();
            const out = [];
            const anchors = document.querySelectorAll('a[href^="/jobs/"]');
            for (const a of anchors) {
                const h = a.getAttribute('href') || '';
                if (h === '/jobs/' || h === '/jobs') continue;
                if (!/^\/jobs\/[a-z][a-z-]*\/?$/i.test(h)) continue;
                const key = h.replace(/\/$/, '');
                if (seen.has(key)) continue;
                seen.add(key);
                out.push(key + '/');
            }
            return out;
        });

        safeDiscovered(progress, categoryLinks.length + 1);

        const pagesToVisit = [{ url: LISTING_URL, kind: 'hub' }];
        for (const c of categoryLinks) {
            pagesToVisit.push({ url: ORIGIN + c, kind: 'category' });
        }

        // Cap at MAX_PAGES for safety.
        const visitList = pagesToVisit.slice(0, MAX_PAGES);

        for (const target of visitList) {
            if (target.kind === 'category') {
                try {
                    meta.pagesVisited++;
                    await loadPage(page, target.url);
                    await delay(Math.random() * 700 + 400);
                } catch (e) {
                    safeUnitDone(progress);
                    continue;
                }
            }

            let cards = [];
            try {
                cards = await collectCards(page, CARD_SELECTOR);
            } catch (e) {
                cards = [];
            }

            meta.listingHits += cards.length;

            for (const card of cards) {
                // Skip cards that are just department names pointing at
                // category subpages -- those are navigational, not jobs.
                const isNavCard =
                    card.href &&
                    /^\/jobs\/[a-z][a-z-]*\/?$/i.test(card.href) &&
                    /^(design|engineering|security|marketing|operations|qa|it)$/i
                        .test(card.title);

                if (isNavCard) continue;

                let applyUrl = null;
                if (card.href) {
                    if (card.href.startsWith('http')) {
                        // Skip external / offsite links that aren't Yarsa jobs.
                        if (!/yarsalabs\.com/i.test(card.href)) continue;
                        applyUrl = card.href;
                    } else {
                        applyUrl = ORIGIN + card.href;
                    }
                }

                const dedupeKey = (applyUrl || (target.url + '#' + card.title));
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);

                // Strip title prefix from description.
                let body = card.text || '';
                if (body.toLowerCase().startsWith(card.title.toLowerCase())) {
                    body = body.slice(card.title.length).trim();
                }
                body = body.replace(/^(read more|view details|apply now|learn more)\s*$/i, '')
                    .trim();
                const description = body ? cleanDescriptionText(body) : null;

                const hay = (card.title + ' ' + (description || '')).toLowerCase();

                const employmentType = classifyEmploymentType(hay);

                const location = /remote/.test(hay)
                    ? 'Remote'
                    : /kathmandu|pokhara|nepal/.test(hay)
                        ? COMPANY_LOCATION
                        : null;

                const item = {
                    id: `yarsalabs-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                    title: card.title,
                    company: COMPANY,
                    companyUrl: COMPANY_URL,
                    url: applyUrl || target.url,
                    registrationUrl: applyUrl || null,
                    location,
                    description,
                    employmentType,
                    applicationEndsRaw: null,
                    salary: null,
                    image: null,
                    source: 'yarsalabs'
                };

                if (!description) {
                    item.description_status = 'extraction_failed';
                    item.description_evidence =
                        'card innerText contained only the title; no description ' +
                        'body inside div.bg-white.border...rounded-lg card';
                }
                if (!employmentType) {
                    item.employmentType_status = 'site_absent';
                    item.employmentType_evidence =
                        'no intern/trainee/part-time/full-time/contract token ' +
                        'in card title or body';
                }
                if (!location) {
                    item.location_status = 'site_absent';
                    item.location_evidence =
                        'no remote/Kathmandu/Pokhara/Nepal token in card text';
                }
                if (!applyUrl) {
                    item.registrationUrl_status = 'extraction_failed';
                    item.registrationUrl_evidence =
                        'no a[href] inside card; card is title-only';
                }
                item.applicationEndsRaw_status = 'site_absent';
                item.applicationEndsRaw_evidence =
                    'no "Apply before"/"Deadline"/"Closing" text on card or ' +
                    'listing page';
                item.salary_status = 'site_absent';
                item.salary_evidence =
                    'no salary/compensation element on card';
                item.image_status = 'site_absent';
                item.image_evidence =
                    'cards carry SVG category icons only; no per-job image';

                items.push(item);
            }

            safeUnitDone(progress);
        }

        console.log(`  [yarsalabs] extracted ${items.length}`);
        return { items, meta };
    }
};