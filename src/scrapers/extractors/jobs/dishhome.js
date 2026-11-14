// src/scrapers/extractors/jobs/dishhome.js
// Site-specific extractor for career.dishhome.com.np.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `/` (3 matches) is just the logo + two
//     external links (dishhome.com.np, talentconnects.co), NOT job
//     detail links. detailLinkCandidates is empty.
//   - The "card wrapper" `link` (5 instances) is HTML metadata, NOT cards.
//   - cardCandidates is empty, but cardGroups show a meaningful signal:
//       span.flex.items-center containing "<map-pin/> Nepalgunj, Nepal"
//     - i.e. job cards DO exist in the hydrated DOM but were not captured
//     by the dump's heuristic. The site is Next.js; the listing renders
//     client-side.
//   - The page IS the careers listing (title:
//     "Dish Media Network Ltd. - Job Listings | Explore Careers &
//     Opportunities").
//
// Strategy: wait for hydration, then extract via:
//   1) JSON-LD JobPosting (defensive)
//   2) real job-detail anchors (careers/jobs/positions/<id>)
//   3) job cards detected via the map-pin location marker seen in evidence:
//      find each `span.flex.items-center` that contains a location and a
//      sibling/ancestor heading  treat as a job card.
//   4) headings inside an "Open Positions"-style block.
// Return [] gracefully if none found.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const DISHHOME_CAREERS_URL = 'https://career.dishhome.com.np/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [dishhome] Scraping DishHome careers...');

        meta.pagesVisited++;
        await page.goto(DISHHOME_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(3500); // Next.js hydration - job cards render client-side

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [dishhome] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Give hydrated cards a chance: scroll down/up to trigger any lazy work.
        try {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(1200);
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(600);
        } catch (e) { /* best-effort */ }

        const items = await page.evaluate((entryUrl) => {
            const out = [];
            const seen = new Set();
            const now = Date.now();
            const rand = () => Math.random().toString(36).slice(2, 8);
            const abs = (href) => {
                try { return new URL(href, window.location.origin).href; }
                catch { return null; }
            };
            const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);
            const stripHtml = (s) => (s
                ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                : null);
            const pushItem = (title, url, description) => {
                const key = (title + '|' + (url || entryUrl)).toLowerCase();
                if (seen.has(key)) return;
                seen.add(key);
                out.push({
                    id: `dishhome-${now}-${rand()}`,
                    title,
                    description: description || null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Dish Media Network Ltd.',
                    category: null,
                    tags: [],
                    image: null,
                    url: url || entryUrl,
                    registrationUrl: url || entryUrl,
                    attendanceMode: null,
                    source: 'dishhome',
                });
            };

            // ---- 1) JSON-LD JobPosting ----
            for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
                let parsed;
                try { parsed = JSON.parse(s.textContent); }
                catch { continue; }
                const nodes = Array.isArray(parsed)
                    ? parsed
                    : (parsed && parsed['@graph']) || [parsed];
                for (const node of nodes) {
                    if (!node) continue;
                    const t = node['@type'];
                    const isJob = t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
                    if (!isJob) continue;
                    const title = clean(node.title || node.name);
                    if (!title) continue;
                    const url = node.url ? abs(node.url) : entryUrl;

                    let location = null;
                    const jl = node.jobLocation;
                    const arr = Array.isArray(jl) ? jl : (jl ? [jl] : []);
                    for (const l of arr) {
                        const addr = l && l.address;
                        const loc = addr && (addr.addressLocality || addr.addressRegion || addr.addressCountry);
                        if (loc) { location = typeof loc === 'string' ? loc : (loc.name || null); break; }
                    }

                    const hiring = node.hiringOrganization;
                    const organizer = (hiring && (hiring.name || hiring)) || 'Dish Media Network Ltd.';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    const key = (title + '|' + url).toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push({
                        id: `dishhome-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Dish Media Network Ltd.',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'dishhome',
                    });
                }
            }

            // ---- 2) Real job-detail anchors ----
            const jobHrefRe = /\/(careers?|jobs?|positions?|openings?|vacanc(?:y|ies)|apply)\/[^/?#]+/i;
            const entryNorm = entryUrl.replace(/\/$/, '');
            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer')) continue;
                const raw = a.getAttribute('href') || '';
                if (/^(tel:|mailto:)/i.test(raw)) continue;
                // Skip external off-site links (dishhome.com.np, talentconnects.co, etc.)
                if (/^https?:\/\//i.test(raw) && !raw.startsWith(window.location.origin)) continue;
                const href = abs(raw);
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;
                if (!jobHrefRe.test(href)) continue;

                const title = clean(a.textContent);
                if (!title || title.length < 3 || title.length > 140) continue;
                pushItem(title, href, null);
            }

            // ---- 3) Job cards via the map-pin location marker ----
            // Evidence: cards contain `<span class="flex items-center"><svg
            // map-pin/>City, Nepal</span>`. Use that marker as a card locator,
            // then climb to a container holding a heading and/or apply link.
            const locSpans = Array.from(document.querySelectorAll('span.flex.items-center'))
                .filter((s) => {
                    const txt = (s.textContent || '').trim();
                    return txt.length > 2 && txt.length < 120 && /\b(,|Nepal|Kathmandu|Lalitpur|Pokhara|Nepalgunj|Biratnagar|Birgunj|Bhaktapur)\b/i.test(txt);
                });

            for (const span of locSpans) {
                // Climb up to a card-like ancestor.
                let card = span.parentElement;
                for (let i = 0; i < 5 && card && card !== document.body; i++) {
                    const hasHeading = card.querySelector('h2, h3, h4, [class*="title"]');
                    const hasApply = card.querySelector('a[href], button');
                    if (hasHeading && hasApply) break;
                    card = card.parentElement;
                }
                if (!card || card === document.body) continue;

                const headingEl = card.querySelector('h2, h3, h4, [class*="title"]');
                const title = headingEl ? clean(headingEl.textContent) : null;
                if (!title || title.length < 3 || title.length > 140) continue;
                if (/^(open positions?|current openings?|job listings?|careers?$)/i.test(title)) continue;

                const locText = clean(span.textContent);

                const applyLink = card.querySelector('a[href]');
                let href = null;
                if (applyLink) {
                    const raw = applyLink.getAttribute('href') || '';
                    if (!/^(tel:|mailto:)/i.test(raw)) {
                        if (/^https?:\/\//i.test(raw) && !raw.startsWith(window.location.origin)) {
                            // External apply link - keep it as registrationUrl only, don't
                            // use as the item url (keeps source=scraped page consistent).
                            href = null;
                        } else {
                            href = abs(raw);
                        }
                    }
                }

                const p = card.querySelector('p');
                const description = p ? stripHtml(p.textContent) : null;

                const key = (title + '|' + (href || entryUrl)).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                out.push({
                    id: `dishhome-${now}-${rand()}`,
                    title,
                    description,
                    date: null,
                    time: null,
                    location: locText || null,
                    price: null,
                    organizer: 'Dish Media Network Ltd.',
                    category: null,
                    tags: [],
                    image: null,
                    url: href || entryUrl,
                    registrationUrl: href || entryUrl,
                    attendanceMode: null,
                    source: 'dishhome',
                });
            }

            // ---- 4) Role headings in an Open-Positions-style block ----
            const openingsHeadingRe = /(open positions?|current openings?|open roles?|job listings?|we['']?re hiring|vacanc(?:y|ies)|all jobs)/i;
            const marketingHeadingRe = /^(visit website|talent connects|about us|why dishhome|benefits|perks|life at)/i;

            let openingsBlock = null;
            for (const h of document.querySelectorAll('h1, h2, h3')) {
                if (h.closest('nav, header, footer')) continue;
                if (!openingsHeadingRe.test(h.textContent || '')) continue;
                let container = h.parentElement;
                for (let i = 0; i < 4 && container && container !== document.body; i++) {
                    if (container.querySelectorAll('h3, h4, .job, .job-card, .position, .opening').length > 0) {
                        openingsBlock = container;
                        break;
                    }
                    container = container.parentElement;
                }
                if (openingsBlock) break;
            }

            if (openingsBlock) {
                for (const el of openingsBlock.querySelectorAll('h3, h4, .job-title, .position-title, .opening-title')) {
                    if (el.closest('nav, header, footer')) continue;
                    const title = clean(el.textContent);
                    if (!title || title.length < 3 || title.length > 140) continue;
                    if (marketingHeadingRe.test(title)) continue;
                    if (openingsHeadingRe.test(title)) continue;

                    const card = el.closest('li, article, div') || el.parentElement;
                    const card2 = (card && openingsBlock.contains(card)) ? card : el.parentElement;
                    const applyLink = card2 ? card2.querySelector('a[href]') : null;
                    let href = null;
                    if (applyLink) {
                        const raw = applyLink.getAttribute('href') || '';
                        if (!/^(tel:|mailto:)/i.test(raw) && !(/^https?:\/\//i.test(raw) && !raw.startsWith(window.location.origin))) {
                            href = abs(raw);
                        }
                    }
                    const p = card2 ? card2.querySelector('p') : null;
                    pushItem(title, href, p ? stripHtml(p.textContent) : null);
                }
            }

            return out;
        }, DISHHOME_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.warn('[dishhome] no scrapeable job cards found - returning empty list');
        } else {
            console.log(`? [dishhome] extracted ${items.length} job(s)`);
        }

        return { items, meta };
    },
};