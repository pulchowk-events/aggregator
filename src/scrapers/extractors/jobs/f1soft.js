// src/scrapers/extractors/jobs/f1soft.js
// Site-specific extractor for career.f1soft.com.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `/` (18 matches) is nav / category /
//     organization / search links - NOT direct job-detail hrefs.
//     detailLinkCandidates only shows /categories/*, /organizations/*,
//     /types/*, /levels/* and /search?keywords=<role> which are filter
//     and search pages, not per-job URLs.
//   - The dump's "sample detail page" (career.f1soft.com/categories/
//     software-engineer) is a CATEGORY page, so we have no evidence of
//     an actual per-job detail page DOM. We therefore do NOT chase detail
//     pages blindly. The reliable, evidence-backed signal is the job
//     card structure seen in cardCandidates:
//         div.col-lg-6 > .features-job > .job-archive-header
//             > .inner-box > .logo-company + h3 (job title)
//     Sample h3 texts: "Chief Operating Officer",
//     "Backend Engineer - Python/Django".
//   - The homepage shows featured jobs (6 cards). The "Find Jobs" nav
//     link points to /jobs which is the full listing. We prefer /jobs
//     and fall back to the homepage if /jobs yields no cards.
//
// Strategy:
//   1. Navigate to /jobs. Wait for `.features-job, div.col-lg-6`.
//   2. If zero cards, fall back to the homepage (entry URL) and try
//      the same selectors.
//   3. Extract card title / link / image / metadata without visiting
//      every detail page (no detail-page evidence to parse reliably).
//   4. If a card's link clearly targets a distinct /jobs/<slug> (not a
//      /search? or /categories/ URL), visit it once to pull a longer
//      description into the item.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const F1SOFT_JOBS_URL = 'https://career.f1soft.com/jobs';
const F1SOFT_HOME_URL = 'https://career.f1soft.com/';

async function harvestCards(page) {
    return page.evaluate(() => {
        const clean = (s) => (s
            ? String(s).replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
            : null);
        const stripHtml = (s) => (s
            ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
            : null);
        const abs = (href) => {
            if (!href) return null;
            try { return new URL(href, window.location.origin).href; }
            catch { return null; }
        };

        const out = [];
        const seen = new Set();

        // Confirmed card container from evidence: div.col-lg-6 > .features-job.
        const cards = document.querySelectorAll(
            '.features-job, div.col-lg-6 .features-job, div.col-lg-6'
        );

        for (const card of cards) {
            try {
                // The dump shows h3 is the job title inside .job-archive-header.
                const titleEl =
                    card.querySelector('h3.fs-6 a[href]') ||
                    card.querySelector('h3 a[href]') ||
                    card.querySelector('h3');
                if (!titleEl) continue;

                const title = clean(titleEl.textContent);
                if (!title || title.length < 2 || title.length > 160) continue;

                // Prefer the anchor wrapping the title; else the card's first link.
                let linkEl = titleEl.closest('a[href]') ||
                    card.querySelector('a[href]');
                const href = linkEl ? abs(linkEl.getAttribute('href')) : null;

                const key = (title + '|' + (href || '')).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                // Company logo image (evidence: .logo-company img).
                const imgEl = card.querySelector('.logo-company img, img');
                const image = imgEl ? window.__resolveImageSrc(imgEl) : null;

                // Description teaser - first substantial paragraph inside the card.
                let description = null;
                let bestLen = 0;
                for (const p of card.querySelectorAll('p')) {
                    const t = stripHtml(p.textContent);
                    if (!t) continue;
                    if (t.length > bestLen) { bestLen = t.length; description = t; }
                }

                // Try to pull simple metadata from badges / small text.
                const tags = [];
                for (const b of card.querySelectorAll(
                    '.badge, .tag, [class*="badge"], [class*="chip"], small'
                )) {
                    const t = clean(b.textContent);
                    if (!t) continue;
                    if (t.length < 2 || t.length > 40) continue;
                    if (tags.includes(t)) continue;
                    tags.push(t);
                }

                // Location hint - evidence doesn't show a dedicated field,
                // so try a generic match of "City, Country" in the card text.
                let location = null;
                const cardTxt = card.textContent || '';
                const locM = cardTxt.match(/\b([A-Z][A-Za-z .'-]+,\s*[A-Z][A-Za-z .'-]+)\b/);
                if (locM) location = clean(locM[1]);

                out.push({
                    title,
                    url: href,
                    image,
                    description,
                    tags,
                    location,
                });
            } catch (e) { /* skip bad card */ }
        }
        return out;
    });
}

module.exports = {
    async extract(page, { progress, meta }) {
        const items = [];

        console.log('??? [f1soft] Scraping F1Soft careers...');

        // ---- Stage 1: navigate to the full /jobs listing ----
        meta.pagesVisited++;
        await page.goto(F1SOFT_JOBS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(1500);

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [f1soft] listing looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Give the card grid time to render.
        try {
            await page.waitForSelector('.features-job, div.col-lg-6', { timeout: 8000 });
        } catch (e) {
            console.log('?? [f1soft] no .features-job cards on /jobs - falling back to homepage');
        }

        let cards = await harvestCards(page);

        // ---- Fallback: homepage also exposes featured job cards ----
        if (cards.length === 0) {
            try {
                meta.pagesVisited++;
                await page.goto(F1SOFT_HOME_URL, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(1200);
                await page.waitForSelector('.features-job, div.col-lg-6', { timeout: 8000 });
                cards = await harvestCards(page);
                if (cards.length > 0) {
                    console.log(`?? [f1soft] recovered ${cards.length} featured job card(s) from homepage`);
                }
            } catch (e) {
                console.warn(`?? [f1soft] homepage fallback failed: ${e.message}`);
            }
        }

        meta.listingHits = cards.length;
        safeDiscovered(progress, cards.length);
        console.log(`? [f1soft] found ${cards.length} job card(s)`);

        if (cards.length === 0) {
            return { items: [], meta };
        }

        // ---- Stage 2: enrich from a real per-job detail page when available ----
        // Only follow links that look like a distinct job-detail route
        // (/jobs/<slug>) - NOT /search?..., /categories/..., /organizations/...
        const detailRe = /\/jobs\/[^/?#]+/i;

        for (const c of cards) {
            try {
                let description = c.description;
                let finalUrl = c.url;

                if (c.url && detailRe.test(c.url)) {
                    meta.pagesVisited++;
                    meta.detailPagesVisited++;
                    try {
                        await page.goto(c.url, { waitUntil: 'networkidle2', timeout: 30000 });
                        await delay(600);

                        const detail = await page.evaluate(() => {
                            const stripHtml = (s) => (s
                                ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                                : null);
                            let best = null;
                            let bestLen = 0;
                            for (const d of document.querySelectorAll('section, article, div')) {
                                if (d.closest('nav, header, footer')) continue;
                                if (d.children.length > 40) continue;
                                const txt = d.textContent || '';
                                if (txt.length <= bestLen) continue;
                                if (txt.length < 200 || txt.length > 20000) continue;
                                if (!/responsibilit|requirement|qualification|experience|skills?/i.test(txt)) continue;
                                best = stripHtml(txt);
                                bestLen = txt.length;
                            }
                            return { description: best, finalUrl: window.location.href };
                        });

                        if (detail.description) description = detail.description;
                        if (detail.finalUrl) finalUrl = detail.finalUrl;
                    } catch (e) {
                        if (!/403/.test(e.message || '')) {
                            console.warn(`?? [f1soft] detail fetch failed for ${c.url}: ${e.message}`);
                        }
                        meta.detailParseFailures++;
                    }
                }

                items.push({
                    id: `f1soft-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    title: c.title,
                    description: description || null,
                    date: null,
                    time: null,
                    location: c.location || null,
                    price: null,
                    organizer: 'F1Soft Group',
                    category: null,
                    tags: c.tags || [],
                    image: c.image || null,
                    url: finalUrl || F1SOFT_JOBS_URL,
                    registrationUrl: finalUrl || c.url || F1SOFT_JOBS_URL,
                    attendanceMode: null,
                    source: 'f1soft',
                });
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(`?? [f1soft] 403 on ${c.url} - skipping.`);
                } else {
                    console.error(`    ? [f1soft] Error on ${c.url || c.title}:`, error.message);
                }
            } finally {
                safeUnitDone(progress);
            }
        }

        console.log(`? [f1soft] extracted ${items.length} item(s)`);
        return { items, meta };
    },
};