// src/scrapers/extractors/jobs/teslatech.js
// Site-specific extractor. See ../README.md for the contract.
// Structural shape: listing-to-detail. /careers/ renders 35 `div.career-item`
// cards, each with an <h3><a href="https://teslatech.com.np/hiring/<slug>/">
// linking to a per-job detail page. Detail pages carry the description.
//
// Prior attempt timed out at 60s. Causes:
//   - WordPress + Elementor + Tawk widgets keep network busy, so
//     networkidle2 hangs; every goto burned its full timeout.
//   - 35 items x (slow goto + multi-second delay) exceeded the budget.
//
// Fixes applied here:
//   1. `domcontentloaded` + short timeout (12s) on every navigation.
//   2. Tight per-item delay (200ms) instead of multi-second waits.
//   3. Single evaluate per detail page (no extra waitForSelector).
//   4. Hard cap of 40 items so we can never blow the budget.
//   5. Card metadata (Office / Full Time / location) is harvested from
//      the listing up-front so a detail-page failure still yields a
//      usable item (title + tags), keeping listingHits accurate.
//
// Selector drift history:
//   2026-11-14: initial extractor. Card wrapper = div.career-item;
//               title anchor = h3 > a[href^="https://teslatech.com.np/hiring/"];
//               meta = ul.job-nature li items (Office / Full Time / etc.).

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const ENTRY_URL = 'https://teslatech.com.np/careers/';
const ORIGIN = 'https://teslatech.com.np';
const MAX_ITEMS = 40;
const PER_GOTO_TIMEOUT = 12000;

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        // --- Stage 1: load the /careers/ listing -----------------------------
        meta.pagesVisited++;
        try {
            await page.goto(ENTRY_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });
        } catch (error) {
            console.warn(
                `?? [teslatech] listing navigation failed: ${error.message}`
            );
            return { items, meta };
        }
        await delay(600);

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(
                    `?? [teslatech] careers page looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`
                );
                return { items, meta };
            }
        } catch (e) {
            /* best-effort */
        }

        // Wait briefly for at least one career card (short timeout - if
        // WordPress took long to render we still fall through and try
        // to harvest whatever is in the DOM).
        try {
            await page.waitForSelector('div.career-item', { timeout: 8000 });
        } catch (e) {
            console.log(
                '?? [teslatech] career-item cards not observed within 8s - harvesting anyway.'
            );
        }

        // --- Stage 2: harvest cards from the listing -------------------------
        const cards = await page.evaluate(() => {
            const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

            const els = Array.from(
                document.querySelectorAll('div.career-item')
            );

            const out = [];
            const seen = new Set();

            for (const el of els) {
                const titleAnchor =
                    el.querySelector('h3 a[href]') ||
                    el.querySelector('a[href]');
                if (!titleAnchor) continue;

                const href = titleAnchor.getAttribute('href') || '';
                if (!href) continue;
                let abs;
                try {
                    abs = new URL(href, window.location.origin).href;
                } catch (e) {
                    continue;
                }
                if (seen.has(abs)) continue;
                seen.add(abs);

                const title =
                    norm(titleAnchor.getAttribute('title')) ||
                    norm(titleAnchor.textContent);
                if (!title) continue;

                // Meta: job-nature list (Office, Full Time, .)
                const nature = Array.from(
                    el.querySelectorAll('ul.job-nature li')
                )
                    .map((li) => norm(li.textContent))
                    .filter(Boolean);

                // Location: job-meta block, if present (best-effort)
                let location = null;
                const metaBlock = el.querySelector('.job-meta');
                if (metaBlock) {
                    const txt = norm(metaBlock.textContent);
                    const cityMatch = txt.match(
                        /\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Nepal|Remote)\b/i
                    );
                    if (cityMatch) location = cityMatch[1];
                }

                out.push({ title, href: abs, nature, location });
            }

            return out;
        });

        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);
        console.log(
            `? [teslatech] Found ${cards.length} career card(s).`
        );

        if (cards.length === 0) {
            return { items, meta };
        }

        // --- Stage 3: visit each detail page (fast path) ---------------------
        const limited = cards.slice(0, MAX_ITEMS);

        for (const card of limited) {
            let description = null;
            let image = null;
            let finalUrl = card.href;

            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;

                await page.goto(card.href, {
                    waitUntil: 'domcontentloaded',
                    timeout: PER_GOTO_TIMEOUT
                });
                await delay(200);

                const extras = await page.evaluate(() => {
                    const norm = (t) =>
                        (t || '').replace(/\s+/g, ' ').trim();

                    // Description: prefer the main content wrapper used by
                    // this WordPress theme; fall back to <main> / largest div.
                    let description = null;
                    const candidates = [
                        '.career-detail-content',
                        '.job-detail',
                        '.entry-content',
                        'main article',
                        'main'
                    ];
                    for (const sel of candidates) {
                        const el = document.querySelector(sel);
                        if (!el) continue;
                        const txt = norm(el.innerText);
                        if (txt && txt.length > 80) {
                            description = txt;
                            break;
                        }
                    }
                    if (!description) {
                        const divs = Array.from(
                            document.querySelectorAll('div')
                        );
                        divs.sort(
                            (a, b) =>
                                b.innerText.length - a.innerText.length
                        );
                        if (divs[0]) {
                            const txt = norm(divs[0].innerText);
                            if (txt && txt.length > 80) description = txt;
                        }
                    }

                    let image = null;
                    const root =
                        document.querySelector('main') || document.body;
                    for (const img of Array.from(
                        root.querySelectorAll('img')
                    )) {
                        const src = window.__resolveImageSrc(img);
                        if (!src) continue;
                        if (/logo|icon|sprite|placeholder/i.test(src))
                            continue;
                        image = src;
                        break;
                    }

                    return {
                        description,
                        image,
                        finalUrl: window.location.href
                    };
                });

                description = extras.description;
                image = extras.image;
                finalUrl = extras.finalUrl || card.href;
            } catch (error) {
                // Detail failed - still emit an item from the listing data.
                console.warn(
                    `    ?? [teslatech] detail failed for ${card.href}: ${error.message}`
                );
            }

            try {
                const tags = card.nature.slice();
                const lowerNature = tags.map((t) => t.toLowerCase());
                let attendanceMode = 'in-person';
                if (lowerNature.some((t) => t.includes('remote')))
                    attendanceMode = 'online';
                else if (lowerNature.some((t) => t.includes('hybrid')))
                    attendanceMode = 'hybrid';

                items.push({
                    id: `teslatech-${Date.now()}-${Math.random()
                        .toString(36)
                        .slice(2, 11)}`,
                    title: card.title,
                    description: description || null,
                    date: null,
                    time: null,
                    location: card.location || 'Lalitpur, Nepal',
                    price: null,
                    organizer: 'Teslatech',
                    category: null,
                    tags,
                    image: image || null,
                    url: finalUrl,
                    registrationUrl: finalUrl,
                    attendanceMode,
                    source: 'teslatech'
                });

                console.log(
                    `    ? [teslatech] Scraped: ${card.title}`
                );
            } catch (err) {
                console.error(
                    `    ? [teslatech] build error for "${card.title}": ${err.message}`
                );
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};