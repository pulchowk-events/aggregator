// src/scrapers/extractors/jobs/proshore.js
// Site-specific extractor. See ../README.md for the contract.
// Structural shape: Webflow careers page. The listing is organized into
// three tabs (Tech / Operations / Bootcamp) inside div.layout350_content
// blocks. Job cards are loaded dynamically and may need tab interaction,
// scrolling, or extra settle time before the DOM is populated.
//
// Prior attempt failed with dom_drift_listing (0 items after 14s). The
// auto-detector's "5 detail links" were actually navigation anchors
// (/services/*, /themes/*) - no real job cards. Fixes applied here:
//   1. Use domcontentloaded (Webflow keeps analytics sockets open 
//      networkidle2 hangs and might time out or return early).
//   2. Longer settle (3s+) for client-side job fetches.
//   3. Scroll to #current_openings and iterate the whole page.
//   4. Actively click tab triggers ([class*="tab-link"], a[href*="Content-Block"]).
//   5. Harvest job links via broad path patterns (/careers/<slug>, /jobs/<slug>,
//      /vacatures/<slug>, /openings/<slug>, /positions/<slug>).
//   6. Fall back to card harvesting across Webflow collection-list
//      selectors (.w-dyn-item, [class*="job"], [class*="opening"], etc.).
//   7. If /careers is genuinely empty, retry the homepage #current_openings
//      section as a secondary source (some sites centralize openings there).
//
// Selector drift history:
//   2026-11-14: initial robust extractor - multi-strategy harvest.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const ENTRY_URL = 'https://proshore.eu/careers';
const FALLBACK_URL = 'https://proshore.eu/#current_openings';
const ORIGIN = 'https://proshore.eu';

// Paths that are clearly NOT job-detail pages
const NON_JOB_PATH = /\/(services|themes|solutions|case-studies|insights|industries|about|contact|bootcamp|blog)(\/|$)/i;

// Path patterns that DO look like job-detail pages
const JOB_PATH = /^\/(careers?|jobs?|vacatures?|openings?|positions?|vacancy)\/[^/]+/i;

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        // --- Stage 1: load careers page (domcontentloaded to avoid net-idle hang)
        meta.pagesVisited++;
        try {
            await page.goto(ENTRY_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 45000
            });
        } catch (error) {
            console.warn(
                `?? [proshore] initial navigation failed: ${error.message}`
            );
            return { items, meta };
        }

        // Generous settle for Webflow client-side fetches
        await delay(3000);

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(
                    `?? [proshore] careers page looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`
                );
                return { items, meta };
            }
        } catch (e) {
            /* best-effort */
        }

        // --- Stage 2: interact with tabs + scroll to force content load ------
        await interactAndSettle(page);

        // --- Stage 3: primary harvest on /careers -----------------------------
        let jobLinks = await harvestJobLinks(page);
        let cards = [];

        if (jobLinks.length === 0) {
            // No detail links found  try harvesting inline job cards
            cards = await harvestInlineCards(page);
        }

        meta.listingHits = jobLinks.length + cards.length;
        safeDiscovered(progress, meta.listingHits);
        console.log(
            `? [proshore] /careers  ${jobLinks.length} link(s), ${cards.length} inline card(s).`
        );

        // --- Stage 4: fallback to homepage #current_openings if still empty --
        if (jobLinks.length === 0 && cards.length === 0) {
            console.log(
                '?? [proshore] /careers yielded nothing; trying homepage #current_openings fallback.'
            );
            try {
                meta.pagesVisited++;
                await page.goto(FALLBACK_URL, {
                    waitUntil: 'domcontentloaded',
                    timeout: 45000
                });
                await delay(3000);
                await interactAndSettle(page);
                jobLinks = await harvestJobLinks(page);
                if (jobLinks.length === 0) {
                    cards = await harvestInlineCards(page);
                }
                meta.listingHits = jobLinks.length + cards.length;
                safeDiscovered(progress, meta.listingHits);
                console.log(
                    `?? [proshore] fallback  ${jobLinks.length} link(s), ${cards.length} inline card(s).`
                );
            } catch (e) {
                console.warn(
                    `?? [proshore] fallback navigation failed: ${e.message}`
                );
            }
        }

        if (jobLinks.length === 0 && cards.length === 0) {
            console.log('?? [proshore] No openings found - returning empty.');
            return { items, meta };
        }

        // --- Stage 5a: follow per-job detail links ---------------------------
        if (jobLinks.length > 0) {
            const SEL = {
                detailTitle: ['main h1', 'h1.heading-style-h1', 'h1']
            };

            for (const link of jobLinks) {
                try {
                    meta.pagesVisited++;
                    meta.detailPagesVisited++;
                    await page.goto(link.href, {
                        waitUntil: 'domcontentloaded',
                        timeout: 45000
                    });
                    await delay(1200);

                    const titleResult = await pickOne(page, SEL.detailTitle, {
                        label: `detail title (${link.href})`
                    });

                    let title = titleResult.value;
                    if (!title && link.text) title = link.text;

                    if (!title) {
                        meta.detailParseFailures++;
                        console.warn(
                            `?? [proshore] no title for ${link.href}`
                        );
                        continue;
                    }

                    const extras = await page.evaluate(() => {
                        const norm = (t) =>
                            (t || '').replace(/\s+/g, ' ').trim();

                        let description = null;
                        const mainEl =
                            document.querySelector('main') ||
                            document.querySelector('article') ||
                            document.body;
                        const txt = norm(mainEl.innerText);
                        if (txt && txt.length > 100) description = txt;

                        let image = null;
                        const imgs = Array.from(
                            mainEl.querySelectorAll('img')
                        );
                        for (const img of imgs) {
                            const src = window.__resolveImageSrc(img);
                            if (!src) continue;
                            if (/logo|icon|sprite|placeholder/i.test(src))
                                continue;
                            image = src;
                            break;
                        }

                        const bodyText = norm(document.body.innerText).toLowerCase();
                        let location = null;
                        for (const city of [
                            'kathmandu',
                            'pokhara',
                            'lalitpur',
                            'bhaktapur',
                            'biratnagar',
                            'nepal',
                            'netherlands',
                            'amsterdam',
                            'eindhoven',
                            'remote'
                        ]) {
                            if (bodyText.includes(city)) {
                                location =
                                    city.charAt(0).toUpperCase() +
                                    city.slice(1);
                                break;
                            }
                        }

                        let attendanceMode = 'in-person';
                        if (/\bremote\b/i.test(bodyText))
                            attendanceMode = 'online';
                        else if (/\bhybrid\b/i.test(bodyText))
                            attendanceMode = 'hybrid';

                        return {
                            description,
                            image,
                            location,
                            attendanceMode,
                            finalUrl: window.location.href
                        };
                    });

                    items.push({
                        id: `proshore-${Date.now()}-${Math.random()
                            .toString(36)
                            .slice(2, 11)}`,
                        title,
                        description: extras.description || null,
                        date: null,
                        time: null,
                        location: extras.location || null,
                        price: null,
                        organizer: 'Proshore',
                        category: null,
                        tags: [],
                        image: extras.image || null,
                        url: extras.finalUrl || link.href,
                        registrationUrl: extras.finalUrl || link.href,
                        attendanceMode: extras.attendanceMode || 'in-person',
                        source: 'proshore'
                    });

                    console.log(`    ? [proshore] Scraped: ${title}`);
                    await delay(500);
                } catch (error) {
                    if (error.message && error.message.includes('403')) {
                        console.warn(
                            `?? [proshore] 403 on ${link.href} - skipping.`
                        );
                        continue;
                    }
                    console.error(
                        `    ? [proshore] Error on ${link.href}:`,
                        error.message
                    );
                } finally {
                    safeUnitDone(progress);
                }
            }
            return { items, meta };
        }

        // --- Stage 5b: build items from inline cards -------------------------
        for (const card of cards) {
            try {
                items.push({
                    id: `proshore-${Date.now()}-${Math.random()
                        .toString(36)
                        .slice(2, 11)}`,
                    title: card.title,
                    description: card.text || null,
                    date: null,
                    time: null,
                    location: card.location || null,
                    price: null,
                    organizer: 'Proshore',
                    category: null,
                    tags: card.tags || [],
                    image: card.image || null,
                    url: card.url || ENTRY_URL,
                    registrationUrl: card.url || ENTRY_URL,
                    attendanceMode: 'in-person',
                    source: 'proshore'
                });
                console.log(
                    `    ? [proshore] Scraped (inline): ${card.title}`
                );
            } catch (error) {
                console.error(
                    `    ? [proshore] Inline card error:`,
                    error.message
                );
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};

// --- Helpers ---------------------------------------------------------------

/**
 * Click tab triggers and scroll aggressively so dynamically-loaded
 * job panels get a chance to render. Best-effort - never throws.
 */
async function interactAndSettle(page) {
    // Scroll to #current_openings if it exists, else scroll whole page
    try {
        await page.evaluate(() => {
            const el =
                document.querySelector('#current_openings') ||
                document.querySelector('[id*="current_openings" i]') ||
                document.querySelector('[id*="openings" i]') ||
                document.querySelector('#Content-Block-1');
            if (el) {
                el.scrollIntoView({ behavior: 'instant', block: 'start' });
            } else {
                window.scrollTo(0, document.body.scrollHeight / 2);
            }
        });
        await delay(1000);
    } catch (e) {
        /* non-fatal */
    }

    // Full-page progressive scroll
    try {
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let y = 0;
                const step = () => {
                    window.scrollBy(0, 700);
                    y += 700;
                    if (y < document.body.scrollHeight && y < 25000) {
                        setTimeout(step, 100);
                    } else {
                        window.scrollTo(0, 0);
                        resolve();
                    }
                };
                step();
            });
        });
        await delay(1200);
    } catch (e) {
        /* non-fatal */
    }

    // Click tab triggers to reveal panels
    const tabSelectors = [
        '.layout350_tab-link',
        '.layout402_tab-link',
        '[class*="tab-link"]',
        'a[href*="Content-Block"]',
        'a[href="#current_openings"]',
        'a[href*="#current_openings"]'
    ];
    for (const sel of tabSelectors) {
        try {
            const tabs = await page.$$(sel);
            for (const tab of tabs) {
                try {
                    await tab.click({ delay: 80 });
                    await delay(500);
                } catch (e) {
                    /* tab may be hidden/covered */
                }
            }
        } catch (e) {
            /* selector may not exist */
        }
    }
    await delay(1500);
}

/**
 * Harvest job-detail links from the current page.
 * Returns [{ href, text }] filtered by path heuristics.
 */
async function harvestJobLinks(page) {
    const anchors = await page.$$eval('a[href]', (as) =>
        as.map((a) => ({
            href: a.href,
            text: (a.textContent || '').replace(/\s+/g, ' ').trim()
        }))
    );

    const out = [];
    const seen = new Set();
    for (const a of anchors) {
        if (!a.href) continue;
        let u;
        try {
            u = new URL(a.href, ORIGIN);
        } catch (e) {
            continue;
        }
        if (u.origin !== ORIGIN) continue;
        if (NON_JOB_PATH.test(u.pathname)) continue;
        if (/^\/careers?\/?$/i.test(u.pathname)) continue;
        if (!JOB_PATH.test(u.pathname)) continue;
        if (seen.has(u.href)) continue;
        seen.add(u.href);
        out.push({ href: u.href, text: a.text });
    }
    return out;
}

/**
 * Harvest inline job-like cards when no per-job detail links exist.
 * Uses broad selectors and structural heuristics - will not match nav
 * or footer items because we require the card to be inside a listing
 * region (layout350/Content-Block/collection list) AND have a heading.
 */
async function harvestInlineCards(page) {
    return await page.evaluate(() => {
        const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
        const seenTitles = new Set();
        const out = [];

        // Broad card selectors used across Webflow + custom templates
        const cardSelectors = [
            '.w-dyn-item',
            '[class*="job-card"]',
            '[class*="job-card-item"]',
            '[class*="job-listing"]',
            '[class*="job-item"]',
            '[class*="opening"]',
            '[class*="position"]',
            '[class*="career-item"]',
            '.layout350_content .w-dyn-item',
            '.layout350_content article',
            '.layout350_list-item'
        ];

        const candidates = new Set();
        for (const sel of cardSelectors) {
            try {
                for (const el of document.querySelectorAll(sel)) {
                    candidates.add(el);
                }
            } catch (e) {
                /* invalid selector in this DOM */
            }
        }

        for (const el of candidates) {
            const heading =
                el.querySelector('h1, h2, h3, h4, h5') || null;
            if (!heading) continue;

            const title = norm(heading.textContent);
            if (!title || title.length < 3 || title.length > 120) continue;
            // Skip obvious non-job headings
            if (
                /^(Tech|Operations|Bootcamp|Current openings|Services|Insights|About us|Contact|Case studies|Industries)$/i.test(
                    title
                )
            ) {
                continue;
            }

            const lower = title.toLowerCase();
            if (seenTitles.has(lower)) continue;

            const fullText = norm(el.innerText);
            // Must have some meat to be a real job card
            if (fullText.length < 30) continue;

            // Must NOT look like a footer/menu block
            if (/^(services|company|resources|legal)$/i.test(title)) continue;

            const a = el.querySelector('a[href]');
            let url = window.location.href;
            if (a && a.getAttribute('href')) {
                try {
                    url = new URL(
                        a.getAttribute('href'),
                        window.location.origin
                    ).href;
                } catch (e) {
                    /* keep default */
                }
            }

            // Image
            let image = null;
            const img = el.querySelector('img');
            if (img) {
                try {
                    const resolved = window.__resolveImageSrc(img);
                    if (resolved && !/logo|icon/i.test(resolved)) {
                        image = resolved;
                    }
                } catch (e) {
                    /* ignore */
                }
            }

            // Location
            let location = null;
            for (const city of [
                'Kathmandu',
                'Pokhara',
                'Lalitpur',
                'Bhaktapur',
                'Nepal',
                'Netherlands',
                'Remote'
            ]) {
                if (new RegExp(`\\b${city}\\b`, 'i').test(fullText)) {
                    location = city;
                    break;
                }
            }

            seenTitles.add(lower);
            out.push({
                title,
                text: fullText,
                url,
                image,
                location
            });
        }

        return out;
    });
}