// src/scrapers/extractors/jobs/dev.js
// Programiz careers - landing page at /careers, individual roles at
// /careers/<slug> (e.g. /careers/content-writer-intern).
//
// CORRECTED ASSUMPTIONS:
//   The batch's "detail-link pattern: /python-programming" is wrong -
//    those are tutorial/compiler links in the nav, not jobs. The real
//    job-detail pattern on this site is /careers/<slug>.
//   Site type is effectively listing-to-detail, but the listing may
//    render 0..N job anchors depending on what's open. If the listing
//    has no open roles, we return an empty array (valid per contract).
//   Detail template matches the rest of the Drupal site: title lives
//    in H1.title-section__title, description in the main content block.
//    We use generic fallbacks since the job-page DOM wasn't in the dump.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { sanitizeImageUrl } = require('../../sanitize');

const CAREERS_URL = 'https://dev.programiz.com/careers';
const MAX_DETAIL_PAGES = 30;

module.exports = {
    preprocessItem(item) {
        if (item.image) item.image = sanitizeImageUrl(item.image) || null;
        return item;
    },

    async extract(page, { progress, meta }) {
        console.log('??? [dev] Scraping Programiz careers...');

        meta.pagesVisited++;
        await page.goto(CAREERS_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('[dev] page looks blocked:', (state.bodySnippet || '').slice(0, 200));
            meta.looksBlocked = true;
            return { items: [], meta };
        }

        await delay(2000);

        // Scroll to bottom so any lazily-rendered "Open Positions" block
        // has a chance to mount.
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let y = 0;
                const step = () => {
                    window.scrollBy(0, window.innerHeight);
                    y += window.innerHeight;
                    if (y < document.body.scrollHeight && y < 30000) setTimeout(step, 120);
                    else resolve();
                };
                step();
            });
        });
        await delay(1500);

        // Harvest job detail links. Job anchors follow /careers/<slug>
        // (excluding the /careers listing itself). We deliberately ignore
        // nav/footer links to /python-programming etc.
        const jobLinks = await page.evaluate(() => {
            const seen = new Set();
            const out = [];
            const anchors = Array.from(document.querySelectorAll('a[href]'));
            for (const a of anchors) {
                const href = a.getAttribute('href');
                if (!href) continue;
                const m = href.match(/\/careers\/([^\/?#]+)\/?(?:[?#].*)?$/);
                if (!m) continue;
                const slug = m[1];
                if (!slug || slug === 'careers') continue;      // skip self
                if (slug === 'index.html') continue;
                const full = new URL(href, window.location.origin).href;
                if (seen.has(full)) continue;
                seen.add(full);
                out.push({ url: full, text: (a.textContent || '').replace(/\s+/g, ' ').trim() });
            }
            return out;
        });

        console.log(`? [dev] found ${jobLinks.length} job link(s) on careers landing`);
        safeDiscovered(progress, jobLinks.length);
        meta.listingHits = jobLinks.length;

        const items = [];
        const now = Date.now();

        for (const link of jobLinks.slice(0, MAX_DETAIL_PAGES)) {
            try {
                console.log(`  ?? [dev] detail: ${link.url}`);
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await page.goto(link.url, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(400);

                const detail = await page.evaluate(() => {
                    const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();

                    // Title: Drupal site template uses this class site-wide.
                    const titleEl = document.querySelector('h1.title-section__title')
                        || document.querySelector('main h1')
                        || document.querySelector('h1');
                    const title = titleEl ? clean(titleEl.textContent) : null;

                    // Description: largest meaningful text block in <main>.
                    const main = document.querySelector('main') || document.querySelector('article') || document.body;
                    let description = null;
                    const candidates = [
                        'div.tabbed-content',
                        'article .node__content',
                        'article',
                        '.node__content',
                        'main',
                    ];
                    for (const sel of candidates) {
                        const el = document.querySelector(sel);
                        if (!el) continue;
                        const txt = clean(el.textContent);
                        if (txt && txt.length > (description ? description.length : 0)) description = txt;
                    }
                    if (!description && main) description = clean(main.textContent).slice(0, 5000);

                    const bodyText = clean(document.body.textContent);

                    // Location: Nepal-oriented site; jobs are usually Kathmandu or Remote.
                    const locMatch = bodyText.match(/\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Nepal|Remote|Hybrid|On-?site)\b/i);
                    const location = locMatch ? locMatch[1] : null;

                    // Date: prefer "Posted on <date>" or bare ISO.
                    let date = null;
                    const postedMatch = bodyText.match(/(?:Posted(?:\s+on)?|Date)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i);
                    if (postedMatch) date = postedMatch[1];
                    else {
                        const isoMatch = bodyText.match(/\b(\d{4}-\d{2}-\d{2})\b/);
                        if (isoMatch) date = isoMatch[1];
                    }

                    // Image: first non-logo image inside the article body.
                    let image = null;
                    const imgEl = document.querySelector('article img, main img, .node__content img');
                    if (imgEl && typeof window.__resolveImageSrc === 'function') {
                        image = window.__resolveImageSrc(imgEl);
                    }

                    // Employment-type tags if present.
                    const tags = [];
                    const emp = bodyText.match(/\b(Full[- ]?time|Part[- ]?time|Contract|Internship|Intern|Freelance)\b/i);
                    if (emp) tags.push(emp[1]);

                    return { title, description, location, date, image, tags, finalUrl: window.location.href };
                });

                if (!detail.title) {
                    meta.detailParseFailures++;
                    console.warn(`  ?? [dev] no title on ${link.url}`);
                    continue;
                }

                // Description often includes the title verbatim at the top;
                // strip the leading duplicate for cleanliness.
                let description = detail.description;
                if (description && detail.title) {
                    const idx = description.indexOf(detail.title);
                    if (idx === 0) description = description.slice(detail.title.length).trim();
                }

                let attendanceMode = null;
                const locLower = (detail.location || '').toLowerCase();
                if (locLower.includes('remote')) attendanceMode = 'online';
                else if (locLower.includes('hybrid')) attendanceMode = 'hybrid';
                else if (detail.location) attendanceMode = 'in-person';

                items.push({
                    id: `dev-${now}-${Math.random().toString(36).slice(2, 8)}`,
                    title: detail.title,
                    description,
                    date: detail.date,
                    time: null,
                    location: detail.location,
                    price: null,                    // jobs have no price
                    organizer: 'Programiz',
                    category: null,
                    tags: detail.tags || [],
                    image: detail.image || null,
                    url: detail.finalUrl || link.url,
                    registrationUrl: detail.finalUrl || link.url,
                    attendanceMode,
                    company: 'Programiz',
                    source: 'dev',
                });
            } catch (err) {
                console.error(`  ? [dev] detail failed for ${link.url}:`, err.message);
            } finally {
                safeUnitDone(progress);
            }
        }

        meta.listingHits = items.length;
        console.log(`? [dev] extracted ${items.length} role(s)`);

        // Empty is valid when Programiz has no open roles.
        return { items, meta };
    },
};