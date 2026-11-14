// Site-specific extractor. See ../README.md for the contract.
// 3 category pages -> per-event detail. JSON-LD-first, HTML fallback.
// Registration URL discovery uses anchor-click / new-tab detection and is
// not migrated to pickOne (it's an interaction, not a DOM read).

const { delay } = require('../../page');
const { cleanNepVentsDescription } = require('../../text');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const CATEGORIES = [
    { name: 'hackathons', url: 'https://www.nepvents.com/hackathons' },
    { name: 'workshops',  url: 'https://www.nepvents.com/workshops' },
    { name: 'community',  url: 'https://www.nepvents.com/community' }
];

const SEL = {
    fallbackTitle: [
        'h1.text-2xl.md\\:text-3xl.font-bold',
        'h1[class*="text-3xl"]',
        'h1[class*="font-bold"]',
        'h1'
    ]
};

module.exports = {
    preprocessItem(item) {
        if (item && item.description) {
            item.description = cleanNepVentsDescription(item.description);
        }
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        for (const category of CATEGORIES) {
            console.log(`🕷️ [nepvents] Scraping category: ${category.name}`);
            try {
                meta.pagesVisited++;
                await page.goto(category.url, { waitUntil: 'networkidle2', timeout: 60000 });
                await delay(2000 + Math.random() * 2000);
            } catch (error) {
                console.warn(`⚠️ [nepvents] Failed to load ${category.name}: ${error.message}`);
                continue;
            }

            if (meta.pagesVisited === 1) {
                try {
                    const state = await detectPageState(page);
                    if (state.looksBlocked) {
                        meta.looksBlocked = true;
                        console.warn(`⚠️ [nepvents] listing looks blocked — body snippet: ${JSON.stringify(state.bodySnippet)}`);
                    }
                } catch (e) { /* best-effort */ }
            }

            let containerFound = false;
            for (const sel of ['.events-horizontal-container', 'article.flex', '.event-list', '#__next main']) {
                try {
                    await page.waitForSelector(sel, { timeout: 10000 });
                    containerFound = true;
                    break;
                } catch (e) { /* try next */ }
            }
            if (!containerFound) {
                console.log(`⚠️ [nepvents] No events container for category: ${category.name}`);
                continue;
            }

            const eventLinks = await page.evaluate(() => {
                const cards = document.querySelectorAll('article.flex, .events-horizontal-container article');
                const links = [];
                for (const card of cards) {
                    const link = card.querySelector('a.absolute[href^="/events/"]')
                              || card.querySelector('a[href^="/events/"]');
                    if (link) {
                        const href = link.getAttribute('href');
                        if (href && !href.includes('?')) {
                            links.push(new URL(href, window.location.origin).href);
                        }
                    }
                }
                return links;
            });

            meta.listingHits += eventLinks.length;
            console.log(`✅ [nepvents] Found ${eventLinks.length} events in ${category.name}`);
            safeDiscovered(progress, eventLinks.length);

            for (const link of eventLinks) {
                try {
                    console.log(`  📄 [nepvents] Scraping event: ${link}`);
                    meta.pagesVisited++;
                    meta.detailPagesVisited++;
                    await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
                    await delay(1000 + Math.random() * 1000);

                    let registrationUrl = await page.evaluate(() => {
                        const candidates = document.querySelectorAll(
                            'a[href*="register"], a[href*="ticket"], a[href*="forms.google.com"], a[href*="docs.google.com/forms"]'
                        );
                        for (const el of candidates) {
                            if (el.href && el.href.startsWith('http')) return el.href;
                        }
                        const btn = document.querySelector('#register');
                        if (btn) {
                            const parent = btn.closest('a');
                            if (parent && parent.href) return parent.href;
                        }
                        return null;
                    });

                    if (!registrationUrl) {
                        const registerBtn = await page.$('#register');
                        if (registerBtn) {
                            const navPromise = page.waitForNavigation({ timeout: 5000 }).catch(() => null);
                            await registerBtn.click();
                            const navResult = await navPromise;
                            if (navResult && page.url() !== link) {
                                registrationUrl = page.url();
                            } else {
                                const newTarget = await page.browser().waitForTarget(
                                    (t) => t.url().includes('register')
                                        || t.url().includes('forms.google.com')
                                        || t.url().includes('ticket'),
                                    { timeout: 5000 }
                                ).catch(() => null);
                                if (newTarget) {
                                    const newPage = await newTarget.page();
                                    if (newPage) {
                                        registrationUrl = newPage.url();
                                        await newPage.close();
                                    }
                                }
                            }
                        }
                    }
                    if (!registrationUrl) registrationUrl = link;

                    const extracted = await page.evaluate((categoryName) => {
                        const getText = (el) => (el ? el.textContent.trim().replace(/\\s+/g, ' ') : null);

                        let jsonLd = null;
                        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                        for (const script of scripts) {
                            try {
                                const parsed = JSON.parse(script.textContent);
                                if (parsed['@type'] === 'EducationEvent' || parsed['@type'] === 'Event') {
                                    jsonLd = parsed;
                                    break;
                                }
                            } catch (e) { /* ignore malformed */ }
                        }

                        if (jsonLd) {
                            return {
                                title: jsonLd.name || null,
                                description: jsonLd.description || '',
                                image: Array.isArray(jsonLd.image) ? jsonLd.image[0] : (jsonLd.image || null),
                                startDate: jsonLd.startDate || null,
                                endDate: jsonLd.endDate || null,
                                location: jsonLd.location?.name || jsonLd.location?.address?.streetAddress || null,
                                price: jsonLd.offers?.price
                                    ? (jsonLd.offers.price === '0' ? 'Free' : `Rs. ${jsonLd.offers.price}`)
                                    : null,
                                organizer: jsonLd.organizer?.[0]?.name || jsonLd.organizer?.name || null,
                                tags: jsonLd.keywords ? jsonLd.keywords.split(',').map((k) => k.trim().toLowerCase()) : [],
                                attendanceMode: (jsonLd.eventAttendanceMode && jsonLd.eventAttendanceMode.includes('Online')) ? 'online' : 'in-person',
                                categoryName
                            };
                        }

                        const title = getText(document.querySelector('h1.text-2xl.md\\\\:text-3xl.font-bold')) || getText(document.querySelector('h1'));
                        const description = getText(document.querySelector('div.prose p')) || getText(document.querySelector('div.prose'));
                        const img = document.querySelector('img[alt^="Image for"]');
                        const image = img ? window.__resolveImageSrc(img) : null;
                        const dateEl = document.querySelector('time[datetime]');
                        const startDate = dateEl ? dateEl.getAttribute('datetime') : null;
                        const locationEl = document.querySelector('p.flex-row.items-center svg[viewBox*="10 14"]')?.closest('p');
                        const location = locationEl ? locationEl.textContent.replace(/Location:/i, '').trim() : null;
                        const priceEl = document.querySelector('span:has(svg[viewBox*="64 64"]) + span') || document.querySelector('.bg-violet-100');
                        const price = priceEl ? priceEl.textContent.trim() : null;
                        const organizerEl = document.querySelector('p.flex-row.items-center svg[viewBox*="24 24"]')?.closest('p');
                        const organizer = organizerEl ? organizerEl.textContent.replace(/Organizer:/i, '').trim() : null;
                        const tags = Array.from(document.querySelectorAll('.pill-label')).map((el) => el.textContent.trim().toLowerCase());
                        const attendanceMode = (location && location.toLowerCase().includes('online')) ? 'online' : 'in-person';

                        return {
                            title: title || null,
                            description: description || '',
                            image: image || null,
                            startDate: startDate || null,
                            endDate: null,
                            location: location || null,
                            price: price || null,
                            organizer: organizer || null,
                            tags: tags,
                            attendanceMode: attendanceMode,
                            categoryName
                        };
                    }, category.name);

                    let title = extracted.title;
                    if (!title) {
                        const t = await pickOne(page, SEL.fallbackTitle, { label: `title (${link})` });
                        title = t.value;
                    }

                    if (!title) {
                        meta.detailParseFailures++;
                        console.warn(`⚠️ [nepvents] no title extracted for ${link}`);
                        continue;
                    }

                    items.push({
                        id: `nepvents-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                        title,
                        description: extracted.description || '',
                        image: extracted.image,
                        date: extracted.startDate || null,
                        endDate: extracted.endDate || null,
                        location: extracted.location || null,
                        price: extracted.price || 'TBD',
                        organizer: extracted.organizer || 'NepVents',
                        registrationUrl,
                        url: link,
                        tags: extracted.tags || [],
                        attendanceMode: extracted.attendanceMode || 'in-person',
                        category: category.name,
                        source: 'nepvents',
                        featured: false
                    });
                    console.log(`    ✅ [nepvents] Scraped: ${title}`);
                    await delay(1000);
                } catch (error) {
                    if (error.message && error.message.includes('403')) {
                        console.warn(`⚠️ [nepvents] 403 on ${link} – skipping.`);
                        continue;
                    }
                    console.error(`    ❌ [nepvents] Error scraping event ${link}:`, error.message);
                } finally {
                    safeUnitDone(progress);
                }
            }
        }

        return { items, meta };
    }
};
