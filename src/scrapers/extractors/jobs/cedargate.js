// src/scrapers/extractors/jobs/cedargate.js
// Site-specific extractor for cedargate.com/careers-2/.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `/platform/data/` (5 matches) points at
//     Cedar Gate's product/platform pages, NOT job detail pages. All
//     detailLinkCandidates are /platform/* routes.
//   - The "card wrapper" `link` (45 instances) is HTML metadata, NOT cards.
//   - cardCandidates are mega-menu items and product accordions - no roles.
//   - No JobPosting JSON-LD, no /careers/<id> anchors. The page IS a
//     careers page (title "Careers | Cedar Gate Technologies"; body opens
//     with "Careers / Join Our Team"), but the actual job listing is likely
//     rendered by an embedded ATS (Greenhouse / Lever / Workday) or is
//     currently empty. We extract defensively: JSON-LD  job-detail anchors
//      headings inside an "Open Positions"-type block  embedded ATS iframe
//     src as a fallback signal (recorded as a single item only if the
//     iframe URL uniquely identifies the board, which we skip to avoid
//     inventing items). Return an empty list if nothing real is found.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const CEDARGATE_CAREERS_URL = 'https://www.cedargate.com/careers-2/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [cedargate] Scraping Cedar Gate careers...');

        meta.pagesVisited++;
        await page.goto(CEDARGATE_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(3000); // WP + possible ATS iframe

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [cedargate] page looks blocked/captcha - bailing out');
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'Cedar Gate Technologies';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `cedargate-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Cedar Gate Technologies',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'cedargate',
                    });
                }
            }

            // ---- 2) Real job-detail anchors ----
            // The site's product routes are /platform/*; those must be
            // excluded. The only links we accept are clearly job-shaped.
            const jobHrefRe = /\/(careers?|jobs?|positions?|openings?|vacanc(?:y|ies)|apply)\/[^/?#]+/i;
            const excludeRe = /\/(platform|solutions|resources|company|our-story|contact|demo|blogs?)(\/|$|\.)/i;
            const entryNorm = entryUrl.replace(/\/$/, '');

            for (const a of document.querySelectorAll('a[href]')) {
                if (a.closest('nav, header, footer, .mega-menu')) continue;
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

                out.push({
                    id: `cedargate-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Cedar Gate Technologies',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'cedargate',
                });
            }

            // ---- 3) Role headings inside an "Open Positions" / "We're Hiring" block ----
            const openingsHeadingRe = /(open positions?|current openings?|open roles?|we['']?re hiring|join our team|job openings?|vacanc(?:y|ies)|explore opportunities)/i;
            const marketingHeadingRe = /^(join our team|life at|benefits|perks|our values|why |about |careers$|contact)/i;

            let openingsBlock = null;
            for (const h of document.querySelectorAll('h1, h2, h3')) {
                if (h.closest('nav, header, footer, .mega-menu')) continue;
                if (!openingsHeadingRe.test(h.textContent || '')) continue;

                // Climb to a container that has other headings (role items).
                let container = h.parentElement;
                for (let i = 0; i < 4 && container && container !== document.body; i++) {
                    if (container.querySelectorAll('h3, h4, .job, .job-item, .opening, .position').length > 0) {
                        openingsBlock = container;
                        break;
                    }
                    container = container.parentElement;
                }
                if (openingsBlock) break;
            }

            if (openingsBlock) {
                const roleEls = openingsBlock.querySelectorAll(
                    'h3, h4, .job-title, .job-title a, .opening-title, .position-title, .card-title'
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
                        'a[href^="mailto:"], a[href*="apply"], a[href*="careers"], a[href*="job"]'
                    ) : null;
                    const applyHref = applyLink ? abs(applyLink.getAttribute('href')) : null;

                    const imgEl = card2 ? card2.querySelector('img') : null;
                    const image = imgEl ? window.__resolveImageSrc(imgEl) : null;

                    out.push({
                        id: `cedargate-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'Cedar Gate Technologies',
                        category: null,
                        tags: [],
                        image,
                        url: entryUrl,
                        registrationUrl: applyHref,
                        attendanceMode: null,
                        source: 'cedargate',
                    });
                }
            }

            return out;
        }, CEDARGATE_CAREERS_URL);

        // ---- Fallback: log if an ATS board is embedded ----
        // Many career pages delegate to Greenhouse/Lever/Workday. If we found
        // no items and an ATS iframe exists, note it - a separate extractor
        // for that board would be needed.
        if (items.length === 0) {
            try {
                const atsSrc = await page.evaluate(() => {
                    const iframe = Array.from(document.querySelectorAll('iframe[src]'))
                        .find((f) => /(greenhouse\.io|lever\.co|myworkdayjobs\.com|jobs\.|careers\.|icims|smartrecruiters)/i.test(f.src));
                    return iframe ? iframe.src : null;
                });
                if (atsSrc) {
                    console.warn(`[cedargate] no inline roles; embedded ATS iframe detected: ${atsSrc}`);
                } else {
                    console.warn('[cedargate] no scrapeable open roles found - returning empty list');
                }
            } catch (e) {
                console.warn('[cedargate] no scrapeable open roles found - returning empty list');
            }
        }

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length > 0) {
            console.log(`? [cedargate] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};