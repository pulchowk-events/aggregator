// Site-specific extractor. See ../README.md for the contract.
// Structural shape: 9 category-listing pages -> per-event detail page.
// Per-link navigation, per-unit progress in finally blocks.
//
// Selector drift history:
//   2026-11-10: listing card class group block -> group flex min-w-0 flex-col w-full
//   2026-11-10: detail h1 no longer has text-xl/font-black — current
//               class is text-display-xl font-bold. Note "text-display-xl"
//               does NOT contain the substring "text-xl", so a
//               [class*="text-xl"] fallback misses it; explicit
//               text-display entry is required.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne, pickAll } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const KATAJAAM_BASE_URL = 'https://katajaam.com/events/category/';
const KATAJAAM_CATEGORIES = [
    'music', 'food', 'sports', 'nightlife', 'art',
    'outdoors', 'tech', 'education', 'cultural'
];

const SEL = {
    listingCard: [
        'a.group.flex[href^="/events/"]',
        'a.group.block[href^="/events/"]',
        'a[class*="group"][href^="/events/"]'
    ],
    title: [
        'h1.text-display-xl.font-bold',
        'h1[class*="text-display"]',
        'h1[class*="font-bold"]',
        'h1.text-xl.md\\:text-2xl.font-black',
        'h1[class*="font-black"]'
    ]
};

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        for (const category of KATAJAAM_CATEGORIES) {
            console.log(`🕷️ [katajaam] Scraping category: ${category}`);
            const categoryUrl = `${KATAJAAM_BASE_URL}${category}`;

            try {
                meta.pagesVisited++;
                await page.goto(categoryUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(Math.random() * 1000 + 500);
            } catch (error) {
                console.warn(`⚠️ [katajaam] Failed to load category ${category}: ${error.message}`);
                continue;
            }

            if (meta.pagesVisited === 1) {
                try {
                    const state = await detectPageState(page);
                    if (state.looksBlocked) {
                        meta.looksBlocked = true;
                        console.warn(`⚠️ [katajaam] listing looks blocked — body snippet: ${JSON.stringify(state.bodySnippet)}`);
                    }
                } catch (e) { /* best-effort */ }
            }

            try {
                await page.waitForSelector('div.grid', { timeout: 10000 });
            } catch (e) {
                console.log(`⚠️ [katajaam] No events grid for category: ${category}`);
                continue;
            }

            const listing = await pickAll(page, SEL.listingCard, { label: `listing ${category}` });
            meta.listingHits += listing.count;
            const eventLinks = listing.values.filter((href) => !href.includes('?'));

            console.log(`✅ [katajaam] Found ${eventLinks.length} events in category ${category}`);
            safeDiscovered(progress, eventLinks.length);

            for (const link of eventLinks) {
                try {
                    console.log(`  📄 [katajaam] Scraping event: ${link}`);
                    meta.pagesVisited++;
                    meta.detailPagesVisited++;
                    await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
                    await delay(Math.random() * 1000 + 500);

                    const titleResult = await pickOne(page, SEL.title, { label: `detail title (${link})` });

                    const extras = await page.evaluate((category) => {
                        const getText = (el) => (el ? el.textContent.trim() : null);
                        const findDdForDt = (label) => {
                            const dts = document.querySelectorAll('dl div.contents dt');
                            for (const dt of dts) {
                                if (dt.textContent.trim().toLowerCase() === label.toLowerCase()) {
                                    const dd = dt.parentElement.querySelector('dd');
                                    if (dd) return getText(dd);
                                }
                            }
                            return null;
                        };

                        const imgEl = Array.from(document.querySelectorAll('button.relative img'))
                            .find((img) => img.getAttribute('aria-hidden') !== 'true');
                        const image = imgEl ? window.__resolveImageSrc(imgEl) : null;

                        const badge = document.querySelector('span.text-white.text-\\[10px\\]');
                        const categoryFromPage = badge ? getText(badge) : null;

                        let dateTime = findDdForDt('when');
                        if (!dateTime) {
                            const dateEl = document.querySelector('.flex.items-center.gap-2 span.font-semibold');
                            dateTime = dateEl ? getText(dateEl.closest('.flex.items-center')) : null;
                        }

                        const locationLink = document.querySelector('a.flex.items-center.gap-2.group span.text-\\[\\#2D2D3A\\]');
                        let location = locationLink ? getText(locationLink) : null;
                        if (!location) location = findDdForDt('where');

                        const priceEl = document.querySelector('.flex.items-center.gap-2 .font-semibold.text-\\[\\#4CAF50\\]');
                        let price = priceEl ? getText(priceEl) : null;
                        if (!price) price = findDdForDt('price');

                        const aboutDiv = document.querySelector('.mb-5');
                        let description = null;
                        if (aboutDiv) {
                            const p = aboutDiv.querySelector('p.text-sm.text-\\[\\#2D2D3A\\]') || aboutDiv.querySelector('p');
                            if (p) description = getText(p);
                        }

                        return {
                            image,
                            categoryFromPage,
                            date: dateTime,
                            location,
                            price,
                            description,
                            finalUrl: window.location.href
                        };
                    }, category);

                    if (!titleResult.value) {
                        meta.detailParseFailures++;
                        console.warn(`⚠️ [katajaam] detail title extraction failed for ${link} — all selectors returned empty.`);
                        continue;
                    }

                    items.push({
                        id: `katajaam-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                        title: titleResult.value,
                        image: extras.image,
                        category: extras.categoryFromPage || category,
                        date: extras.date,
                        location: extras.location,
                        price: extras.price || 'TBD',
                        description: extras.description,
                        organizer: 'Kata Jaam',
                        registrationUrl: extras.finalUrl,
                        url: extras.finalUrl,
                        attendanceMode: (extras.location && extras.location.toLowerCase().includes('online')) ? 'online' : 'in-person',
                        source: 'katajaam',
                        tags: [extras.categoryFromPage || category].filter(Boolean),
                        featured: false
                    });
                    console.log(`    ✅ [katajaam] Scraped: ${titleResult.value}`);
                    await delay(1000);
                } catch (error) {
                    if (error.message && error.message.includes('403')) {
                        console.warn(`⚠️ [katajaam] 403 on ${link} – skipping.`);
                        continue;
                    }
                    console.error(`    ❌ [katajaam] Error scraping event ${link}:`, error.message);
                } finally {
                    safeUnitDone(progress);
                }
            }
        }

        return { items, meta };
    }
};
