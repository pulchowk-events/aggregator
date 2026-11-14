// src/scrapers/extractors/jobs/worldlink.js
// Site-specific extractor. See ../README.md for the contract.
//
// Structural shape corrected from evidence:
//   - Entry /career/ is a real careers listing. It is NOT listing-to-detail
//     for jobs: the detected "/news/" detail pattern was a false positive
//     (site nav links). No verified job-detail page dump was available.
//   - Job cards are `div.career-card` (10 on page 1) with:
//       .career-card__title   -> title
//       .career-card__date    -> "Deadline: <date>"
//       .career-card__detail  -> description paragraph(s)
//       an <a href="...">     -> detail/apply link
//   - Pagination is real: /career/page/2/ (page-param links present).
//   - We extract everything from the listing card. No per-detail navigation
//     because the only detail dump provided was /news/ (wrong page), so any
//     detail selector would be invented.
//
// Selector drift history:
//   2026-11-14: initial. Card wrapper is div.career-card, not meta.
//   2026-11-14: detail link pattern is per-card anchor, not /news/.
//   2026-11-14: pagination is /career/page/N/ (cap at 10 pages).

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const WORLDLINK_BASE_URL = 'https://worldlink.com.np/career/';
const WORLDLINK_MAX_PAGES = 10;

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        for (let pageNum = 1; pageNum <= WORLDLINK_MAX_PAGES; pageNum++) {
            const pageUrl = pageNum === 1
                ? WORLDLINK_BASE_URL
                : `${WORLDLINK_BASE_URL}page/${pageNum}/`;

            try {
                meta.pagesVisited++;
                await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(Math.random() * 1000 + 500);
            } catch (error) {
                console.warn(`?? [worldlink] Failed to load page ${pageNum} (${pageUrl}): ${error.message}`);
                break;
            }

            if (pageNum === 1) {
                try {
                    const state = await detectPageState(page);
                    if (state.looksBlocked) {
                        meta.looksBlocked = true;
                        console.warn(`?? [worldlink] listing looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                        return { items, meta };
                    }
                } catch (e) {
                    // best-effort diagnostics
                }
            }

            try {
                await page.waitForSelector('div.career-card', { timeout: 10000 });
            } catch (e) {
                if (pageNum === 1) {
                    console.log('?? [worldlink] No career cards found on the listing page.');
                }
                break; // no cards => no further pages
            }

            const cards = await page.evaluate(() => {
                const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

                const toAbsolute = (href) => {
                    if (!href) return null;
                    try {
                        return new URL(href, window.location.origin).toString();
                    } catch (_) {
                        return null;
                    }
                };

                return Array.from(document.querySelectorAll('div.career-card')).map((card) => {
                    const titleEl = card.querySelector('.career-card__title')
                        || card.querySelector('[class*="career-card__title"]');
                    const dateEl = card.querySelector('.career-card__date')
                        || card.querySelector('[class*="career-card__date"]');
                    const detailEl = card.querySelector('.career-card__detail')
                        || card.querySelector('[class*="career-card__detail"]');

                    const linkEl = card.querySelector('a[href]');
                    const link = linkEl ? toAbsolute(linkEl.getAttribute('href')) : null;

                    let description = null;
                    if (detailEl) {
                        const paras = Array.from(detailEl.querySelectorAll('p'))
                            .map((p) => norm(p.textContent))
                            .filter(Boolean);
                        description = paras.length ? paras.join(' ') : norm(detailEl.textContent) || null;
                    }

                    return {
                        title: titleEl ? norm(titleEl.textContent) : null,
                        deadline: dateEl ? norm(dateEl.textContent) : null,
                        description,
                        link
                    };
                }).filter((c) => c.title);
            });

            meta.listingHits += cards.length;
            if (!cards.length) break;

            console.log(`? [worldlink] Page ${pageNum}: found ${cards.length} job cards.`);
            safeDiscovered(progress, cards.length);

            for (const card of cards) {
                try {
                    // Deadline text comes as "Deadline: 8 November, 2026"; keep as-is.
                    items.push({
                        id: `worldlink-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                        title: card.title,
                        description: card.description || '',
                        date: card.deadline || null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'WorldLink Communications Ltd.',
                        category: 'Career',
                        tags: ['Career'],
                        image: null,
                        url: card.link || pageUrl,
                        registrationUrl: card.link || null,
                        attendanceMode: null,
                        source: 'worldlink'
                    });
                    console.log(`  ? [worldlink] Scraped job: ${card.title}`);
                } catch (error) {
                    console.error(`  ? [worldlink] Error building job item:`, error.message);
                } finally {
                    safeUnitDone(progress);
                }
            }

            if (pageNum < WORLDLINK_MAX_PAGES) {
                await delay(Math.random() * 1000 + 500);
            }
        }

        return { items, meta };
    }
};