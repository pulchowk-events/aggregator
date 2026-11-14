// src/scrapers/extractors/jobs/adex.js
// Site-specific extractor for adex.ltd careers.
// See ../README.md for the contract.
//
// NOTE ON ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The dump's "card wrapper" selector (div.swiper-slide.swiper-slide-duplicate,
//     21 matches) is WRONG for this purpose. Inspecting the sample HTML shows those
//     are decorative image-carousel slides (background-image + shadow divs only,
//     no headings/links/text). They are NOT job cards.
//   - The actual job-listing DOM was not captured in the dump (cardCandidates
//     contain only nav/footer/office-address blocks; detailLinkCandidates contain
//     only /resources/all-blog). The page title/body confirm it IS the careers page
//     ("Career - Adex", "Find your Career with Adex"), so we still target it, but
//     we extract defensively: prefer JSON-LD JobPosting, then anchor heuristics,
//     and return an empty array gracefully if nothing scrapeable exists.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const ADEX_CAREERS_URL = 'https://adex.ltd/career';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [adex] Scraping Adex careers...');

        meta.pagesVisited++;
        await page.goto(ADEX_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(3000); // let any JS-rendered careers section settle

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [adex] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        const items = await page.evaluate((entryUrl) => {
            const out = [];
            const seen = new Set();
            const now = Date.now();
            const rand = () => Math.random().toString(36).slice(2, 8);
            const abs = (href) => {
                try { return new URL(href, window.location.origin).href; }
                catch { return null; }
            };

            // ---- 1) JSON-LD JobPosting (preferred when present) ----
            const ldScripts = Array.from(
                document.querySelectorAll('script[type="application/ld+json"]')
            );
            for (const s of ldScripts) {
                let parsed;
                try { parsed = JSON.parse(s.textContent); }
                catch { continue; }
                const nodes = Array.isArray(parsed)
                    ? parsed
                    : (parsed && parsed['@graph']) || [parsed];
                for (const node of nodes) {
                    if (!node) continue;
                    const type = node['@type'];
                    const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
                    if (!isJob) continue;
                    const title = node.title || node.name;
                    if (!title) continue;
                    const url = node.url ? abs(node.url) : window.location.href;
                    const key = (title + '|' + url).toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const descRaw = node.description || '';
                    const description = descRaw
                        ? descRaw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                        : null;

                    let location = null;
                    const jl = node.jobLocation;
                    const jlArr = Array.isArray(jl) ? jl : (jl ? [jl] : []);
                    for (const l of jlArr) {
                        const addr = l && l.address;
                        const locality = addr && (addr.addressLocality || addr.addressRegion || addr.addressCountry);
                        if (locality) { location = typeof locality === 'string' ? locality : (locality.name || null); break; }
                    }

                    const hiring = node.hiringOrganization;
                    const organizer = (hiring && (hiring.name || hiring)) || 'Adex';

                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid')
                            ? 'hybrid'
                            : 'in-person';

                    out.push({
                        id: `adex-${now}-${rand()}`,
                        title: String(title).trim(),
                        description,
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Adex',
                        category: node.occupationalCategory || null,
                        tags: [],
                        image: null,
                        url: url || window.location.href,
                        registrationUrl: url || window.location.href,
                        attendanceMode,
                        source: 'adex',
                    });
                }
            }

            // ---- 2) Anchor heuristic fallback for real job detail links ----
            // Only anchors whose href clearly looks like a job/career/position
            // detail page, NOT nav/footer links, NOT the listing itself.
            const jobHrefRe = /\/(careers?|jobs?|positions?|openings?|vacanc(?:y|ies))\/[^/?#]+/i;
            const entryNorm = entryUrl.replace(/\/$/, '');
            const anchors = document.querySelectorAll('a[href]');
            for (const a of anchors) {
                if (a.closest('nav, header, footer')) continue;
                const href = abs(a.getAttribute('href'));
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;
                if (!jobHrefRe.test(href)) continue;

                const title = (a.textContent || '').replace(/\s+/g, ' ').trim();
                if (!title || title.length < 3 || title.length > 120) continue;

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({
                    id: `adex-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Adex',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'adex',
                });
            }

            return out;
        }, ADEX_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.warn('[adex] no scrapeable job cards found - returning empty list');
        } else {
            console.log(`? [adex] extracted ${items.length} job(s)`);
        }

        return { items, meta };
    },
};