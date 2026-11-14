// src/scrapers/extractors/jobs/sussol.js
// Sussol (Sustainable Solutions) - /jobs/ listing.
//
// Current state of the page (per evidence dump) is "NO JOBS OPENING YET !"
// so the extractor is written defensively: it first checks for that
// empty-state marker and returns early with an empty array. When jobs
// ARE posted the site uses a plain Bootstrap-3 template (col-md-* grid,
// h1/h2 headings, ordinary <a href="/jobs/<slug>"> links). We harvest
// any such anchors, then visit each detail page for title/description.
//
// NOTE: the dump contains no sample of a populated jobs listing, so we
// intentionally avoid inventing a brittle card class and instead anchor
// on the /jobs/<slug> href pattern and general <main> heading structure.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');
const { sanitizeImageUrl } = require('../../sanitize');

const LISTING_URL = 'https://sussol.net/jobs/';
const MAX_DETAIL_PAGES = 30;

module.exports = {
    preprocessItem(item) {
        if (item.image) item.image = sanitizeImageUrl(item.image) || null;
        return item;
    },

    async extract(page, { progress, meta }) {
        console.log('??? [sussol] Scraping Sussol jobs...');

        meta.pagesVisited++;
        await page.goto(LISTING_URL, { waitUntil: 'networkidle2', timeout: 60000 });

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('[sussol] page looks blocked:', (state.bodySnippet || '').slice(0, 200));
            meta.looksBlocked = true;
            return { items: [], meta };
        }

        await delay(1200);

        // Empty-state check - site explicitly says "NO JOBS OPENING YET !"
        // and "Currently we have no job openings."
        const isEmpty = await page.evaluate(() => {
            const txt = (document.body.textContent || '').replace(/\s+/g, ' ');
            return /no\s+job\s+openings?/i.test(txt) ||
                   /no\s+jobs?\s+opening/i.test(txt);
        });

        if (isEmpty) {
            console.log('?? [sussol] site reports no open jobs - returning empty');
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Harvest job detail links. Detail pages live under /jobs/<slug>
        // (excluding /jobs/ itself and the /jobs/#anchor links). We
        // deliberately exclude nav/footer links to /about, /news etc.
        const jobLinks = await page.evaluate(() => {
            const seen = new Set();
            const out = [];
            for (const a of document.querySelectorAll('a[href]')) {
                const href = a.getAttribute('href');
                if (!href) continue;
                // Only real /jobs/<slug> links, no fragments, no self.
                if (!/\/jobs\/[^\/?#]+\/?(?:[?#].*)?$/.test(href)) continue;
                const full = new URL(href, window.location.origin).href;
                if (/\/jobs\/?$/.test(full)) continue;
                if (seen.has(full)) continue;
                seen.add(full);
                out.push({ url: full, text: (a.textContent || '').replace(/\s+/g, ' ').trim() });
            }
            return out;
        });

        console.log(`? [sussol] found ${jobLinks.length} job link(s)`);
        safeDiscovered(progress, jobLinks.length);
        meta.listingHits = jobLinks.length;

        const items = [];
        const now = Date.now();

        for (const link of jobLinks.slice(0, MAX_DETAIL_PAGES)) {
            try {
                console.log(`  ?? [sussol] detail: ${link.url}`);
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await page.goto(link.url, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(400);

                const detail = await page.evaluate(() => {
                    const clean = (v) => (v || '').replace(/\s+/g, ' ').trim();

                    // Bootstrap-3 template: heading is a plain h1/h2 in the
                    // main content area, no title-section classes.
                    let titleEl = document.querySelector('main h1')
                        || document.querySelector('.container h1')
                        || document.querySelector('#main-content h1')
                        || document.querySelector('h1');
                    if (!titleEl) {
                        titleEl = document.querySelector('main h2')
                            || document.querySelector('.container h2');
                    }
                    const title = titleEl ? clean(titleEl.textContent) : null;

                    // Body: the largest text block in the main column.
                    let description = null;
                    const containers = [
                        '#main-content',
                        'main',
                        '.container .row',
                        '.container',
                    ];
                    for (const sel of containers) {
                        const el = document.querySelector(sel);
                        if (!el) continue;
                        const txt = clean(el.textContent);
                        if (txt && txt.length > (description ? description.length : 0)) {
                            description = txt;
                        }
                    }
                    if (!description) {
                        description = clean(document.body.textContent).slice(0, 5000);
                    }

                    const bodyText = clean(document.body.textContent);

                    // Location: Nepal-oriented site, likely Kathmandu/Remote.
                    const locMatch = bodyText.match(/\b(Kathmandu|Lalitpur|Bhaktapur|Pokhara|Nepal|Remote|Hybrid|On-?site)\b/i);
                    const location = locMatch ? locMatch[1] : null;

                    // Date: look for "Posted on", "Date:", or bare ISO.
                    let date = null;
                    const postedMatch = bodyText.match(/(?:Posted(?:\s+on)?|Date)\s*[:\-]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i);
                    if (postedMatch) date = postedMatch[1];
                    else {
                        const iso = bodyText.match(/\b(\d{4}-\d{2}-\d{2})\b/);
                        if (iso) date = iso[1];
                    }

                    // Image: first non-logo img inside the main content.
                    let image = null;
                    const imgEl = document.querySelector(
                        '#main-content img, main img, .container img'
                    );
                    if (imgEl && typeof window.__resolveImageSrc === 'function') {
                        image = window.__resolveImageSrc(imgEl);
                    }

                    // Employment type tags if present.
                    const tags = [];
                    const emp = bodyText.match(/\b(Full[- ]?time|Part[- ]?time|Contract|Internship|Intern|Freelance)\b/i);
                    if (emp) tags.push(emp[1]);

                    return { title, description, location, date, image, tags, finalUrl: window.location.href };
                });

                if (!detail.title) {
                    meta.detailParseFailures++;
                    console.warn(`  ?? [sussol] no title on ${link.url}`);
                    continue;
                }

                // Strip leading duplication of the title in the description.
                let description = detail.description;
                if (description && detail.title && description.indexOf(detail.title) === 0) {
                    description = description.slice(detail.title.length).trim();
                }

                let attendanceMode = null;
                const locLower = (detail.location || '').toLowerCase();
                if (locLower.includes('remote')) attendanceMode = 'online';
                else if (locLower.includes('hybrid')) attendanceMode = 'hybrid';
                else if (detail.location) attendanceMode = 'in-person';

                items.push({
                    id: `sussol-${now}-${Math.random().toString(36).slice(2, 8)}`,
                    title: detail.title,
                    description,
                    date: detail.date,
                    time: null,
                    location: detail.location,
                    price: null,                 // jobs have no price
                    organizer: 'Sustainable Solutions',
                    category: null,
                    tags: detail.tags || [],
                    image: detail.image || null,
                    url: detail.finalUrl || link.url,
                    registrationUrl: detail.finalUrl || link.url,
                    attendanceMode,
                    company: 'Sussol',
                    source: 'sussol',
                });
            } catch (err) {
                console.error(`  ? [sussol] detail failed for ${link.url}:`, err.message);
            } finally {
                safeUnitDone(progress);
            }
        }

        meta.listingHits = items.length;
        console.log(`? [sussol] extracted ${items.length} role(s)`);

        // Empty is normal for this site when no openings are posted.
        return { items, meta };
    },
};