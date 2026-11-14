// src/scrapers/extractors/jobs/cloco.js
// Site-specific extractor for cloco.com.np/careers.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `/` (5 matches) is nav/logo links, NOT job
//     detail links. detailLinkCandidates is empty.
//   - The "card wrapper" `image` (180 instances) is inline SVG/Lottie
//     artwork, NOT job cards.
//   - The page IS the careers page (title "Careers"; body opens with
//     "Careers / Shape the Future with Cloco"; nav shows active "Vacancy"
//     pointing at /careers). The actual vacancy cards were not captured in
//     the dump - the site is a Vue SPA and likely renders roles client-side.
//   - We therefore extract defensively: JSON-LD JobPosting  job-shaped
//     detail anchors  role headings inside a "Vacancy"/"Open Positions"
//     block. If roles have real detail links, we navigate them. If not, we
//     keep listing-only items. Return an empty list if nothing real exists.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const CLOCO_CAREERS_URL = 'https://cloco.com.np/careers';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [cloco] Scraping Cloco careers...');

        meta.pagesVisited++;
        await page.goto(CLOCO_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2500); // Vue hydration

        // Nudge lazy/SPA content: scroll down and back.
        try {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(1200);
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(600);
        } catch (e) { /* best-effort */ }

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [cloco] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        const discovered = await page.evaluate((entryUrl) => {
            const out = [];
            const detailLinks = [];
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

            // ---- 1) JSON-LD JobPosting (if present) ----
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
                    const key = (title + '|' + url).toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    let location = null;
                    const jl = node.jobLocation;
                    const arr = Array.isArray(jl) ? jl : (jl ? [jl] : []);
                    for (const l of arr) {
                        const addr = l && l.address;
                        const loc = addr && (addr.addressLocality || addr.addressRegion || addr.addressCountry);
                        if (loc) { location = typeof loc === 'string' ? loc : (loc.name || null); break; }
                    }

                    const hiring = node.hiringOrganization;
                    const organizer = (hiring && (hiring.name || hiring)) || 'Cloco';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `cloco-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Cloco',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'cloco',
                    });
                }
            }

            // ---- 2) Real job-detail anchors ----
            const jobHrefRe = /\/(careers?|jobs?|vacanc(?:y|ies)|positions?|openings?|apply)\/[^/?#]+/i;
            const excludeRe = /\/(services?|solutions?|about|blog|gallery|contact|internship|fellowship)(\/|$|\.)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');

            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer')) continue;
                const raw = a.getAttribute('href') || '';
                if (/^(tel:|mailto:)/i.test(raw)) continue;
                const href = abs(raw);
                if (!href) continue;
                if (href.replace(/\/$/, '') === entryNorm) continue;
                if (!jobHrefRe.test(href)) continue;
                if (excludeRe.test(href)) continue;

                const title = clean(a.textContent);
                if (!title || title.length < 3 || title.length > 140) continue;

                const key = (title + '|' + href).toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);

                detailLinks.push(href);

                // Also keep a listing-only fallback item in case detail
                // navigation fails; dedupe by URL later.
                out.push({
                    id: `cloco-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Cloco',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'cloco',
                });
            }

            // ---- 3) Role headings inside a Vacancy/Openings block ----
            const openingsHeadingRe = /(vacanc(?:y|ies)|open positions?|current openings?|open roles?|we['']?re hiring|job openings?|join our team)/i;
            const marketingHeadingRe = /^(global talent|growth|life at|benefits|perks|our values|why |about |careers$|contact)/i;

            let openingsBlock = null;
            for (const h of document.querySelectorAll('h1, h2, h3')) {
                if (h.closest('nav, header, footer')) continue;
                if (!openingsHeadingRe.test(h.textContent || '')) continue;

                let container = h.parentElement;
                for (let i = 0; i < 4 && container && container !== document.body; i++) {
                    if (container.querySelectorAll('h3, h4, .job, .job-item, .vacancy, .opening, .position').length > 0) {
                        openingsBlock = container;
                        break;
                    }
                    container = container.parentElement;
                }
                if (openingsBlock) break;
            }

            if (openingsBlock) {
                const roleEls = openingsBlock.querySelectorAll(
                    'h3, h4, .job-title, .vacancy-title, .opening-title, .position-title, .card-title'
                );
                for (const el of roleEls) {
                    if (el.closest('nav, header, footer')) continue;
                    const title = clean(el.textContent);
                    if (!title || title.length < 3 || title.length > 140) continue;
                    if (marketingHeadingRe.test(title)) continue;
                    if (openingsHeadingRe.test(title)) continue;

                    const key = (title + '|' + entryUrl).toLowerCase();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const card = el.closest('li, article, div') || el.parentElement;
                    const card2 = (card && openingsBlock.contains(card)) ? card : el.parentElement;

                    const p = card2 ? card2.querySelector('p') : null;
                    const description = p ? stripHtml(p.textContent) : null;

                    const applyLink = card2 ? card2.querySelector(
                        'a[href^="mailto:"], a[href*="apply"], a[href*="careers"], a[href*="job"], a[href*="vacancy"]'
                    ) : null;
                    const applyHref = applyLink ? abs(applyLink.getAttribute('href')) : null;

                    const imgEl = card2 ? card2.querySelector('img') : null;
                    const image = imgEl ? window.__resolveImageSrc(imgEl) : null;

                    out.push({
                        id: `cloco-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'Cloco',
                        category: null,
                        tags: [],
                        image,
                        url: applyHref || entryUrl,
                        registrationUrl: applyHref,
                        attendanceMode: null,
                        source: 'cloco',
                    });
                }
            }

            // Deduplicate by url+title, keep first.
            const deduped = [];
            const seen2 = new Set();
            for (const it of out) {
                const k = ((it.title || '') + '|' + (it.url || '')).toLowerCase();
                if (seen2.has(k)) continue;
                seen2.add(k);
                deduped.push(it);
            }

            return { items: deduped, detailLinks, listingHits: deduped.length + detailLinks.length };
        }, CLOCO_CAREERS_URL);

        meta.listingHits = discovered.listingHits || 0;
        safeDiscovered(progress, (discovered.items || []).length);

        const items = (discovered.items || []).slice();

        // Advance unit for listing-only items (those not visited as details).
        const detailSet = new Set(discovered.detailLinks || []);
        for (const it of items) {
            if (!detailSet.has(it.url)) safeUnitDone(progress);
        }

        // ---- Stage 2: enrich via detail pages if real job links exist ----
        for (const link of discovered.detailLinks || []) {
            try {
                meta.pagesVisited++;
                meta.detailPagesVisited++;
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 30000 });
                await delay(800);

                const detail = await page.evaluate(() => {
                    const clean = (s) => (s ? String(s).replace(/\s+/g, ' ').trim() : null);
                    const stripHtml = (s) => (s
                        ? String(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
                        : null);

                    const titleEl = document.querySelector('h1, h2, [class*="title"]');
                    const title = titleEl ? clean(titleEl.textContent) : null;

                    let description = null;
                    let bestLen = 0;
                    for (const d of document.querySelectorAll('div, section, article, main')) {
                        if (d.closest('nav, header, footer')) continue;
                        if (d.children.length > 30) continue;
                        const txt = d.textContent || '';
                        if (txt.length <= bestLen) continue;
                        if (txt.length < 200 || txt.length > 20000) continue;
                        if (!/responsibilit|requirement|qualification|experience|skills?/i.test(txt)) continue;
                        description = stripHtml(txt);
                        bestLen = txt.length;
                    }

                    const bodyText = document.body.textContent || '';
                    const modeM = bodyText.match(/\b(Remote|Hybrid|On-?site|Onsite)\b/i);
                    const mode = modeM ? modeM[1] : null;

                    return { title, description, mode, finalUrl: window.location.href };
                });

                if (!detail.title) {
                    meta.detailParseFailures++;
                    console.warn(`?? [cloco] detail title extraction failed for ${link}`);
                    continue;
                }

                // Replace the placeholder listing item with the enriched one.
                const idx = items.findIndex((it) => it.url === link);
                const attendanceMode = (() => {
                    const m = (detail.mode || '').toLowerCase();
                    if (m.includes('remote') || m.includes('online')) return 'online';
                    if (m.includes('hybrid')) return 'hybrid';
                    return 'in-person';
                })();

                const enriched = {
                    id: idx >= 0 ? items[idx].id : `cloco-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                    title: detail.title,
                    description: detail.description || (idx >= 0 ? items[idx].description : null),
                    date: idx >= 0 ? items[idx].date : null,
                    time: null,
                    location: idx >= 0 ? items[idx].location : null,
                    price: null,
                    organizer: 'Cloco',
                    category: idx >= 0 ? items[idx].category : null,
                    tags: idx >= 0 ? items[idx].tags : [],
                    image: idx >= 0 ? items[idx].image : null,
                    url: detail.finalUrl || link,
                    registrationUrl: detail.finalUrl || link,
                    attendanceMode,
                    source: 'cloco',
                };

                if (idx >= 0) items[idx] = enriched;
                else items.push(enriched);

                console.log(`    ? [cloco] Scraped detail: ${detail.title}`);
            } catch (error) {
                if (error.message && error.message.includes('403')) {
                    console.warn(`?? [cloco] 403 on ${link} - skipping.`);
                } else {
                    console.error(`    ? [cloco] Error on ${link}:`, error.message);
                }
            } finally {
                safeUnitDone(progress);
            }
        }

        if (items.length === 0) {
            console.warn('[cloco] no scrapeable vacancies found - returning empty list');
        } else {
            console.log(`? [cloco] extracted ${items.length} item(s)`);
        }

        return { items, meta };
    },
};