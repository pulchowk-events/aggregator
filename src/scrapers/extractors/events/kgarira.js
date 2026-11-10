// Private extractor — gitignored. See ../README.md for the contract.
// 3 paginated listing pages -> per-event detail. JSON-LD-first, HTML fallback.
//
// Selector drift history:
//   2026-11-10: full DOM redesign.
//     Listing:  #event-list > div.common-event-item  →  #search-desktop-list a.S1Kk0a_row[href^="/events/"]
//               (filter to /events/<slug>, excludes /events and category nav)
//     Detail:   .common-ticket-details-container / .sub-details / .action .kgarira-btn  →  dead
//               h1 still works (class changed to .vDK-ZW_title but bare h1 matches)
//               "Buy tickets" anchor → a.vDK-ZW_cta
//     JSON-LD (Event) still present on detail pages — this is the primary
//     data source; HTML fallback only fills gaps.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { pickOne } = require('../../selectors');

const BASE_URL = 'https://kgarira.com/all-events?&search_text=&page=';
const MAX_PAGES = 3;

const SEL = {
    // Listing row anchors — current markup. Container id may change; the
    // a[href] filter is what actually identifies event cards.
    listingRow: [
        '#search-desktop-list a.S1Kk0a_row[href]',
        'a.S1Kk0a_row[href]',
        'a[href^="/events/"]'
    ],
    fallbackTitle: [
        'h1',
        'h1[class*="title"]'
    ],
    fallbackDescription: [
        '[class*="description"] p',
        '[class*="description"]',
        'article p'
    ],
    fallbackImage: [
        'article img',
        '[class*="hero"] img',
        'main img'
    ]
};

async function gatherLinks(page) {
    // Try each selector in order; the first one that yields any /events/<slug>
    // anchors wins.
    for (const sel of SEL.listingRow) {
        const links = await page.evaluate((selector) => {
            const anchors = Array.from(document.querySelectorAll(selector));
            const seen = new Set();
            const out = [];
            for (const a of anchors) {
                const href = a.getAttribute('href') || '';
                // /events/<slug> — one segment only, no trailing slash, no query.
                if (!/^\/events\/[^/]+$/.test(href)) continue;
                if (seen.has(href)) continue;
                seen.add(href);
                out.push(new URL(href, window.location.origin).href);
            }
            return out;
        }, sel);
        if (links.length > 0) return { links, selector: sel };
    }
    return { links: [], selector: null };
}

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
            const url = `${BASE_URL}${pageNum}`;
            console.log(`🕷️ [kgarira] Scraping listing page ${pageNum}`);
            try {
                meta.pagesVisited++;
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(Math.random() * 1000 + 500);
                // Container may differ; wait for any event link or fall through.
                await page.waitForSelector('a[href^="/events/"]', { timeout: 10000 });
            } catch (error) {
                console.warn(`⚠️ [kgarira] Failed to load page ${pageNum}: ${error.message}`);
                continue;
            }

            if (meta.pagesVisited === 1) {
                try {
                    const state = await detectPageState(page);
                    if (state.looksBlocked) {
                        meta.looksBlocked = true;
                        console.warn(`⚠️ [kgarira] listing looks blocked — body snippet: ${JSON.stringify(state.bodySnippet)}`);
                    }
                } catch (e) { /* best-effort */ }
            }

            const { links: eventLinks, selector } = await gatherLinks(page);
            if (selector && selector !== SEL.listingRow[0]) {
                console.warn(`⚠️ [kgarira] listing selector fell back to "${selector}" — update SEL.listingRow[0] when convenient.`);
            }

            meta.listingHits += eventLinks.length;
            console.log(`✅ [kgarira] Found ${eventLinks.length} event link(s) on page ${pageNum}`);
            safeDiscovered(progress, eventLinks.length);

            if (eventLinks.length === 0) {
                // Empty page — this is either the last page or a real problem.
                // Keep going once more in case later pages render differently,
                // but log it.
                console.log(`ℹ️ [kgarira] page ${pageNum} yielded 0 event links`);
            }

            for (const link of eventLinks) {
                try {
                    console.log(`  📄 [kgarira] Scraping event: ${link}`);
                    meta.pagesVisited++;
                    meta.detailPagesVisited++;
                    await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
                    await delay(Math.random() * 1000 + 500);

                    const extracted = await page.evaluate(() => {
                        const getText = (el) => (el ? el.textContent.trim() : null);

                        // ---- JSON-LD first ----
                        let jsonLd = null;
                        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
                            try {
                                const parsed = JSON.parse(script.textContent);
                                // Handle @graph arrays too
                                const candidates = Array.isArray(parsed) ? parsed
                                    : (parsed['@graph'] ? parsed['@graph'] : [parsed]);
                                for (const c of candidates) {
                                    if (c['@type'] === 'Event' || (Array.isArray(c['@type']) && c['@type'].includes('Event'))) {
                                        jsonLd = c;
                                        break;
                                    }
                                }
                                if (jsonLd) break;
                            } catch (e) { /* ignore */ }
                        }

                        if (jsonLd) {
                            let image = jsonLd.image || null;
                            if (Array.isArray(image)) image = image[0] || null;
                            let price = null;
                            const offers = jsonLd.offers;
                            if (Array.isArray(offers) && offers.length > 0) {
                                price = offers[0].price ? `Rs. ${offers[0].price}` : null;
                            } else if (offers && offers.price) {
                                price = `Rs. ${offers.price}`;
                            }
                            const loc = jsonLd.location;
                            const location = (loc && (loc.name || (loc.address && loc.address.streetAddress))) || null;
                            let attendanceMode = 'in-person';
                            if (location && location.toLowerCase().includes('online')) attendanceMode = 'online';
                            else if (location && location.toLowerCase().includes('hybrid')) attendanceMode = 'hybrid';

                            return {
                                source: 'jsonld',
                                title: jsonLd.name || null,
                                description: jsonLd.description || null,
                                image,
                                startDate: jsonLd.startDate || null,
                                endDate: jsonLd.endDate || null,
                                location,
                                price,
                                organizer: (jsonLd.organizer && jsonLd.organizer.name) || 'Kgarira',
                                registrationUrl: (offers && !Array.isArray(offers) && offers.url) || (Array.isArray(offers) && offers[0] && offers[0].url) || null,
                                attendanceMode
                            };
                        }

                        // ---- HTML fallback (for any JSON-LD gaps) ----
                        const title = getText(document.querySelector('h1'));
                        const buyAnchor = Array.from(document.querySelectorAll('a'))
                            .find((a) => /buy\s*tickets?|get\s*tickets?|register/i.test((a.textContent || '').trim()));
                        return {
                            source: 'html',
                            title,
                            description: null,
                            image: null,
                            startDate: null,
                            endDate: null,
                            location: null,
                            price: null,
                            organizer: 'Kgarira',
                            registrationUrl: buyAnchor ? buyAnchor.getAttribute('href') : null,
                            attendanceMode: 'in-person'
                        };
                    });

                    // HTML fallback: if JSON-LD gave no title, try the chain.
                    let title = extracted.title;
                    if (!title) {
                        const t = await pickOne(page, SEL.fallbackTitle, { label: `title (${link})` });
                        title = t.value;
                    }
                    if (!title) {
                        meta.detailParseFailures++;
                        console.warn(`⚠️ [kgarira] no title extracted for ${link}`);
                        continue;
                    }

                    items.push({
                        id: `kgarira-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                        title,
                        description: extracted.description || '',
                        image: extracted.image,
                        date: extracted.startDate || null,
                        endDate: extracted.endDate || null,
                        location: extracted.location || null,
                        price: extracted.price || 'TBD',
                        organizer: extracted.organizer || 'Kgarira',
                        registrationUrl: extracted.registrationUrl || null,
                        url: link,
                        tags: [],
                        attendanceMode: extracted.attendanceMode || 'in-person',
                        source: 'kgarira',
                        featured: false,
                        category: null
                    });
                    console.log(`    ✅ [kgarira] Scraped: ${title} (${extracted.source})`);
                    await delay(1000);
                } catch (error) {
                    if (error.message && error.message.includes('403')) {
                        console.warn(`⚠️ [kgarira] 403 on ${link} – skipping.`);
                        continue;
                    }
                    console.error(`    ❌ [kgarira] Error scraping event ${link}:`, error.message);
                } finally {
                    safeUnitDone(progress);
                }
            }
        }

        return { items, meta };
    }
};
