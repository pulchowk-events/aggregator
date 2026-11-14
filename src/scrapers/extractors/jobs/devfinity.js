// src/scrapers/extractors/jobs/devfinity.js
// Site-specific extractor for devfinity.com/careers/.
// See ../README.md for the contract.
//
// CORRECTED ASSUMPTIONS FROM THE EVIDENCE DUMP:
//   - The "detail-link pattern" `/get-in-touch/` (6 matches) is a "Let's
//     talk" CTA, NOT a job detail link. detailLinkCandidates are all
//     /solution/* or /industry/* - product pages, not roles.
//   - The "card wrapper" `meta` (21 instances) is HTML metadata, NOT cards.
//   - cardCandidates are culture/perks blocks ("Learning & growth",
//     "Meaningful work") and mega-menu link groups - no roles.
//   - No JobPosting JSON-LD exists (only WebPage / ImageObject /
//     BreadcrumbList / WebSite / Organization).
//   - The page IS the careers page (title "Careers"; entry URL /careers/),
//     but the actual role list either is not rendered yet, is empty, or is
//     handled off-site. So extract defensively: JSON-LD  job-shaped
//     anchors  headings inside an "Open Positions"/"Current Openings"-
//     style block. Return [] gracefully when nothing real exists.

const { delay } = require('../../page');
const { safeDiscovered, safeUnitDone } = require('../../progress');
const { detectPageState } = require('../../diagnostics');

const DEVFINITY_CAREERS_URL = 'https://devfinity.com/careers/';

module.exports = {
    async extract(page, { progress, meta }) {
        console.log('??? [devfinity] Scraping Devfinity careers...');

        meta.pagesVisited++;
        await page.goto(DEVFINITY_CAREERS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForSelector('body', { timeout: 15000 });
        await delay(2500); // WP + possible JS-rendered job list

        const state = await detectPageState(page);
        if (state.looksBlocked) {
            console.warn('?? [devfinity] page looks blocked/captcha - bailing out');
            meta.looksBlocked = true;
            meta.listingHits = 0;
            return { items: [], meta };
        }

        // Nudge lazy content: scroll down and back up.
        try {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(1000);
            await page.evaluate(() => window.scrollTo(0, 0));
            await delay(500);
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
                    const organizer = (hiring && (hiring.name || hiring)) || 'Devfinity';
                    const locType = (node.jobLocationType || '').toLowerCase();
                    const attendanceMode = locType.includes('telecommute')
                        ? 'online'
                        : locType.includes('hybrid') ? 'hybrid' : 'in-person';

                    out.push({
                        id: `devfinity-${now}-${rand()}`,
                        title,
                        description: stripHtml(node.description),
                        date: node.datePosted || null,
                        time: null,
                        location,
                        price: null,
                        organizer: typeof organizer === 'string' ? organizer : 'Devfinity',
                        category: node.occupationalCategory || node.employmentType || null,
                        tags: [],
                        image: null,
                        url: url || entryUrl,
                        registrationUrl: url || entryUrl,
                        attendanceMode,
                        source: 'devfinity',
                    });
                }
            }

            // ---- 2) Job-shaped detail anchors ----
            // Exclude /solution, /industry, /capabilities, /get-in-touch,
            // /about - those are site routes, not job detail links.
            const jobHrefRe = /\/(careers?|jobs?|positions?|openings?|vacanc(?:y|ies)|apply)\/[^/?#]+/i;
            const excludeRe = /\/(solutions?|industr(?:y|ies)|capabilities|get-in-touch|about|contact|blog|news|case-studies)(\/|$|#|\.)/i;
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

                out.push({
                    id: `devfinity-${now}-${rand()}`,
                    title,
                    description: null,
                    date: null,
                    time: null,
                    location: null,
                    price: null,
                    organizer: 'Devfinity',
                    category: null,
                    tags: [],
                    image: null,
                    url: href,
                    registrationUrl: href,
                    attendanceMode: null,
                    source: 'devfinity',
                });
            }

            // ---- 3) Role headings inside an Open-Positions-style block ----
            const openingsHeadingRe = /(open positions?|current openings?|open roles?|we['']?re hiring|job openings?|vacanc(?:y|ies)|join our team|life at devfinity|work with us)/i;
            const marketingHeadingRe = /^(learning|meaningful|benefits|perks|why |about |culture|it all adds|solutions for|more than|ready to)/i;

            let openingsBlock = null;
            for (const h of document.querySelectorAll('h1, h2, h3')) {
                if (h.closest('nav, header, footer')) continue;
                if (!openingsHeadingRe.test(h.textContent || '')) continue;

                let container = h.parentElement;
                for (let i = 0; i < 4 && container && container !== document.body; i++) {
                    if (container.querySelectorAll('h3, h4, .job, .job-card, .position, .opening, .career-card').length > 0) {
                        openingsBlock = container;
                        break;
                    }
                    container = container.parentElement;
                }
                if (openingsBlock) break;
            }

            if (openingsBlock) {
                const roleEls = openingsBlock.querySelectorAll(
                    'h3, h4, .job-title, .position-title, .opening-title, .career-title, .card-title'
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
                        id: `devfinity-${now}-${rand()}`,
                        title,
                        description,
                        date: null,
                        time: null,
                        location: null,
                        price: null,
                        organizer: 'Devfinity',
                        category: null,
                        tags: [],
                        image,
                        url: applyHref || entryUrl,
                        registrationUrl: applyHref,
                        attendanceMode: null,
                        source: 'devfinity',
                    });
                }
            }

            return out;
        }, DEVFINITY_CAREERS_URL);

        safeDiscovered(progress, items.length);
        safeUnitDone(progress, items.length);
        meta.listingHits = items.length;

        if (items.length === 0) {
            console.log('[devfinity] no open positions found - returning empty list');
        } else {
            console.log(`? [devfinity] extracted ${items.length} role(s)`);
        }

        return { items, meta };
    },
};