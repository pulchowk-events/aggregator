// src/scrapers/extractors/jobs/evolveasia.js
// Site: https://www.evolveasia.co/layouts/job-list.html  (Evolve Pvt Ltd careers)
// Verdict: CAREERS_PAGE (this IS the listing page; /careers on the root
// domain links here via "View open positions").
//
// Corrections to the wizard's assumptions:
//   - Site type IS listing-to-detail, but the headline "detail-link pattern
//     /customer-success-executive.html (3 matches)" is really the FIRST of
//     EIGHT job URLs on the page - every role matches `<slug>.html`. See
//     anchorGroups: 8 distinct <slug>.html groups x 3 links each (title,
//     Read More, Apply). We harvest all 8.
//   - "Card wrapper: div.job-list__item.icon (8 instances)" is CORRECT -
//     8/8 childJobHeadingCount = 1.0 jobTitleRatio, clean job-card markup.
//   - Detail title element "H1" is misleading: the sample detail page shows
//     TWO h1s (site hero "Building effective distribution." and section
//     "We're hiring"). The ROLE title lives only in the listing-card
//     <h3 class="title"> - so title is read from the card, not the detail.
//   - "Longest description candidate div.col-xsmall-12.col-small-7 (3947 chars)"
//     is real but that column interleaves site chrome ("What we do",
//     "Technologies we use", "Our areas of interest"). Chrome is stripped
//     before using it; the card <p> excerpt is the fallback.
//   - No OG meta / JSON-LD. Company = "Evolve Pvt. Ltd." from the site title
//     "Evolve Pvt Ltd" and the address block. Location is site-wide:
//     "7th Floor, Trade Tower, Thapathali, Kathmandu".
//
// Selector drift history:
//   2026-11-15: initial extraction. Card selector, apply-btn, and location
//                node all confirmed in listing evidence.
//   2026-11-15: NOTE about href resolution - raw href is
//                "customer-success-executive.html" (no leading slash), yet
//                the browser resolves it to
//                https://www.evolveasia.co/customer-success-executive.html
//                (NOT /layouts/customer-success-executive.html). So we use
//                a.href (browser-resolved) rather than new URL(rel, base),
//                which would incorrectly prefix /layouts/.

const { delay, loadPage } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const EVOLVE_LISTING = 'https://www.evolveasia.co/layouts/job-list.html';
const EVOLVE_COMPANY = 'Evolve Pvt. Ltd.';
const APPLY_SUFFIX = '#form-section';

// Site-chrome blocks that appear interleaved with the job body inside
// div.col-small-7 on the detail page. Strip them so description is
// role-scoped. Patterns anchored on the exact section headings visible in
// the sample detail page.
const CHROME_RES = [
    /Building effective distribution\.[\s\S]*?(?=What we do|Technologies we use|Our areas of interest|We['']?re hiring|$)/i,
    /What we do[\s\S]*?(?=Technologies we use|Our areas of interest|We['']?re hiring|$)/i,
    /Technologies we use[\s\S]*?(?=Our areas of interest|We['']?re hiring|$)/i,
    /Our areas of interest[\s\S]*?(?=We['']?re hiring|Contact|$)/i
];

function cleanChrome(text) {
    if (!text) return text;
    let out = text;
    for (const re of CHROME_RES) out = out.replace(re, ' ');
    return out.replace(/\s+/g, ' ').trim();
}

function parseBodyText(text) {
    const out = {};
    if (!text) return out;

    const employment = text.match(/\b(Full[- ]?Time|Part[- ]?Time|Contract|Internship|Temporary|Freelance)\b/i);
    if (employment) out.employmentType = employment[1].replace(/\s+/g, ' ');

    const mode = text.match(/\b(Remote|On-?site|Hybrid)\b/i);
    if (mode) out.attendanceMode = mode[1].toLowerCase().replace(/-/g, '');

    const level = text.match(/\b(Junior|Mid[- ]?Level|Senior|Lead|Principal|Entry[- ]?Level)\b/i);
    if (level) out.level = level[1].replace(/\s+/g, ' ');

    const experience = text.match(/(\d+\+?\s*(?:yrs?|years?)(?:\s*\+)?)/i);
    if (experience) out.experience = experience[1].trim();

    const deadline = text.match(/(?:Deadline|Apply [Bb]y|Applications? close[sd]?)\s*[:\-]?\s*([^\n|]{3,40})/i);
    if (deadline) out.applicationEndsRaw = deadline[1].trim();

    const salary = text.match(/(?:Salary|Compensation|NPR|Rs\.?)\s*[:\-]?\s*([^\n|]{2,60})/i);
    if (salary) out.salary = salary[1].trim();

    return out;
}

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        // ---- Stage 1: listing ----
        try {
            meta.pagesVisited++;
            await loadPage(page, EVOLVE_LISTING, { waitUntil: 'networkidle2', timeout: 30000 });
            await delay(Math.random() * 700 + 400);
        } catch (err) {
            console.warn(`?? [evolveasia] failed to load listing: ${err.message}`);
            return { items, meta };
        }

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`?? [evolveasia] listing looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) { /* best-effort */ }

        try {
            await page.waitForSelector('div.job-list__item', { timeout: 10000 });
        } catch (e) {
            console.log('  [evolveasia] no job cards rendered');
            return { items, meta };
        }

        const listing = await page.evaluate(() => {
            const clean = (s) => (s ? s.replace(/\s+/g, ' ').trim() : null);

            const cards = Array.from(document.querySelectorAll('div.job-list__item.icon'));
            const out = [];

            // Site-wide location (identical for every role on this site).
            const locEl = document.querySelector('[class*="location"], [class*="address"]');
            const siteLocation = locEl ? clean(locEl.textContent) : null;

            for (const card of cards) {
                if (card.closest('header, footer, nav')) continue;

                const titleA = card.querySelector('h3.title a, h3 a[href], h1 a[href], h2 a[href]');
                const title = clean(titleA ? titleA.textContent : null);
                if (!title || title.length < 3 || title.length > 160) continue;

                // Browser-resolved absolute href - critical because raw href
                // is relative and resolves against the site root, not
                // /layouts/.
                let detailUrl = null;
                if (titleA) {
                    try { detailUrl = titleA.href; } catch (_) { /* ignore */ }
                }

                // Apply CTA (same card, apply-btn  <detailUrl>#form-section).
                const applyA = card.querySelector('a.apply-btn[href], a[href*="#form-section"]');
                let applyUrl = null;
                if (applyA) {
                    try { applyUrl = applyA.href; } catch (_) { /* ignore */ }
                }

                // Card excerpt <p> - brief role summary, always role-specific.
                const excerptEl = card.querySelector('p');
                const excerpt = excerptEl ? clean(excerptEl.textContent) : null;

                const cardId = card.id || null;

                out.push({ title, detailUrl, applyUrl, excerpt, cardId });
            }

            return { cards: out, siteLocation };
        });

        const cards = listing.cards || [];
        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);

        if (cards.length === 0) {
            console.log('  [evolveasia] extracted 0 (no job cards)');
            return { items, meta };
        }

        // ---- Stage 2: per-detail enrichment ----
        for (const card of cards) {
            try {
                let detailDescription = null;
                let detailLen = 0;

                if (card.detailUrl) {
                    try {
                        meta.pagesVisited++;
                        meta.detailPagesVisited++;
                        await loadPage(page, card.detailUrl, { waitUntil: 'networkidle2', timeout: 25000 });
                        await delay(Math.random() * 600 + 400);

                        const extracted = await page.evaluate((cardTitle) => {
                            const clean = (s) => (s ? s.replace(/\s+/g, ' ').trim() : null);

                            // 1) Whole col-small-7 column - chrome stripped below.
                            const col = document.querySelector('div.col-xsmall-12.col-small-7, .col-small-7');
                            const colText = col ? clean(col.innerText) : null;

                            // 2) "We're hiring" section - prefer content after it.
                            const hireH = Array.from(document.querySelectorAll('h1, h2, h3'))
                                .find((h) => /we['']?re hiring/i.test(h.textContent || ''));
                            let afterHire = null;
                            if (hireH) {
                                let block = hireH.parentElement;
                                for (let i = 0; i < 4 && block; i++) {
                                    const t = clean(block.innerText);
                                    if (t && t.length > 100) break;
                                    block = block.parentElement;
                                }
                                if (block) afterHire = clean(block.innerText);
                            }

                            // 3) Role-title heading, when the detail page repeats it.
                            let roleBlockText = null;
                            if (cardTitle) {
                                const roleH = Array.from(document.querySelectorAll('h2, h3, h4'))
                                    .find((h) => {
                                        const t = (h.textContent || '').trim();
                                        return t.length > 3 && t.toLowerCase() === cardTitle.toLowerCase();
                                    });
                                if (roleH) {
                                    let b = roleH.parentElement;
                                    for (let i = 0; i < 5 && b; i++) {
                                        const t = clean(b.innerText);
                                        if (t && t.length > 100) { roleBlockText = t; break; }
                                        b = b.parentElement;
                                    }
                                }
                            }

                            return { colText, afterHire, roleBlockText };
                        }, card.title);

                        const candidates = [extracted.roleBlockText, extracted.afterHire, extracted.colText]
                            .map((t) => cleanChrome(t))
                            .map((t) => (t && t.length >= 150 ? t : null))
                            .filter(Boolean)
                            .sort((a, b) => b.length - a.length);

                        if (candidates[0]) {
                            detailDescription = candidates[0];
                            detailLen = candidates[0].length;
                        }
                    } catch (err) {
                        console.warn(`?? [evolveasia] detail failed for ${card.detailUrl}: ${err.message}`);
                    }
                }

                // Description: prefer detail text; fall back to card excerpt.
                const description = detailDescription
                    || (card.excerpt && card.excerpt.length >= 20 ? card.excerpt : null);
                const descriptionEvidence = detailDescription
                    ? `role-specific block on detail page (col-small-7 / "We're hiring" section, chrome stripped; ${detailLen} chars)`
                    : (card.excerpt
                        ? 'listing card <p> excerpt (detail-page body looked like site chrome after filtering)'
                        : 'no description on detail page or card');

                const parsed = parseBodyText(description || '');

                const itemUrl = card.detailUrl || EVOLVE_LISTING;
                const registrationUrl = card.applyUrl
                    || (card.detailUrl ? `${card.detailUrl}${APPLY_SUFFIX}` : EVOLVE_LISTING);

                items.push({
                    id: `evolveasia-${card.cardId || (card.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
                    title: card.title,
                    company: EVOLVE_COMPANY,
                    company_status: 'extracted',
                    company_evidence: 'site title "Evolve Pvt Ltd" and address block "Evolve Pvt. Ltd. 7th Floor, Trade Tower, ."',
                    description: description || null,
                    description_status: description ? 'extracted' : 'extraction_failed',
                    description_evidence: descriptionEvidence,
                    date: null,
                    time: null,
                    location: listing.siteLocation || null,
                    location_status: listing.siteLocation ? 'extracted' : 'site_absent',
                    location_evidence: listing.siteLocation
                        ? '[class*="location"] / [class*="address"] block on the listing page'
                        : 'no [class*="location"] or [class*="address"] element found',
                    price: null,
                    organizer: EVOLVE_COMPANY,
                    category: null,
                    tags: [parsed.employmentType, parsed.level, parsed.attendanceMode].filter(Boolean),
                    image: null,
                    image_status: 'site_absent',
                    image_evidence: 'no per-item img inside div.job-list__item.icon and none on sample detail page',
                    url: itemUrl,
                    registrationUrl,
                    attendanceMode: parsed.attendanceMode || 'in-person',
                    source: 'evolveasia',
                    employmentType: parsed.employmentType || null,
                    employmentType_status: parsed.employmentType ? 'extracted' : 'site_absent',
                    employmentType_evidence: parsed.employmentType
                        ? 'Full/Part/Contract/Internship token in detail body'
                        : 'no employment-type token in detail body or card excerpt',
                    applicationEndsRaw: parsed.applicationEndsRaw || null,
                    applicationEnds_status: parsed.applicationEndsRaw ? 'extracted' : 'site_absent',
                    applicationEnds_evidence: parsed.applicationEndsRaw
                        ? 'Deadline/Apply by label in detail body'
                        : 'no Deadline/Apply by label in detail body or card excerpt',
                    salary: parsed.salary || null,
                    salary_status: parsed.salary ? 'extracted' : 'site_absent',
                    salary_evidence: parsed.salary
                        ? 'salary/compensation/NPR string in detail body'
                        : 'no salary/compensation string in detail body or card excerpt',
                    experience: parsed.experience || null,
                    level: parsed.level || null
                });
            } catch (err) {
                meta.detailParseFailures++;
                console.warn(`?? [evolveasia] item build failed for ${card.detailUrl || card.title}: ${err.message}`);
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`  [evolveasia] extracted ${items.length}`);
        return { items, meta };
    }
};