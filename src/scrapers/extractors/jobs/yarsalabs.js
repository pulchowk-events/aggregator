// src/scrapers/extractors/jobs/yarsalabs.js
// Site-specific extractor. See ../README.md for the contract.
//
// Structural shape corrected from evidence:
//   - Entry /jobs/ is NOT a direct job listing - it is a CATEGORY SELECTOR
//     page ("Open Positions") that exposes category cards: DESIGN, ENGINEERING,
//     SECURITY, and 3 more, linking to /jobs/<category>/.
//   - Real job-detail links live one level deeper: /jobs/<category>/<job-slug>/.
//     The harness's detected "detail link pattern /" was a false positive
//     (nav links). detailLinkCandidates was empty, confirming this.
//   - Site is multi-stage: entry -> category listing -> job detail.
//   - Detail-title assumption `H1.html-h1` is kept (falls back to any h1).
//   - "First non-logo image" was a Facebook CDN image (from the wrong detail
//     dump) - we do not trust that; images are left null on job items.
//
// Selector drift history:
//   2026-11-14: initial. Category cards are
//               div.bg-white.border.hover:bg-gray-50.rounded-lg.relative...
//               with headings DESIGN / ENGINEERING / SECURITY.
//   2026-11-14: category hrefs follow /jobs/<slug>/ (single segment after
//               /jobs/). Job hrefs follow /jobs/<slug>/<job-slug>/.
//   2026-11-14: multi-stage navigation added; we harvest category links
//               dynamically instead of hardcoding (3 of 6 known from dump).

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { pickOne } = require('../../selectors');
const { detectPageState } = require('../../diagnostics');

const YARSA_JOBS_URL = 'https://www.yarsalabs.com/jobs/';

const SEL = {
    title: [
        'h1.html-h1',
        'h1[class*="html-h1"]',
        'h1'
    ]
};

// /jobs/<slug>/ - exactly one segment after /jobs/, no further path.
const CATEGORY_HREF_RE = /^\/jobs\/[^\/?#]+\/?$/;
// /jobs/<slug>/<job-slug>/ - two segments after /jobs/.
const JOB_HREF_RE = /^\/jobs\/([^\/?#]+)\/([^\/?#]+)\/?$/;

module.exports = {
    preprocessItem(item) {
        return item;
    },

    async extract(page, { progress, meta }) {
        const items = [];

        // ---- Stage 1: category selector page ----
        meta.pagesVisited++;
        await page.goto(YARSA_JOBS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await delay(Math.random() * 1000 + 500);

        try {
            const state = await detectPageState(page);
            if (state.looksBlocked) {
                meta.looksBlocked = true;
                console.warn(`?? [yarsalabs] listing looks blocked - body snippet: ${JSON.stringify(state.bodySnippet)}`);
                return { items, meta };
            }
        } catch (e) {
            // best-effort diagnostics
        }

        // Give Next.js hydration a moment - category chips are in the SSR body.
        try {
            await page.waitForFunction(
                () => !!document.querySelector('a[href^="/jobs/"]'),
                { timeout: 10000 }
            );
        } catch (e) {
            console.log('?? [yarsalabs] No /jobs/ anchors appeared on selector page.');
        }

        const categoryUrls = await page.evaluate((pattern) => {
            const re = new RegExp(pattern);
            const out = new Set();
            const origin = window.location.origin;
            document.querySelectorAll('a[href]').forEach((a) => {
                let path;
                try {
                    const u = new URL(a.getAttribute('href'), origin);
                    if (u.hostname !== window.location.hostname) return;
                    path = u.pathname;
                } catch (_) {
                    return;
                }
                if (re.test(path)) out.add(new URL(path, origin).toString());
            });
            return Array.from(out);
        }, CATEGORY_HREF_RE.source);

        console.log(`? [yarsalabs] Discovered ${categoryUrls.length} job categories: ${categoryUrls.join(', ') || '(none)'}`);

        if (!categoryUrls.length) {
            // No categories  nothing to scrape. Return empty honestly.
            return { items, meta };
        }

        // ---- Stage 2: per-category job-link harvest ----
        const jobEntries = []; // { url, categoryUrl, categorySlug }
        const seenJobUrls = new Set();

        for (const categoryUrl of categoryUrls) {
            const categorySlug = (() => {
                try {
                    const parts = new URL(categoryUrl).pathname.split('/').filter(Boolean);
                    return parts[1] || null;
                } catch (_) {
                    return null;
                }
            })();

            try {
                meta.pagesVisited++;
                await page.goto(categoryUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(Math.random() * 800 + 400);
            } catch (error) {
                console.warn(`?? [yarsalabs] Failed to load category ${categoryUrl}: ${error.message}`);
                continue;
            }

            const jobUrls = await page.evaluate(({ pattern, catSlug }) => {
                const re = new RegExp(pattern);
                const out = new Set();
                const origin = window.location.origin;
                document.querySelectorAll('a[href]').forEach((a) => {
                    let u;
                    try {
                        u = new URL(a.getAttribute('href'), origin);
                    } catch (_) { return; }
                    if (u.hostname !== window.location.hostname) return;
                    const m = u.pathname.match(re);
                    if (!m) return;
                    if (m[1] !== catSlug) return; // same category only
                    out.add(u.toString());
                });
                return Array.from(out);
            }, { pattern: JOB_HREF_RE.source, catSlug: categorySlug });

            console.log(`  ?? [yarsalabs] ${categorySlug}: ${jobUrls.length} job(s).`);

            for (const url of jobUrls) {
                if (seenJobUrls.has(url)) continue;
                seenJobUrls.add(url);
                jobEntries.push({ url, categoryUrl, categorySlug });
            }
        }

        meta.listingHits = jobEntries.length;
        console.log(`? [yarsalabs] Total job detail links: ${jobEntries.length}`);
        safeDiscovered(progress, jobEntries.length);

        if (!jobEntries.length) {
            return { items, meta };
        }

        // ---- Stage 3: per-detail extraction ----
        for (const job of jobEntries) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await page.goto(job.url, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(Math.random() * 800 + 400);

                const titleResult = await pickOne(page, SEL.title, { label: `detail title (${job.url})` });

                // Description: collect substantive paragraphs from the main
                // content area of the detail page. Selector intentionally
                // generic (we have no verified per-job-detail selectors in the
                // evidence dump, so we favour h1 + <p> heuristics).
                const extras = await page.evaluate(() => {
                    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
                    const main = document.querySelector('main') || document.body;
                    const paras = Array.from(main.querySelectorAll('p'))
                        .map((p) => norm(p.textContent))
                        .filter((t) => t.length >= 40);
                    // Dedupe consecutive duplicates (Next.js sometimes renders
                    // the same copy twice via hydration fallback).
                    const deduped = [];
                    for (const p of paras) {
                        if (deduped[deduped.length - 1] !== p) deduped.push(p);
                    }
                    return {
                        description: deduped.slice(0, 8).join(' ') || null,
                        finalUrl: window.location.href
                    };
                });

                if (!titleResult.value) {
                    meta.detailParseFailures++;
                    console.warn(`?? [yarsalabs] detail title extraction failed for ${job.url}`);
                    continue;
                }

                const title = titleResult.value;

                items.push({
                    id: `yarsalabs-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
                    title,
                    description: extras.description || '',
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Yarsa Labs',
                    category: job.categorySlug ? job.categorySlug.toUpperCase() : 'Career',
                    tags: [job.categorySlug].filter(Boolean),
                    image: null,
                    url: extras.finalUrl || job.url,
                    registrationUrl: extras.finalUrl || job.url,
                    attendanceMode: null,
                    source: 'yarsalabs'
                });
                console.log(`    ? [yarsalabs] Scraped: ${title} (${job.categorySlug})`);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(`?? [yarsalabs] 403 on ${job.url} - skipping.`);
                } else {
                    console.error(`    ? [yarsalabs] Error scraping ${job.url}:`, error.message);
                }
            } finally {
                safeUnitDone(progress);
            }
        }

        return { items, meta };
    }
};