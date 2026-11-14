// src/scrapers/extractors/jobs/infodev.js
// Site-specific extractor. See ../README.md for the contract.
// Structural shape: single-page-cards - all jobs live on /careers itself
// (no detail pages). Each job is a card containing an <h3 class="text-blue-900">
// title, followed by a grid of metadata (location / experience / etc.) and
// an apply action. Harvested in one page.evaluate.
//
// Note: the auto-detector tagged "script" as the card wrapper (20 matches) -
// that is wrong; those are Next.js chunk loaders. The real job cards are the
// `div.border-b ... rounded-lg` rows whose sampleHtml contains
// "<h3 class='text-blue-900'>" job titles. We harvest via that h3.
//
// Selector drift history:
//   2026-11-14: initial extractor. Job titles appear as
//               <h3 class="text-blue-900 my-2">.</h3> inside a
//               div.border-b.rounded-lg card. Meta (location, level,
//               deadline) lives in a sibling md:grid-cols-3 block.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const ENTRY_URL = 'https://infodev.com.np/careers';

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        meta.pagesVisited++;
        await page.goto(ENTRY_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(800);

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(
                    `?? [infodev] careers page looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`
                );
                return { items, meta };
            }
        } catch (e) {
            /* best-effort */
        }

        // Wait for at least one job title to be in the DOM
        try {
            await page.waitForSelector('h3.text-blue-900', { timeout: 15000 });
        } catch (e) {
            console.log('?? [infodev] No job titles found on /careers.');
            meta.listingHits = 0;
            safeDiscovered(progress, 0);
            return { items, meta };
        }

        // Small scroll pass - Next.js content is SSR, but images/lazy
        // sections can push layout; scroll so nothing is below the fold.
        try {
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let y = 0;
                    const step = () => {
                        window.scrollBy(0, 600);
                        y += 600;
                        if (y < document.body.scrollHeight && y < 12000) {
                            setTimeout(step, 80);
                        } else {
                            window.scrollTo(0, 0);
                            resolve();
                        }
                    };
                    step();
                });
            });
            await delay(400);
        } catch (e) {
            /* non-fatal */
        }

        // --- Harvest all job cards in one pass --------------------------------
        const jobs = await page.evaluate(() => {
            const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
            const KNOWN_CITIES = [
                'Kathmandu', 'Lalitpur', 'Bhaktapur', 'Pokhara', 'Biratnagar',
                'Birgunj', 'Chitwan', 'Butwal', 'Remote', 'Nepal'
            ];

            const titleEls = Array.from(document.querySelectorAll('h3.text-blue-900'));
            const seen = new Set();
            const out = [];

            for (const h3 of titleEls) {
                const title = norm(h3.textContent);
                if (!title || title.length < 2) continue;
                const key = title.toLowerCase();
                if (seen.has(key)) continue;

                // Walk up to the card row. The card row is the nearest
                // ancestor that still only contains this one h3 - going one
                // more level up bundles all cards together.
                let card = h3.parentElement;
                for (let i = 0; i < 6 && card; i++) {
                    if (card.querySelectorAll('h3').length > 1) {
                        card = card.previousElementSibling || null; // step back
                        break;
                    }
                    // If we've reached a wrapper that looks card-like, stop.
                    const cls = typeof card.className === 'string' ? card.className : '';
                    if (cls.includes('rounded-lg') || cls.includes('border-b')) break;
                    card = card.parentElement;
                }
                if (!card) continue;

                seen.add(key);

                const cardText = norm(card.textContent);
                // remainder excludes the title we already have
                const remainder = cardText.startsWith(title)
                    ? cardText.slice(title.length).trim()
                    : cardText.replace(title, '').trim();

                // Location - prefer an explicit city match in the meta block
                let location = null;
                for (const city of KNOWN_CITIES) {
                    if (new RegExp(`(^|[^a-zA-Z])${city}([^a-zA-Z]|$)`, 'i').test(remainder)) {
                        location = city;
                        break;
                    }
                }

                // Experience level - appears either inside the title
                // "(Senior - level)" or as a meta label.
                let level = null;
                const titleLevel = title.match(/\(\s*([A-Za-z ]+?level)\s*\)/i);
                if (titleLevel) {
                    level = titleLevel[1].trim();
                } else {
                    const metaLevel = remainder.match(/\b(Junior|Mid|Senior|Lead)\s*-?\s*level\b/i);
                    if (metaLevel) level = metaLevel[0];
                }

                // Apply URL - first anchor inside the card, else the page itself
                let url = window.location.href;
                const a = card.querySelector('a[href]');
                if (a && a.getAttribute('href')) {
                    try {
                        url = new URL(a.getAttribute('href'), window.location.origin).href;
                    } catch (e) {
                        /* keep default */
                    }
                }

                // Description: keep the remainder text (meta + any blurb).
                // Orchestrator will trim/clean. Without a per-job detail page
                // there is no long-form description to strip HTML from.
                const description = remainder || null;

                out.push({ title, description, location, level, url });
            }

            return out;
        });

        meta.listingHits = jobs.length;
        safeDiscovered(progress, jobs.length);
        console.log(`? [infodev] Found ${jobs.length} job card(s).`);

        if (jobs.length === 0) {
            return { items, meta };
        }

        // --- Build final items ------------------------------------------------
        for (const job of jobs) {
            try {
                const tags = [];
                if (job.level) tags.push(job.level);
                if (job.location && job.location !== 'Nepal') tags.push(job.location);

                items.push({
                    id: `infodev-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                    title: job.title,
                    description: job.description || null,
                    date: null,
                    time: null,
                    location: job.location || null,
                    price: null,
                    organizer: 'InfoDevelopers',
                    category: null,
                    tags,
                    image: null,
                    url: job.url,
                    registrationUrl: job.url,
                    attendanceMode: 'in-person',
                    source: 'infodev'
                });

                console.log(`    ? [infodev] Scraped: ${job.title}`);
            } catch (error) {
                console.error(
                    `    ? [infodev] Error processing "${job.title}":`,
                    error.message
                );
            }
        }

        safeUnitDone(progress, items.length);
        return { items, meta };
    }
};