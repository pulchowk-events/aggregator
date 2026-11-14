// src/scrapers/extractors/jobs/evolveasia.js
// Site-specific extractor for evolveasia.co/layouts/job-list.html.
// See ../README.md for the contract.
//
// CONFIRMED FROM EVIDENCE:
//   - Card wrapper: div.job-list__item.icon (8 instances), verified by
//     cardCandidates with hasJobishContent:true and jobTitleRatio:1.
//   - Each card has h3.title > a[href="<role>.html"> for the role title,
//     a <p> teaser, a "Read More" link to the same detail page, and an
//     "Apply" link ending in "#form-section" for the application anchor.
//   - The detail page's H1 is the site's global hero ("Building effective
//     distribution."), NOT the job title - we therefore keep the listing
//     card's h3.title as the canonical title and only use the detail
//     page for the full description.
//   - Description on the detail page lives in
//     div.col-xsmall-12.col-small-7 (~3947 chars in evidence).
//   - Role titles have a leading zero-width space (U+200B) - strip it.
//   - No pagination on the listing (hasNextRel false, no load-more).

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const EVOLVE_JOBS_URL = 'https://www.evolveasia.co/layouts/job-list.html';

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        console.log('??? [evolveasia] Scraping Evolve Asia jobs...');

        // ---- Stage 1: listing page ----
        meta.pagesVisited++;
        await page.goto(EVOLVE_JOBS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(1500);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [evolveasia] listing looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        const listing = await page.evaluate((entryUrl) => {
            const clean = (s) => (s ? String(s)
                .replace(/[\u200B-\u200D\uFEFF]/g, '')
                .replace(/\s+/g, ' ')
                .trim() : null);
            const abs = (href) => {
                try { return new URL(href, window.location.origin).href; }
                catch { return null; }
            };

            const out = [];
            const seen = new Set();
            const cards = document.querySelectorAll('div.job-list__item.icon');

            for (const card of cards) {
                try {
                    const titleLink = card.querySelector('h3.title a[href]') ||
                        card.querySelector('h3 a[href]');
                    if (!titleLink) continue;

                    const title = clean(titleLink.textContent);
                    if (!title || title.length < 2 || title.length > 160) continue;

                    const href = abs(titleLink.getAttribute('href'));
                    if (!href) continue;

                    const key = href.toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    // Teaser description from the card body (skip "Read More").
                    let teaser = null;
                    for (const p of card.querySelectorAll('p')) {
                        const t = clean(p.textContent);
                        if (!t) continue;
                        if (/^read more$/i.test(t)) continue;
                        if (t.length > 40) { teaser = t; break; }
                    }

                    // Apply anchor (usually "<role>.html#form-section").
                    const applyEl = card.querySelector('a.apply-btn[href], a[href*="#form-section"]');
                    const applyHref = applyEl ? abs(applyEl.getAttribute('href')) : null;

                    out.push({
                        title,
                        url: href,
                        applyUrl: applyHref || href,
                        teaser,
                    });
                } catch (e) {
                    // skip malformed card
                }
            }
            return out;
        }, EVOLVE_JOBS_URL);

        meta.listingHits = listing.length;
        safeDiscovered(progress, listing.length);
        console.log(`? [evolveasia] found ${listing.length} job listing(s)`);

        if (listing.length === 0) {
            return { items: [], meta };
        }

        // ---- Stage 2: detail pages ----
        for (const l of listing) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await page.goto(l.url, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(700);

                // Detail H1 is the global hero, so still trust the listing
                // card's title. Only pull the description body here.
                const extras = await page.evaluate(() => {
                    const clean = (s) => (s ? String(s)
                        .replace(/[\u200B-\u200D\uFEFF]/g, '')
                        .replace(/\s+/g, ' ')
                        .trim() : null);
                    const stripHtml = (s) => (s
                        ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                        : null);

                    let description = null;
                    const descEl = document.querySelector('div.col-xsmall-12.col-small-7');
                    if (descEl) description = stripHtml(descEl.textContent);

                    // Fallback: longest plausible <section>/<article> that
                    // mentions responsibilities / requirements.
                    if (!description) {
                        let bestLen = 0;
                        for (const d of document.querySelectorAll('section, article, div')) {
                            if (d.closest('nav, header, footer')) continue;
                            if (d.children.length > 40) continue;
                            const txt = d.textContent || '';
                            if (txt.length <= bestLen) continue;
                            if (txt.length < 300 || txt.length > 20000) continue;
                            if (!/responsibilit|requirement|qualification|experience|skills?/i.test(txt)) continue;
                            description = stripHtml(txt);
                            bestLen = txt.length;
                        }
                    }

                    return { description, finalUrl: window.location.href };
                });

                if (!l.title) {
                    meta.detailParseFailures++;
                    console.warn(`?? [evolveasia] missing title for ${l.url}`);
                    continue;
                }

                items.push({
                    id: `evolveasia-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    title: l.title,
                    description: extras.description || l.teaser || null,
                    date: null,
                    time: null,
                    location: null, // per-role location not present in evidence
                    price: null,
                    organizer: 'Evolve Pvt Ltd',
                    category: null,
                    tags: [],
                    image: null,
                    url: extras.finalUrl || l.url,
                    registrationUrl: l.applyUrl || extras.finalUrl || l.url,
                    attendanceMode: null, // not stated in evidence
                    source: 'evolveasia',
                });

                console.log(`    ? [evolveasia] Scraped: ${l.title}`);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(`?? [evolveasia] 403 on ${l.url} - skipping.`);
                } else {
                    console.error(`    ? [evolveasia] Error on ${l.url}:`, error.message);
                }
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`? [evolveasia] extracted ${items.length} item(s)`);
        return { items, meta };
    },
};