// src/scrapers/extractors/jobs/daraz.js
// Alibaba Group / Daraz careers - off-campus position list. Filtered to
// Nepal roles locally (the board itself mixes all countries). The card
// wrapper is a CSS-module-generated class observed in the dump
// (`._3lmL_gdWYMhUWDQNGhaNlR`), and each card's title line is
// "<company>-<group>-<brand>-<dept>-<city>-<title>-<city>". We page through
// the site's own pagination (cap MAX_PAGES) then filter to Nepal.
//
// Limitations (documented per contract):
//   Job titles on this board live in a single dashed string, so we
//    heuristic-split on '-' and take the last two segments as
//    title/location. A title that itself contains a '-' would be
//    mis-parsed; sanitizer will flag it.
//   Card detail pages are opened via JS handlers, not clean anchors, so
//    `url` may fall back to the listing URL. Detail-navigation is not
//    required by the site type.
//   Description is not on the card; left null.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { sanitizeImageUrl } = require('../../sanitize');

const LISTING_URL = 'https://careers.daraz.com/en/off-campus/position-list';
const MAX_PAGES = 10;

const CARD_SEL = 'div._3lmL_gdWYMhUWDQNGhaNlR';
const TITLE_LINE_SEL = '._2Z8e50Vfdr6BacCeWiKi2f';

module.exports = {
    preprocessItem(item) {
        if (item.image) item.image = sanitizeImageUrl(item.image) || null;
        return item;
    },

    async extract(page, { progress, meta }) {
        console.log('??? [daraz] Scraping Alibaba/Daraz careers (filtering to Nepal)...');

        meta.pagesVisited++;
        await page.goto(LISTING_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('[daraz] page looks blocked:', (state.bodySnippet || '').slice(0, 200));
            meta.looksBlocked = true;
            return { items: [], meta };
        }

        try {
            await page.waitForSelector(CARD_SEL, { timeout: 15000 });
        } catch (e) {
            console.warn('[daraz] no cards appeared within 15s - will return empty if none harvest');
        }
        await delay(2500);

        const collected = [];
        const seen = new Set();

        for (let p = 1; p <= MAX_PAGES; p++) {
            const pageItems = await page.evaluate((sel, titleSel) => {
                const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();
                const cards = Array.from(document.querySelectorAll(sel));
                return cards.map((card) => {
                    let titleEl = card.querySelector(titleSel);
                    if (!titleEl) {
                        // Fallback: first nested <div> wraps the title line.
                        titleEl = card.querySelector('div');
                    }
                    const rawTitleLine = titleEl ? clean(titleEl.textContent) : '';
                    const fullText = clean(card.textContent);

                    // Anchor-based URL if present; otherwise we have no clean
                    // href (detail pages open via JS on click).
                    let href = null;
                    const a = card.querySelector('a[href]');
                    if (a) {
                        const raw = a.getAttribute('href');
                        if (raw && raw !== '#' && !raw.startsWith('javascript:')) {
                            try { href = new URL(raw, window.location.origin).href; }
                            catch (e) { href = null; }
                        }
                    }
                    if (!href) {
                        const dh = card.getAttribute('data-href') || card.getAttribute('data-url');
                        if (dh) {
                            try { href = new URL(dh, window.location.origin).href; }
                            catch (e) {}
                        }
                    }

                    let image = null;
                    const img = card.querySelector('img');
                    if (img && typeof window.__resolveImageSrc === 'function') {
                        image = window.__resolveImageSrc(img);
                    }

                    return { rawTitleLine, fullText, href, image };
                });
            }, CARD_SEL, TITLE_LINE_SEL);

            for (const it of pageItems) {
                const key = (it.rawTitleLine || it.fullText || '').trim();
                if (!key || seen.has(key)) continue;
                seen.add(key);
                collected.push(it);
            }

            // Advance to next page if pagination is available.
            const advanced = await page.evaluate(() => {
                const isDisabled = (el) =>
                    el.hasAttribute('disabled') ||
                    /disabled/i.test(el.className || '') ||
                    el.getAttribute('aria-disabled') === 'true';

                const candidates = Array.from(document.querySelectorAll(
                    'button, a, [role="button"], li, span'
                ));
                for (const el of candidates) {
                    if (isDisabled(el)) continue;
                    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                    const text = (el.textContent || '').trim().toLowerCase();
                    if (
                        text === 'next' || text === '>' || text === '>' || text === '' ||
                        aria.includes('next')
                    ) {
                        el.click();
                        return true;
                    }
                }
                // Fallback: numeric page buttons, click the one after current.
                const nums = Array.from(document.querySelectorAll('a, button, li'))
                    .filter((el) => /^\d+$/.test((el.textContent || '').trim()));
                const current = nums.find((el) => /active|current|selected/i.test(el.className || ''));
                if (current) {
                    const cur = parseInt(current.textContent.trim(), 10);
                    const nextBtn = nums.find((el) => parseInt(el.textContent.trim(), 10) === cur + 1);
                    if (nextBtn) { nextBtn.click(); return true; }
                }
                return false;
            });

            if (!advanced) break;
            meta.pagesVisited++;
            await delay(2500);
        }

        // Parse title + location out of the dashed title line, keep only
        // Nepal-related roles.
        const nepalItems = [];
        for (const it of collected) {
            const line = (it.rawTitleLine || '').trim();
            const parts = line.split('-').map((s) => s.trim()).filter(Boolean);
            let title = null;
            let location = null;
            if (parts.length >= 2) {
                location = parts[parts.length - 1];
                title = parts[parts.length - 2];
            } else if (parts.length === 1) {
                title = parts[0];
            }

            const hay = `${line} ${it.fullText || ''}`.toLowerCase();
            const isNepal = /kathmandu|nepal|lalitpur|bhaktapur|pokhara|birgunj|itahari|chitwan/.test(hay);
            if (!isNepal) continue;
            if (!title) continue;

            const locMatch = (location || '').match(/kathmandu|nepal|lalitpur|bhaktapur|pokhara|birgunj|itahari|chitwan/i);
            const normalizedLocation = locMatch ? locMatch[0] : (location || 'Nepal');

            nepalItems.push({
                title,
                location: normalizedLocation,
                url: it.href || LISTING_URL,
                image: it.image || null,
                rawLine: line,
            });
        }

        safeDiscovered(progress, nepalItems.length);

        const now = Date.now();
        const items = [];

        for (let i = 0; i < nepalItems.length; i++) {
            try {
                const r = nepalItems[i];
                if (!r.title) continue;
                items.push({
                    id: `daraz-${now}-${Math.random().toString(36).slice(2, 8)}`,
                    title: r.title,
                    description: null,          // not exposed on the listing card
                    date: null,                 // no posted/deadline date on cards
                    time: null,
                    location: r.location,
                    price: null,                // jobs have no price
                    organizer: 'Alibaba Group / Daraz',
                    category: null,             // site doesn't tag a single category per card
                    tags: [],
                    image: r.image,
                    url: r.url,
                    registrationUrl: r.url,
                    attendanceMode: 'in-person',
                    company: 'Daraz',
                    source: 'daraz',
                });
            } catch (err) {
                console.error('[daraz] failed to build item:', err);
            } finally {
                safeUnitDone(progress);
            }
        }

        meta.listingHits = items.length;
        console.log(`? [daraz] ${items.length} Nepal role(s) from ${collected.length} card(s) harvested`);

        // Empty result is valid (Nepal may have no openings).
        return { items, meta };
    },
};