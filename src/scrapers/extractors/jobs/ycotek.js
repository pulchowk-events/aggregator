// src/scrapers/extractors/jobs/ycotek.js
// Ycotek careers - the open roles are listed inline on the careers page
// itself (the "Current open roles" block, anchor target "#career-list").
// There are no per-role detail pages in the evidence dump, so this is a
// single-page harvest even though the batch labelled the site
// listing-to-detail. We anchor on the observed h3.career-title heading
// ("Current open roles") and parse each role card from its text lines.
//
// Limitations:
//   Role cards expose no description body on the listing - description
//    is left null.
//   "Posted: 1mo ago" is relative and not parseable as a date; we use
//    the "Apply before: ..." line as date when present, otherwise null.
//   Location is only captured when the card text explicitly names a
//    city/remote/hybrid/on-site marker.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { sanitizeImageUrl } = require('../../sanitize');

const CAREERS_URL = 'https://ycotek.com/careers-at-yco/';

module.exports = {
    preprocessItem(item) {
        if (item.image) item.image = sanitizeImageUrl(item.image) || null;
        return item;
    },

    async extract(page, { progress, meta }) {
        console.log('??? [ycotek] Scraping Ycotek careers...');

        meta.pagesVisited++;
        await page.goto(CAREERS_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('[ycotek] page looks blocked:', (state.bodySnippet || '').slice(0, 200));
            meta.looksBlocked = true;
            return { items: [], meta };
        }

        try {
            await page.waitForSelector('h3.career-title', { timeout: 15000 });
        } catch (e) {
            console.warn('[ycotek] "Current open roles" heading did not appear within 15s');
        }
        await delay(1500);

        const raw = await page.evaluate(() => {
            const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();
            const abs = (href) => {
                try { return href ? new URL(href, window.location.origin).href : null; }
                catch (e) { return null; }
            };

            // Anchor on the observed heading. The page's own CTA points
            // at "#career-list", so fall back there, then to <body>.
            const heading = Array.from(document.querySelectorAll('h3.career-title'))
                .find((h) => /current open roles/i.test(h.textContent || ''));
            const scope = heading
                ? (heading.closest('section') || heading.parentElement)
                : (document.querySelector('#career-list') || document.body);
            if (!scope) return [];

            // Role cards are the innermost elements containing both an
            // "N OPENING" marker and a "Posted:" line.
            const all = Array.from(scope.querySelectorAll('*'));
            const matches = all.filter((el) => {
                const t = clean(el.innerText || el.textContent);
                return /\b\d+\s+OPENING/i.test(t) && /Posted\s*:/i.test(t) && t.length < 1500;
            });
            // Keep only innermost matches so ancestors don't duplicate cards.
            const cards = matches.filter((el) =>
                !matches.some((other) => other !== el && el.contains(other))
            );

            return cards.map((card) => {
                const text = (card.innerText || card.textContent || '').replace(/\r/g, '');
                const lines = text.split('\n').map(clean).filter(Boolean);

                const META_LINE = /^(current open roles|\d+\s+OPENING|FULL\s*TIME|PART\s*TIME|CONTRACT|INTERNSHIP|Posted\s*:|Apply before\s*:)/i;
                const titleLine = lines.find((l) => !META_LINE.test(l));
                const title = titleLine || lines[0] || null;

                const employment = (text.match(/\b(Full[- ]?time|Part[- ]?time|Contract|Internship)\b/i) || [])[1] || null;
                const postedMatch = text.match(/Posted\s*:\s*([^\n]+)/i);
                const applyMatch = text.match(/Apply before\s*:\s*([^\n]+)/i);

                const locMatch = text.match(/\b(Remote|Hybrid|On-?site|Minneapolis|MN|USA|United States|Kathmandu|Nepal|Lalitpur|Bhaktapur|Pokhara)\b/i);

                let href = null;
                const anchors = Array.from(card.querySelectorAll('a[href]'));
                const applyAnchor = anchors.find((a) =>
                    /apply|view|details|learn more/i.test((a.textContent || '') + ' ' + (a.getAttribute('href') || ''))
                );
                const chosen = applyAnchor || anchors.find((a) => {
                    const h = a.getAttribute('href') || '';
                    return h && h !== '#' && !h.startsWith('javascript:');
                });
                if (chosen) href = abs(chosen.getAttribute('href'));

                let image = null;
                const img = card.querySelector('img');
                if (img && typeof window.__resolveImageSrc === 'function') {
                    image = window.__resolveImageSrc(img);
                }

                return {
                    title,
                    employment,
                    posted: postedMatch ? clean(postedMatch[1]) : null,
                    applyBefore: applyMatch ? clean(applyMatch[1]) : null,
                    location: locMatch ? locMatch[1] : null,
                    href,
                    image,
                };
            }).filter((x) => x.title);
        });

        console.log(`? [ycotek] found ${raw.length} role card(s)`);
        safeDiscovered(progress, raw.length);

        const now = Date.now();
        const items = [];

        for (let i = 0; i < raw.length; i++) {
            try {
                const r = raw[i];
                if (!r.title) continue;

                let attendanceMode = null;
                const locLower = (r.location || '').toLowerCase();
                if (locLower.includes('remote')) attendanceMode = 'online';
                else if (locLower.includes('hybrid')) attendanceMode = 'hybrid';
                else if (r.location) attendanceMode = 'in-person';

                items.push({
                    id: `ycotek-${now}-${Math.random().toString(36).slice(2, 8)}`,
                    title: r.title,
                    description: null,                 // not exposed on the card
                    date: r.applyBefore || null,       // deadline is the only real date on-card
                    time: null,
                    location: r.location,
                    price: null,                       // jobs have no price
                    organizer: 'Ycotek',
                    category: null,
                    tags: r.employment ? [r.employment] : [],
                    image: r.image || null,
                    url: r.href || CAREERS_URL,
                    registrationUrl: r.href || CAREERS_URL,
                    attendanceMode,
                    company: 'Ycotek',
                    source: 'ycotek',
                });
            } catch (err) {
                console.error('[ycotek] failed to build item:', err);
            } finally {
                safeUnitDone(progress);
            }
        }

        meta.listingHits = items.length;
        console.log(`? [ycotek] extracted ${items.length} role(s)`);

        return { items, meta };
    },
};