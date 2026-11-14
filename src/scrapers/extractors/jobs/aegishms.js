// src/scrapers/extractors/jobs/aegishms.js
// Site-specific extractor. See ../README.md for the contract.
// Structural shape: single careers listing page with accordion job cards.
// NOTE: The detected "listing-to-detail" assumption was wrong for jobs -
// the /careers page exposes jobs as expandable accordion buttons, not as
// distinct detail links. We therefore extract directly from the listing
// page (expanding each accordion) and use JSON-LD JobPosting where present.
//
// Selector drift history:
//   2026-11-14: initial extractor. Job cards are <button aria-controls="job-content-N">
//               with an <h3> title and location/meta spans. No job detail URLs exist.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const ENTRY_URL = 'https://www.aegishms.com/careers';

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        // --- Stage 1: load the careers listing ---------------------------------
        meta.pagesVisited++;
        await page.goto(ENTRY_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(800);

        // Block / captcha check on first load only
        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(
                    `?? [aegishms] careers page looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`
                );
                return { items, meta };
            }
        } catch (e) {
            /* best-effort */
        }

        // Wait for at least one accordion job card
        try {
            await page.waitForSelector('button[aria-controls^="job-content-"]', { timeout: 15000 });
        } catch (e) {
            console.log('?? [aegishms] No job accordion buttons found on careers page.');
            meta.listingHits = 0;
            safeDiscovered(progress, 0);
            return { items, meta };
        }

        // --- Stage 2: expand every accordion so descriptions are in the DOM ----
        const buttons = await page.$$('button[aria-controls^="job-content-"]');
        for (const btn of buttons) {
            try {
                const expanded = await btn.evaluate((el) => el.getAttribute('aria-expanded'));
                if (expanded !== 'true') {
                    await btn.click();
                    await delay(350);
                }
            } catch (e) {
                /* best-effort - content may already be visible */
            }
        }
        await delay(800);

        // --- Stage 3: harvest JSON-LD JobPosting objects (authoritative) -------
        const jsonLdJobs = await page.evaluate(() => {
            const out = [];
            const scripts = Array.from(
                document.querySelectorAll('script[type="application/ld+json"]')
            );
            for (const s of scripts) {
                try {
                    const data = JSON.parse(s.textContent);
                    const arr = Array.isArray(data) ? data : [data];
                    for (const d of arr) {
                        if (d && d['@type'] === 'JobPosting') out.push(d);
                    }
                } catch (e) {
                    /* ignore malformed JSON-LD */
                }
            }
            return out;
        });

        // --- Stage 4: harvest HTML cards --------------------------------------
        const cards = await page.evaluate(() => {
            const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
            const btns = Array.from(
                document.querySelectorAll('button[aria-controls^="job-content-"]')
            );

            return btns
                .map((btn) => {
                    const titleEl = btn.querySelector('h3');
                    const title = norm(titleEl && titleEl.textContent);
                    if (!title) return null;

                    const metaSpans = Array.from(
                        btn.querySelectorAll('.flex.items-center.mt-1 span')
                    )
                        .map((s) => norm(s.textContent))
                        .filter(Boolean);

                    // First span is usually the location (e.g. "Nepal")
                    const location = metaSpans[0] || null;
                    const tags = metaSpans.slice(1);

                    const contentId = btn.getAttribute('aria-controls');
                    const contentEl = contentId ? document.getElementById(contentId) : null;

                    let description = null;
                    let date = null;
                    let time = null;

                    if (contentEl) {
                        description = norm(contentEl.innerText) || null;

                        // Best-effort date/time hints from the expanded content.
                        // These are not guaranteed fields on the site.
                        if (description) {
                            const dateMatch = description.match(
                                /\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\b/
                            );
                            if (dateMatch) date = dateMatch[1];

                            const timeMatch = description.match(
                                /\b(\d{1,2}:\d{2}(?:\s*[APap][Mm])?)\b/
                            );
                            if (timeMatch) time = timeMatch[1];
                        }
                    }

                    return { title, location, tags, description, date, time };
                })
                .filter(Boolean);
        });

        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);
        console.log(`? [aegishms] Found ${cards.length} job card(s).`);

        if (cards.length === 0) {
            return { items, meta };
        }

        // Index JSON-LD postings by lowercased title for matching
        const jsonByTitle = new Map();
        for (const j of jsonLdJobs) {
            if (j.title) jsonByTitle.set(j.title.trim().toLowerCase(), j);
        }

        // --- Stage 5: build items ---------------------------------------------
        for (const card of cards) {
            try {
                const jl = jsonByTitle.get(card.title.toLowerCase()) || null;

                let description = card.description;
                let location = card.location;
                let date = card.date;
                let time = card.time;
                let url = ENTRY_URL;
                let registrationUrl = null;

                if (jl) {
                    if (jl.description) {
                        const stripped = jl.description
                            .replace(/<[^>]+>/g, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();
                        if (stripped) description = stripped;
                    }

                    if (jl.datePosted) date = jl.datePosted;

                    if (jl.jobLocation) {
                        const loc = jl.jobLocation;
                        if (typeof loc === 'string') {
                            location = loc;
                        } else if (loc.address) {
                            const parts = [
                                loc.address.addressLocality,
                                loc.address.addressRegion,
                                loc.address.addressCountry
                            ].filter(Boolean);
                            if (parts.length) location = parts.join(', ');
                        } else if (loc.name) {
                            location = loc.name;
                        }
                    }

                    if (jl.url) {
                        try {
                            const abs = new URL(jl.url, ENTRY_URL).href;
                            url = abs;
                            registrationUrl = abs;
                        } catch (e) {
                            /* ignore malformed URL */
                        }
                    }
                }

                const id = `aegishms-${Date.now()}-${Math.random()
                    .toString(36)
                    .slice(2, 11)}`;

                items.push({
                    id,
                    title: card.title,
                    description: description || null,
                    date: date || null,
                    time: time || null,
                    location: location || null,
                    price: null,
                    organizer: 'Aegis Software',
                    category: null,
                    tags: card.tags || [],
                    image: null,
                    url,
                    registrationUrl,
                    attendanceMode:
                        location && /remote|online/i.test(location)
                            ? 'online'
                            : 'in-person',
                    source: 'aegishms'
                });

                console.log(`    ? [aegishms] Scraped job: ${card.title}`);
            } catch (error) {
                console.error(
                    `    ? [aegishms] Error processing job "${card.title}":`,
                    error.message
                );
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};